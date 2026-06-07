/**
 * /api/sync-standings — Vercel Serverless Function
 * Called by cron-job.org every 30 seconds.
 * Tries f1.com API first, falls back to Jolpica (official FIA data).
 */

const axios = require('axios');
const admin = require('firebase-admin');
const cheerio = require('cheerio');

if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      } else {
        const fs = require('fs');
        const path = require('path');
        let keyPath = null;
        
        const possiblePaths = [
          path.resolve(__dirname, '../serviceAccountKey.json'),
          path.resolve(__dirname, '../../serviceAccountKey.json'),
          path.resolve(__dirname, '../f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json'),
          path.resolve(__dirname, '../../f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json'),
          path.resolve(__dirname, '../f1watchparty-web-main/f1watchparty-web-main/f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json'),
          path.resolve(__dirname, '../../f1watchparty-web-main/f1watchparty-web-main/f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json'),
          path.resolve(process.cwd(), './serviceAccountKey.json'),
          path.resolve(process.cwd(), './f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json'),
          path.resolve(process.cwd(), './f1watchparty-web-main/f1watchparty-web-main/f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json')
        ];
        
        for (const p of possiblePaths) {
          if (fs.existsSync(p)) {
            keyPath = p;
            break;
          }
        }
        
        if (keyPath) {
          const sa = require(keyPath);
          admin.initializeApp({ credential: admin.credential.cert(sa) });
          console.log('[sync] Firebase initialized using local file:', keyPath);
        } else {
          console.warn('[sync] No Firebase credentials found.');
        }
      }
  } catch(e) { console.error('[sync] Firebase init error:', e.message); }
}

const TEAM_ALIASES = {
  'Mercedes':         ['mercedes', 'amg'],
  'Ferrari':          ['ferrari', 'scuderia'],
  'McLaren':          ['mclaren'],
  'Red Bull':         ['red bull', 'redbull', 'oracle'],
  'Red Bull Racing':  ['red bull', 'redbull', 'oracle'],
  'Aston Martin':     ['aston martin', 'aston'],
  'Alpine F1 Team':   ['alpine'],
  'Alpine':           ['alpine'],
  'Williams':         ['williams'],
  'RB F1 Team':       ['racing bulls', 'rb f1', 'rb ', 'vcarb', 'alphatauri'],
  'Racing Bulls':     ['racing bulls', 'rb f1', 'rb ', 'vcarb'],
  'Audi':             ['audi', 'sauber', 'kick'],
  'Haas F1 Team':     ['haas'],
  'Cadillac F1 Team': ['cadillac', 'andretti'],
  'Cadillac':         ['cadillac', 'andretti']
};

function formatDriverNameFromHref(href) {
  if (!href) return '';
  const parts = href.split('/');
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return '';
  return lastPart
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function fetchStandings() {
  const year = new Date().getFullYear();
  
  // Try scraping formula1.com results pages directly (highly reliable server-rendered HTML)
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    const [driverRes, teamRes] = await Promise.all([
      axios.get(`https://www.formula1.com/en/results.html/${year}/drivers.html`, { headers, timeout: 10000 }),
      axios.get(`https://www.formula1.com/en/results.html/${year}/team.html`, { headers, timeout: 10000 })
    ]);

    const $d = cheerio.load(driverRes.data);
    const dl = [];
    $d('table tbody tr').each((i, row) => {
      const cells = $d(row).find('td');
      if (cells.length >= 5) {
        const driverLinkEl = $d(cells[1]).find('a');
        const href = driverLinkEl.attr('href') || '';
        const name = formatDriverNameFromHref(href);
        const image = driverLinkEl.find('img').attr('src') || '';
        // Convert thumbnail to higher resolution square format
        const highResImage = image.replace('/c_lfill,w_64/', '/c_fill,w_80,h_80,g_north/');
        const team = $d(cells[3]).text().trim();
        const points = parseInt($d(cells[4]).text().trim() || 0);
        
        dl.push({
          Driver: {
            familyName: name.split(' ').pop() || '',
            givenName: name.split(' ')[0] || '',
            fullName: name
          },
          Constructor: {
            name: team
          },
          points: points,
          image: highResImage || image
        });
      }
    });

    const $t = cheerio.load(teamRes.data);
    const cl = [];
    $t('table tbody tr').each((i, row) => {
      const cells = $t(row).find('td');
      if (cells.length >= 3) {
        const teamName = $t(cells[1]).text().trim();
        const points = parseInt($t(cells[2]).text().trim() || 0);
        cl.push({
          Constructor: {
            name: teamName
          },
          points: points
        });
      }
    });

    if (dl.length > 0) {
      console.log('[sync] Using formula1.com HTML parsing');
      return { dl, cl, source: 'formula1.com' };
    }
  } catch (err) {
    console.warn('[sync] formula1.com scrape failed:', err.message, '— falling back to Jolpica JSON');
  }

  // Fallback: Jolpica (official FIA data mirror)
  try {
    const [d, c] = await Promise.all([
      axios.get(`https://api.jolpi.ca/ergast/f1/${year}/driverStandings.json`, { timeout: 10000 }),
      axios.get(`https://api.jolpi.ca/ergast/f1/${year}/constructorStandings.json`, { timeout: 10000 })
    ]);
    return {
      dl: d.data?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [],
      cl: c.data?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings || [],
      source: 'jolpica'
    };
  } catch(e) {
    console.error('[sync] Jolpica fallback failed:', e.message);
  }

  return { dl: [], cl: [], source: 'none' };
}

