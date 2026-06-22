/**
 * /api/fifa/details — Fast FIFA match details endpoint
 * Uses streamed.pk official API to find the next football match,
 * and FotMob for live scores. No scraping, no Puppeteer, no worldcup26.ir.
 * Designed to complete well within Vercel's 10s function limit.
 */

const axios = require('axios');
const admin = require('firebase-admin');

// Firebase init
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    } else {
      const fs = require('fs');
      const path = require('path');
      const possiblePaths = [
        path.resolve(__dirname, '../../serviceAccountKey.json'),
        path.resolve(__dirname, '../../f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json'),
      ];
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          admin.initializeApp({ credential: admin.credential.cert(require(p)) });
          break;
        }
      }
    }
  } catch (e) { console.error('[fifa/details] Firebase init error:', e.message); }
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function formatIst(ms) {
  if (!ms || !isFinite(ms)) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

const STREAMED_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://streamed.pk/',
};

const FOTMOB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  'Accept': '*/*',
  'Referer': 'https://www.fotmob.com/',
};

function normName(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function inferVenueFromTitle(title) {
  // streamed.pk match titles don't include venue — return generic for now
  return { stadium: 'FIFA World Cup 2026 Venue', city: '', country: 'United States' };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const saveToFirestore = req.query.save === 'true';
  console.log('[fifa/details] Starting fetch...');

  try {
    const now = Date.now();

    // Step 1: Fetch football matches from streamed.pk + today's schedule in parallel
    const [footballRes, liveRes, fotmobRes] = await Promise.allSettled([
      axios.get('https://streamed.pk/api/matches/football', { timeout: 4000, headers: STREAMED_HEADERS })
        .then(r => Array.isArray(r.data) ? r.data : []),
      axios.get('https://streamed.pk/api/matches/live', { timeout: 4000, headers: STREAMED_HEADERS })
        .then(r => Array.isArray(r.data) ? r.data : []),
      // FotMob for live scores (World Cup pl=77)
      (async () => {
        const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
        const { data: xml } = await axios.get(`https://api.fotmob.com/matches?date=${today}`, { timeout: 4000, headers: FOTMOB_HEADERS, responseType: 'text' });
        // Parse WC blocks
        const wcBlocks = xml.match(/<league[^>]*pl="77"[^>]*>[\s\S]*?<\/league>/g) || [];
        const liveMap = {};
        for (const block of wcBlocks) {
          const matches = block.match(/<match[^>]*\/>/g) || [];
          for (const m of matches) {
            const get = k => (m.match(new RegExp(k + '="([^"]+)"')) || [])[1] || '';
            const hTeam = get('hTeam'); const aTeam = get('aTeam');
            const hScore = get('hScore'); const aScore = get('aScore');
            const status = get('Status'); const minute = get('minute');
            const date = get('date'); // yyyymmdd
            const time = get('time'); // HHMM in UTC

            let mappedStatus = 'notstarted';
            if (status === 'F' || status === 'FT') mappedStatus = 'finished';
            else if (status === 'L' || status === 'HT') mappedStatus = 'live';

            let matchTime = '';
            if (mappedStatus === 'finished') matchTime = 'FT';
            else if (status === 'HT') matchTime = 'HT';
            else if (minute && /^\d+$/.test(minute)) matchTime = minute + "'";

            // Parse UTC kickoff from date+time
            let kickoffUtcMs = null;
            if (date && date.length === 8 && time && time.length >= 3) {
              const yr = parseInt(date.slice(0,4)); const mo = parseInt(date.slice(4,6))-1; const dy = parseInt(date.slice(6,8));
              const hr = parseInt(time.slice(0,2)); const mn = parseInt(time.slice(2,4)||'0');
              kickoffUtcMs = Date.UTC(yr, mo, dy, hr, mn);
            }

            const entry = { homeScore: hScore||'0', awayScore: aScore||'0', status: mappedStatus, matchTime, kickoffUtcMs };
            const key = normName(hTeam)+'|'+normName(aTeam);
            liveMap[key] = entry;
            liveMap[normName(aTeam)+'|'+normName(hTeam)] = {...entry, homeScore:aScore||'0', awayScore:hScore||'0'};
          }
        }
        return liveMap;
      })()
    ]);

    const footballMatches = footballRes.status === 'fulfilled' ? footballRes.value : [];
    const liveMatches = liveRes.status === 'fulfilled' ? liveRes.value : [];
    const fotmobMap = fotmobRes.status === 'fulfilled' ? fotmobRes.value : {};

    console.log(`[fifa/details] Got ${footballMatches.length} football, ${liveMatches.length} live, ${Object.keys(fotmobMap).length/2} fotmob entries`);

    // Merge and deduplicate
    const seen = new Set();
    const allFootball = [];
    for (const m of [...footballMatches, ...liveMatches]) {
      if (m.category === 'football' && !seen.has(m.id)) {
        seen.add(m.id);
        allFootball.push(m);
      }
    }

    if (allFootball.length === 0) {
      return res.json({ ok: false, error: 'No football matches from streamed.pk', raceData: null });
    }

    // Step 2: Find best match from fotmob — live first, then upcoming by kickoff
    // FotMob data has kickoffUtcMs; streamed.pk has .date (unix ms)
    let chosenStreamed = null;
    let chosenFotmob = null;

    // Try to find a currently live match from fotmob data
    const fotmobEntries = Object.entries(fotmobMap).filter(([k]) => !k.includes('|') === false);
    const liveEntry = Object.entries(fotmobMap).find(([k, v]) => v.status === 'live' && k.includes('|'));
    
    if (liveEntry) {
      const [liveKey, liveFm] = liveEntry;
      const [homeKey, awayKey] = liveKey.split('|');
      // Find matching streamed entry
      chosenStreamed = allFootball.find(m => {
        const t = (m.title || '').toLowerCase();
        return normName(t).includes(homeKey) && normName(t).includes(awayKey);
      });
      chosenFotmob = liveFm;
      console.log(`[fifa/details] Found live match from FotMob: key=${liveKey}`);
    }

    // If no live match, pick the next upcoming from streamed.pk by .date (unix ms)
    if (!chosenStreamed) {
      const upcoming = allFootball
        .filter(m => m.date && m.date > (now - 3 * 60 * 60 * 1000)) // not ended >3h ago
        .sort((a, b) => a.date - b.date);
      
      // Try to find next future match
      const future = upcoming.filter(m => m.date > now);
      chosenStreamed = future[0] || upcoming[0] || allFootball[0];

      if (chosenStreamed) {
        // Try to find fotmob data for it
        const title = normName(chosenStreamed.title || '');
        const parts = (chosenStreamed.title || '').toLowerCase().split(' vs ');
        if (parts.length >= 2) {
          const hk = normName(parts[0]); const ak = normName(parts[1]);
          chosenFotmob = fotmobMap[hk + '|' + ak] || fotmobMap[ak + '|' + hk] || null;
        }
      }
    }

    if (!chosenStreamed) {
      return res.json({ ok: false, error: 'No upcoming football match found', raceData: null });
    }

    console.log(`[fifa/details] Chosen: "${chosenStreamed.title}" | date=${chosenStreamed.date} | fotmob=${chosenFotmob ? chosenFotmob.status : 'none'}`);

    // Step 3: Build raceData
    const title = chosenStreamed.title || 'TBD vs TBD';
    const kickoffMs = chosenStreamed.date || now;
    const isLive = chosenFotmob ? chosenFotmob.status === 'live' : (kickoffMs <= now && (now - kickoffMs) < 3.5 * 60 * 60 * 1000);
    const isFinished = chosenFotmob ? chosenFotmob.status === 'finished' : false;
    const homeScore = chosenFotmob ? chosenFotmob.homeScore : '0';
    const awayScore = chosenFotmob ? chosenFotmob.awayScore : '0';
    const matchTime = chosenFotmob ? chosenFotmob.matchTime : (isLive ? `${Math.floor((now - kickoffMs) / 60000)}'` : '');

    // Try to get venue from teams data
    const homeTeam = chosenStreamed.teams && chosenStreamed.teams.home ? chosenStreamed.teams.home.name : null;
    const awayTeam = chosenStreamed.teams && chosenStreamed.teams.away ? chosenStreamed.teams.away.name : null;
    const venue = inferVenueFromTitle(title);

    const raceData = {
      name: title,
      round: 'FIFA World Cup 2026',
      circuit: venue.stadium,
      location: venue.city ? `${venue.city}, ${venue.country}` : venue.country,
      date: formatIst(kickoffMs),
      homeScore,
      awayScore,
      isLive,
      isFinished,
      matchTime,
      laps: '',
      theme: '',
    };

    const customTimer = {
      enabled: true,
      target: new Date(kickoffMs).toISOString(),
      label: isLive ? 'LIVE NOW' : 'MATCH KICKS OFF',
      isManual: false,
    };

    // Step 4: Save to Firestore if requested
    if (saveToFirestore && admin.apps.length) {
      try {
        const db = admin.firestore();
        const ref = db.collection('app_data').doc('live_config');
        const doc = await ref.get();
        if (doc.exists) {
          const currentFifa = (doc.data().fifa) || {};
          // Preserve manual customTimer if set
          const timerToSave = (currentFifa.customTimer && currentFifa.customTimer.isManual)
            ? currentFifa.customTimer
            : customTimer;
          await ref.update({
            fifa: {
              ...currentFifa,
              raceData,
              customTimer: timerToSave,
              lastDetailsSync: new Date().toISOString(),
            }
          });
          console.log(`[fifa/details] Saved to Firestore: ${title}`);
        }
      } catch (e) {
        console.error('[fifa/details] Firestore save error:', e.message);
      }
    }

    return res.json({ ok: true, raceData, customTimer, matchTitle: title });

  } catch (err) {
    console.error('[fifa/details] Fatal error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
