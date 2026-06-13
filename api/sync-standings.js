/**
 * /api/sync-standings — Vercel Serverless Function
 * Called by cron-job.org every 60 seconds.
 * Tries f1.com API first, falls back to Jolpica (official FIA data).
 */

const axios = require('axios');
const admin = require('firebase-admin');
const cheerio = require('cheerio');

async function fetchJson(url) {
  try {
    // Try Axios first (much faster and avoids process spawning overhead/hanging)
    const { data } = await axios.get(url, {
      timeout: 6000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://streamed.pk/category/football'
      }
    });
    return data;
  } catch (e) {
    // Fallback to native curl (helps bypass Cloudflare/Ddos-guard TLS fingerprints on serverless environments)
    console.log(`[fetchJson] Axios failed for ${url}: ${e.message}. Falling back to curl.`);
    try {
      const { exec } = require('child_process');
      return await new Promise((resolve, reject) => {
        const cmd = `curl -s -L -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "${url}"`;
        exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 6000 }, (error, stdout, stderr) => {
          if (error) {
            return reject(error);
          }
          try {
            const data = JSON.parse(stdout);
            resolve(data);
          } catch (jsonErr) {
            reject(new Error(`Failed to parse JSON from curl stdout: ${jsonErr.message}. Output was: ${stdout.substring(0, 200)}`));
          }
        });
      });
    } catch (curlErr) {
      throw new Error(`Both Axios and curl failed to fetch ${url}. Axios: ${e.message}. Curl: ${curlErr.message}`);
    }
  }
}


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
    let searchTokens = [];
    if (config.streamKeyword) {
      searchTokens = config.streamKeyword.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 0);
    } else {
      let rawLocation = config.raceData?.location || "";
      if (!rawLocation && config.raceData?.name) {
        rawLocation = config.raceData.name;
      }
      
      let location = "";
      if (rawLocation) {
        let parts = rawLocation.split(',');
        if (parts.length >= 2) {
          location = parts[parts.length - 2].trim().replace(/[0-9]/g, '').trim();
        } else {
          location = parts[parts.length - 1].trim().replace(/[0-9]/g, '').trim();
        }
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

      searchTokens = ["f1", location.toLowerCase(), sessionAbbr.toLowerCase()];
    }

    if (searchTokens.length === 0) return;

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
        console.log(`[sync] Automatically updated ${newLinks.length} stream links in Firestore matching: ${searchTokens.join(' ')}`);
      } else {
        console.log(`[sync] No matching streams found for tokens: ${searchTokens.join(' ')}`);
      }
    }
  } catch (err) {
    console.error('[sync] Stream auto-fetch error:', err.message);
    throw err;
  }
}

// Stadium ID → name/city/country map (built from worldcup26.ir data)
const STADIUM_MAP = {
  '1':  { name: 'Estadio Azteca', city: 'Mexico City', country: 'Mexico' },
  '2':  { name: 'Estadio Akron', city: 'Guadalajara', country: 'Mexico' },
  '3':  { name: 'Estadio BBVA', city: 'Monterrey', country: 'Mexico' },
  '4':  { name: 'AT&T Stadium', city: 'Dallas', country: 'United States' },
  '5':  { name: 'NRG Stadium', city: 'Houston', country: 'United States' },
  '6':  { name: 'GEHA Field at Arrowhead Stadium', city: 'Kansas City', country: 'United States' },
  '7':  { name: 'Mercedes-Benz Stadium', city: 'Atlanta', country: 'United States' },
  '8':  { name: 'Hard Rock Stadium', city: 'Miami', country: 'United States' },
  '9':  { name: 'Gillette Stadium', city: 'Boston', country: 'United States' },
  '10': { name: 'Lincoln Financial Field', city: 'Philadelphia', country: 'United States' },
  '11': { name: 'MetLife Stadium', city: 'New York/New Jersey', country: 'United States' },
  '12': { name: 'BMO Field', city: 'Toronto', country: 'Canada' },
  '13': { name: 'BC Place', city: 'Vancouver', country: 'Canada' },
  '14': { name: 'Lumen Field', city: 'Seattle', country: 'United States' },
  '15': { name: "Levi's Stadium", city: 'San Francisco Bay Area', country: 'United States' },
  '16': { name: 'SoFi Stadium', city: 'Los Angeles', country: 'United States' },
};