async function syncStreamsAutomatically(config, ref) {
  if (!config.autoSyncStreams) return;

  try {
    let rawLocation = config.raceData?.location || "";
    if (!rawLocation && config.raceData?.name) {
      rawLocation = config.raceData.name;
    }
    
    let location = "";
    if (rawLocation) {
      let parts = rawLocation.split(',');
      let lastPart = parts[parts.length - 1].trim();
      location = lastPart.replace(/[0-9]/g, '').trim();
    }

    if (!location) return;

    let sessionAbbr = "FP1"; // Fallback
    if (config.schedule && config.schedule.length > 0) {
      const now = Date.now();
      let closestFutureTime = Infinity;
      let activeSess = null;

      config.schedule.forEach(s => {
        if (!s.timer) return;
        const start = new Date(s.timer).getTime();
        if (isNaN(start)) return;
        
        let end = start + (2 * 60 * 60 * 1000); 
        if (s.endTime && s.endTime.includes(':')) {
          const parts = s.endTime.split(':');
          const d = new Date(s.timer);
          d.setHours(parseInt(parts[0]), parseInt(parts[1]), 0);
          end = d.getTime();
          if (end < start) end += 86400000;
        }

        if (now >= start && now < end) {
          activeSess = s;
        } else if (now < start && start < closestFutureTime) {
          closestFutureTime = start;
          if (!activeSess) activeSess = s;
        }
      });

      if (!activeSess && config.schedule.length > 0) {
         activeSess = config.schedule[0];
      }

      if (activeSess && activeSess.name) {
        let nameLower = activeSess.name.toLowerCase();
        if (nameLower.includes("practice 1") || nameLower.includes("fp1")) {
          sessionAbbr = "FP1";
        } else if (nameLower.includes("practice 2") || nameLower.includes("fp2")) {
          sessionAbbr = "FP2";
        } else if (nameLower.includes("practice 3") || nameLower.includes("fp3")) {
          sessionAbbr = "FP3";
        } else if (nameLower.includes("qualifying") || nameLower.includes("qualy") || nameLower.includes("qual")) {
          sessionAbbr = "Qualifying";
        } else if (nameLower.includes("sprint")) {
          sessionAbbr = "Sprint";
        } else if (nameLower.includes("race") || nameLower.includes("grand prix")) {
          sessionAbbr = "Race";
        }
      }
    }

    let searchTokens = ["f1", location.toLowerCase(), sessionAbbr.toLowerCase()];

    const { data } = await axios.get('https://api.pushembdz.store/v1/streams', { 
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (data && data.categories) {
      let allStreams = [];
      data.categories.forEach(cat => {
        if (cat.streams) allStreams = allStreams.concat(cat.streams);
      });

      let matched = allStreams.filter(s => {
        if (!s.title) return false;
        let titleLower = s.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
        return searchTokens.every(token => titleLower.includes(token));
      });

      // Fallback matching: if no strict match, try matching just the core tokens
      if (matched.length === 0) {
        let coreTokens = searchTokens.filter(token => {
          const t = token.toLowerCase();
          return !['fp1', 'fp2', 'fp3', 'practice', 'qualifying', 'qualy', 'qual', 'sprint', 'race'].includes(t);
        });

        if (coreTokens.length > 0) {
          matched = allStreams.filter(s => {
            if (!s.title) return false;
            let titleLower = s.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
            return coreTokens.every(token => titleLower.includes(token));
          });
        }
      }

      if (matched.length > 0) {
        let newLinks = matched.map((s, index) => {
          let parts = s.title.split(' - ');
          let name = s.title;
          if (parts.length > 1) {
            let lastPart = parts[parts.length - 1].trim();
            if (lastPart.length <= 10) {
              name = parts[0].trim() + " - " + lastPart;
            }
          }
          let url = s.link || "";
          if (url.includes("api.pushembdz.store")) {
            url = url.replace("api.pushembdz.store", "pushembdz.store");
          }
          return {
            name: name,
            id: "src_" + (Date.now() + index),
            url: url
          };
        });

        await ref.update({ streamLinks: newLinks });
        console.log(`[sync] Automatically updated ${newLinks.length} stream links in Firestore.`);
      }
    }
  } catch (err) {
    console.error('[sync] Stream auto-fetch error:', err.message);
  }
}

module.exports = async (req, res) => {
  if (!['GET','POST'].includes(req.method)) return res.status(405).end();

  try {
    const db = admin.firestore();
    const { dl, cl, source } = await fetchStandings();

    if (!dl?.length) return res.json({ ok: false, message: 'No data' });

    const ref = db.collection('app_data').doc('live_config');
    const doc = await ref.get();
    if (!doc.exists) return res.json({ ok: false, message: 'live_config not found' });

    const config = doc.data();

    // Check if auto-sync is disabled.
    // Allow manual triggers (?manual=true) to bypass this check.
    if (config.autoSyncStandings === false && req.query.manual !== 'true') {
      console.log('[sync] Standings auto-sync is disabled. Skipping.');
      return res.json({ ok: true, message: 'Auto-sync disabled' });
    }

    const standings = config.standings || [];
    const constructors = config.constructors || [];
    let changed = false;
    // Filter out dummy/placeholder driver entries if any
    for (let i = standings.length - 1; i >= 0; i--) {
      if (standings[i].name === 'Driver' && standings[i].team === 'Team') {
        standings.splice(i, 1);
        changed = true;
      }
    }

    dl.forEach(entry => {
      const fullName = entry.Driver?.fullName || (entry.Driver?.givenName + ' ' + entry.Driver?.familyName);
      const lastName = (entry.Driver?.familyName || '').toLowerCase();
      const pts = parseInt(entry.points || 0);
      const match = standings.find(d => d.name && d.name.toLowerCase().includes(lastName));
      if (match) {
        if (match.points !== pts) {
          match.points = pts;
          changed = true;
        }
        if (entry.image && match.image !== entry.image) {
          match.image = entry.image;
          changed = true;
        }
      } else {
        standings.push({
          name: fullName,
          team: entry.Constructor?.name || '',
          points: pts,
          image: entry.image || ''
        });
        changed = true;
      }
    });
    standings.sort((a, b) => (b.points||0) - (a.points||0));

    if (cl?.length) {
      cl.forEach(entry => {
        const name = entry.Constructor?.name || '';
        const pts = parseInt(entry.points || 0);
        const aliases = TEAM_ALIASES[name] || [name.toLowerCase()];
        const match = constructors.find(c => {
          if (!c.name) return false;
          const n = c.name.toLowerCase();
          return aliases.some(a => n.includes(a));
        });
        if (match) {
          if (match.points !== pts) {
            match.points = pts;
            changed = true;
          }
        } else {
          constructors.push({
            name: name,
            points: pts
          });
          changed = true;
        }
      });
      constructors.sort((a, b) => (b.points||0) - (a.points||0));
    }

    const syncedAt = new Date().toISOString();
    await ref.set({ standings, constructors, lastStandingsSync: syncedAt, standingsSource: source }, { merge: true });
    if (changed) console.log('[sync] Updated Firestore', syncedAt, source);

    // Automatically sync streams from pushembdz if enabled
    await syncStreamsAutomatically(config, ref);

    res.json({ ok: true, updated: changed, syncedAt, source });
  } catch(err) {
    console.error('[sync] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