/**
 * Fetch current/next FIFA match from worldcup26.ir and update Firestore details.
 * Updates: raceData.name, raceData.round, raceData.circuit, raceData.location,
 *          raceData.date (for pill countdown), customTimer.target (for kickoff),
 *          raceData.homeScore, raceData.awayScore, raceData.isLive, raceData.isFinished
 */
async function syncFifaMatchDetails(config, ref) {
  const fifa = config.fifa || {};
  // Only auto-update if autoSyncDetails is true (or not set — defaults to on)
  if (fifa.autoSyncDetails === false) {
    console.log('[sync-fifa-details] autoSyncDetails is disabled. Skipping.');
    return;
  }

  try {
    const response = await axios.get('https://worldcup26.ir/get/games', {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const games = response.data && response.data.games;
    if (!Array.isArray(games) || games.length === 0) {
      console.log('[sync-fifa-details] No games returned from worldcup26.ir.');
      return;
    }

    const now = Date.now();

    // Helper: parse local_date "MM/DD/YYYY HH:MM" → UTC ms (assume US Eastern = UTC-4 during summer)
    function parseGameDate(localDate) {
      if (!localDate) return null;
      // Format: "06/12/2026 18:00"
      const [datePart, timePart] = localDate.split(' ');
      const [month, day, year] = datePart.split('/');
      const [hour, minute] = timePart.split(':');
      // US Eastern Daylight Time (UTC-4) during the tournament
      const utcMs = Date.UTC(parseInt(year), parseInt(month)-1, parseInt(day), parseInt(hour)+4, parseInt(minute));
      return utcMs;
    }

    // 1) Find live match first
    let chosen = games.find(g => g.time_elapsed === 'live');

    // 2) If none live, pick next upcoming (closest future kickoff)
    if (!chosen) {
      const upcoming = games
        .filter(g => g.time_elapsed === 'notstarted')
        .map(g => ({ ...g, _kickoffMs: parseGameDate(g.local_date) }))
        .filter(g => g._kickoffMs && g._kickoffMs > now)
        .sort((a, b) => a._kickoffMs - b._kickoffMs);
      chosen = upcoming[0] || null;
    }

    if (!chosen) {
      console.log('[sync-fifa-details] No live or upcoming group matches found.');
      return;
    }

    // Build match name — for group matches use team names; for knockouts use labels
    const isKnockout = !chosen.home_team_name_en;
    const matchName = isKnockout
      ? `${chosen.home_team_label || 'TBD'} vs ${chosen.away_team_label || 'TBD'}`
      : `${chosen.home_team_name_en} vs ${chosen.away_team_name_en}`;

    // Round label
    const roundMap = { group: `Group ${chosen.group}`, r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-Final', sf: 'Semi-Final', third: '3rd Place Play-off', final: 'Final' };
    const round = roundMap[chosen.type] || chosen.group || 'World Cup 2026';

    // Stadium info
    const stadium = STADIUM_MAP[chosen.stadium_id] || { name: 'Stadium', city: '', country: '' };
    const location = `${stadium.city}, ${stadium.country}`;

    // Kickoff datetime for timer (ISO format compatible with customTimer.target)
    const kickoffMs = parseGameDate(chosen.local_date);
    // Format as YYYY-MM-DDTHH:MM:00 in local time (treat as the raw local time from the API)
    const [datePart, timePart] = (chosen.local_date || '').split(' ');
    const [mm, dd, yyyy] = (datePart || '').split('/');
    const isoTarget = `${yyyy}-${mm}-${dd}T${timePart}:00`;

    // Friendly date string for display (e.g. "13 Jun 18:00")
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthIdx = parseInt(mm, 10) - 1;
    const friendlyDate = `${parseInt(dd, 10)} ${months[monthIdx]} ${timePart}`;

    const isLive = chosen.time_elapsed === 'live';
    const isFinished = chosen.finished === 'TRUE';
    const homeScore = chosen.home_score || '0';
    const awayScore = chosen.away_score || '0';

    // Build updated fifa object (preserve existing keys, only update match-related fields)
    const currentFifa = config.fifa || {};
    const currentRaceData = currentFifa.raceData || {};
    const updatedFifa = {
      ...currentFifa,
      autoSyncDetails: currentFifa.autoSyncDetails !== false, // preserve flag
      raceData: {
        ...currentRaceData,
        name: matchName,
        round: round,
        circuit: stadium.name,
        location: location,
        date: friendlyDate,
        homeScore: homeScore,
        awayScore: awayScore,
        isLive: isLive,
        isFinished: isFinished,
      },
      // Auto-update customTimer target to kickoff time (enable it too)
      customTimer: {
        ...(currentFifa.customTimer || {}),
        enabled: true,
        target: isoTarget,
        label: isLive ? 'LIVE NOW' : 'MATCH KICKS OFF',
      }
    };

    await ref.update({ fifa: updatedFifa });
    console.log(`[sync-fifa-details] Updated FIFA match: "${matchName}" | ${round} | ${stadium.name}, ${location} | Kickoff: ${isoTarget} | Live: ${isLive}`);

    // Return the updated config so syncFifaStreams can use the new name
    return updatedFifa;
  } catch (err) {
    console.error('[sync-fifa-details] Error:', err.message);
    // Non-fatal — streams sync should still run
  }
}

async function syncFifaStreams(config, ref) {
  const fifa = config.fifa || {};
  console.log('[sync-fifa] Starting FIFA stream sync. config.fifa exists:', !!config.fifa, 'autoSyncStreams:', fifa.autoSyncStreams);
  if (fifa.autoSyncStreams === false) {
    console.log('[sync-fifa] Auto-sync disabled (autoSyncStreams is false).');
    return;
  }

  const matchName = fifa.raceData?.name;
  if (!matchName) {
    console.log('[sync-fifa] No match name in FIFA config.');
    return;
  }

  // Tokenize match name (e.g. "Canada VS Bosnia and Herzegovina" -> ["canada", "bosnia", "herzegovina"])
  const commonWords = new Set(['vs', 'and', 'the', 'a', 'or', 'fc', 'united', 'city', 'real', 'de', 'la', 'st', 'stadium', 'opening', 'ceremony']);
  const tokens = matchName.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !commonWords.has(t));

  if (tokens.length === 0) {
    console.log('[sync-fifa] No valid search tokens extracted from:', matchName);
    return;
  }

  try {
    console.log(`[sync-fifa] Fetching matches to match tokens: ${tokens.join(' ')}`);
    const matches = await fetchJson('https://streamed.pk/api/matches/all');

    if (!Array.isArray(matches)) {
      console.log('[sync-fifa] Matches response is not an array.');
      return;
    }

    // Filter by category: football
    const footballMatches = matches.filter(m => m.category === 'football');

    // Find the best matching match
    let bestMatch = null;
    let maxMatchCount = 0;

    footballMatches.forEach(m => {
      if (!m.title) return;
      const titleLower = m.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
      let matchCount = 0;
      tokens.forEach(t => {
        if (titleLower.includes(t)) matchCount++;
      });

      if (matchCount > maxMatchCount) {
        maxMatchCount = matchCount;
        bestMatch = m;
      }
    });

    if (!bestMatch || maxMatchCount === 0) {
      console.log('[sync-fifa] No matching football match found on streamed.pk.');
      return;
    }

    console.log(`[sync-fifa] Found matching match: "${bestMatch.title}" with ${maxMatchCount} matching tokens.`);

    // Fetch stream links for each source
    if (bestMatch.sources && bestMatch.sources.length > 0) {
      const streamLinks = [];
      const fetchErrors = [];
      
      const streamPromises = bestMatch.sources.map(async (src) => {
        try {
          const streamUrl = `https://streamed.pk/api/stream/${src.source}/${src.id}`;
          const streams = await fetchJson(streamUrl);
          
          if (Array.isArray(streams)) {
            streams.forEach((stream, idx) => {
              if (stream.embedUrl) {
                const name = `${src.source.toUpperCase()} ${stream.language || 'EN'} ${stream.hd ? '(HD)' : ''}`.trim();
                streamLinks.push({
                  name: name,
                  id: `src_fifa_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                  url: stream.embedUrl
                });
              }
            });
          } else {
            fetchErrors.push(`${src.source}: response was not an array`);
          }
        } catch (err) {
          console.error(`[sync-fifa] Failed to fetch streams for source ${src.source}:`, err.message);
          fetchErrors.push(`${src.source}: ${err.message}`);
        }
      });

      await Promise.all(streamPromises);

      if (streamLinks.length > 0) {
        // Update fifa.streamLinks field in Firestore
        const updatedFifa = {
          ...fifa,
          streamLinks: streamLinks
        };
        await ref.update({ fifa: updatedFifa });
        console.log(`[sync-fifa] Successfully updated ${streamLinks.length} FIFA stream links in Firestore.`);
      } else {
        console.log('[sync-fifa] No active stream URLs found for matched match.');
        throw new Error(`Failed to resolve any stream URLs. Errors: ${fetchErrors.join(' | ')}`);
      }
    } else {
      console.log('[sync-fifa] Matched match has no sources.');
      throw new Error('Matched match has no sources.');
    }
  } catch (err) {
    console.error('[sync-fifa] Error during auto-sync:', err.message);
    throw err;
  }
}

module.exports = async (req, res) => {
  if (!['GET','POST'].includes(req.method)) return res.status(405).end();

  try {
    const db = admin.firestore();
    const ref = db.collection('app_data').doc('live_config');
    const doc = await ref.get();
    if (!doc.exists) return res.json({ ok: false, message: 'live_config not found' });

    let config = doc.data();

    // 1. Sync F1 Standings (if allowed and standings available)
    let standingsSynced = false;
    let standingsError = null;
    let syncedAt = null;
    let source = null;
    let changed = false;

    // Check if auto-sync is disabled.
    // Allow manual triggers (?manual=true) to bypass this check.
    if (config.autoSyncStandings !== false || req.query.manual === 'true') {
      try {
        const result = await fetchStandings();
        const dl = result.dl;
        const cl = result.cl;
        source = result.source;

        if (dl && dl.length > 0) {
          const standings = config.standings || [];
          const constructors = config.constructors || [];
          
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

          syncedAt = new Date().toISOString();
          await ref.set({ standings, constructors, lastStandingsSync: syncedAt, standingsSource: source }, { merge: true });
          if (changed) console.log('[sync] Updated Firestore standings', syncedAt, source);
          standingsSynced = true;
        } else {
          console.log('[sync] No driver standings data retrieved (e.g. empty driver standings list).');
        }
      } catch (err) {
        console.error('[sync] Error syncing F1 standings:', err.message);
        standingsError = err.message;
      }
    } else {
      console.log('[sync] Standings auto-sync is disabled. Skipping.');
    }

    // 2. Automatically sync F1 streams from pushembdz if enabled
    let f1StreamsSynced = false;
    let f1StreamsError = null;
    try {
      await syncStreamsAutomatically(config, ref);
      f1StreamsSynced = true;
    } catch (err) {
      console.error('[sync] F1 streams auto-fetch error:', err.message);
      f1StreamsError = err.message;
    }

    // 3. Auto-update FIFA match details from worldcup26.ir (name, score, venue, timer)
    let fifaDetailsSynced = false;
    let fifaDetailsError = null;
    let updatedFifaConfig = null;
    try {
      updatedFifaConfig = await syncFifaMatchDetails(config, ref);
      if (updatedFifaConfig) {
        // Refresh config so stream sync uses the newly set match name
        config = { ...config, fifa: updatedFifaConfig };
      }
      fifaDetailsSynced = true;
    } catch (err) {
      console.error('[sync] FIFA details sync error:', err.message);
      fifaDetailsError = err.message;
    }

    // 4. Automatically sync FIFA streams from streamed.pk
    let fifaStreamsSynced = false;
    let fifaStreamsError = null;
    try {
      await syncFifaStreams(config, ref);
      fifaStreamsSynced = true;
    } catch (err) {
      console.error('[sync] FIFA streams auto-sync error:', err.message);
      fifaStreamsError = err.message;
    }

    res.json({
      ok: true,
      standings: { synced: standingsSynced, updated: changed, syncedAt, source, error: standingsError },
      f1Streams: { synced: f1StreamsSynced, error: f1StreamsError },
      fifaDetails: { synced: fifaDetailsSynced, error: fifaDetailsError },
      fifaStreams: { synced: fifaStreamsSynced, error: fifaStreamsError }
    });
  } catch(err) {
    console.error('[sync] Error in main sync handler:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
