/**
 * /api/sync-standings — Vercel Serverless Function
 * Called by cron-job.org every 60 seconds.
 * Tries f1.com API first, falls back to Jolpica (official FIA data).
 */

const axios = require('axios');
const admin = require('firebase-admin');
const cheerio = require('cheerio');

async function fetchJson(url, timeoutMs = 25000) {
  try {
    // Try Axios first (much faster and avoids process spawning overhead/hanging)
    const { data } = await axios.get(url, {
      timeout: timeoutMs,
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
        const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
        const cmd = `${curlCmd} -s -L -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "${url}"`;
        exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
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


const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function formatFixtureIst(kickoffMs) {
  if (!isFinite(kickoffMs) || kickoffMs === Number.MAX_SAFE_INTEGER) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const istDate = new Date(kickoffMs + IST_OFFSET_MS);
  const day = istDate.getUTCDate();
  const month = months[istDate.getUTCMonth()];
  const hour = String(istDate.getUTCHours()).padStart(2, '0');
  const minute = String(istDate.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${hour}:${minute}`;
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
  let games = null;
  try {
    const responseData = await fetchJson('https://worldcup26.ir/get/games', 25000);
    games = responseData && responseData.games;
  } catch (err) {
    console.error('[sync-fifa-details] FIFA details API fetch failed, trying local fallback file:', err.message);
    try {
      const fs = require('fs');
      const path = require('path');
      const fbGamesFile = path.resolve(__dirname, './fifa/fallback_games.json');
      if (fs.existsSync(fbGamesFile)) {
        const fbGamesData = JSON.parse(fs.readFileSync(fbGamesFile, 'utf8'));
        games = fbGamesData.games;
        console.log(`[sync-fifa-details] Loaded ${games ? games.length : 0} games from fallback file.`);
      }
    } catch (fileErr) {
      console.error('[sync-fifa-details] Failed to read fallback file:', fileErr.message);
    }
  }

  if (!Array.isArray(games) || games.length === 0) {
    console.log('[sync-fifa-details] No games data available to sync details.');
    return;
  }

  try {
    const now = Date.now();

    const STADIUM_OFFSETS = {
      '1': -6,  // Estadio Azteca (Mexico City)
      '2': -6,  // Estadio Akron (Guadalajara)
      '3': -6,  // Estadio BBVA (Monterrey)
      '4': -5,  // AT&T Stadium (Dallas)
      '5': -5,  // NRG Stadium (Houston)
      '6': -5,  // GEHA Field at Arrowhead (Kansas City)
      '7': -4,  // Mercedes-Benz Stadium (Atlanta)
      '8': -4,  // Hard Rock Stadium (Miami)
      '9': -4,  // Gillette Stadium (Boston)
      '10': -4, // Lincoln Financial Field (Philadelphia)
      '11': -4, // MetLife Stadium (New York/New Jersey)
      '12': -4, // BMO Field (Toronto)
      '13': -7, // BC Place (Vancouver)
      '14': -7, // Lumen Field (Seattle)
      '15': -7, // Levi's Stadium (San Francisco)
      '16': -7, // SoFi Stadium (Los Angeles)
    };

    // Helper: parse local_date "MM/DD/YYYY HH:MM" and stadium_id to UTC ms
    function parseGameDate(localDate, stadiumId) {
      if (!localDate) return null;
      // Format: "06/12/2026 18:00"
      const [datePart, timePart] = localDate.split(' ');
      const [month, day, year] = datePart.split('/');
      const [hour, minute] = timePart.split(':');
      const offset = STADIUM_OFFSETS[String(stadiumId)] || -4; // default to EDT (-4)
      const utcMs = Date.UTC(parseInt(year), parseInt(month)-1, parseInt(day), parseInt(hour) - offset, parseInt(minute));
      return utcMs;
    }

    // 1) Find live match first — but only if kickoff was within 3.25 hours (prevents stale "live" labels)
    const THREE_QUARTER_HOURS_MS = 3.25 * 60 * 60 * 1000;
    let chosen = null;
    const liveGame = games.find(g => g.time_elapsed === 'live');
    if (liveGame) {
      const liveKickoffMs = parseGameDate(liveGame.local_date, liveGame.stadium_id);
      if (liveKickoffMs && (now - liveKickoffMs) < THREE_QUARTER_HOURS_MS) {
        chosen = liveGame; // still within live window
      } else {
        console.log(`[sync-fifa-details] Live match "${liveGame.home_team_name_en} vs ${liveGame.away_team_name_en}" kickoff was >${THREE_QUARTER_HOURS_MS/3600000}h ago — treating as finished, moving to next.`);
      }
    }

    // 2) If none live (or stale), pick next upcoming (closest future kickoff)
    if (!chosen) {
      const upcoming = games
        .filter(g => g.time_elapsed === 'notstarted')
        .map(g => ({ ...g, _kickoffMs: parseGameDate(g.local_date, g.stadium_id) }))
        .filter(g => g._kickoffMs && g._kickoffMs > (now - 2.5 * 60 * 60 * 1000))
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

    // Kickoff datetime for timer
    const kickoffMs = parseGameDate(chosen.local_date, chosen.stadium_id);
    const isoTarget = new Date(kickoffMs).toISOString();

    // Friendly date string formatted in IST for display (e.g. "13 Jun 23:30")
    const friendlyDate = formatFixtureIst(kickoffMs);

    const isLive = chosen.time_elapsed === 'live';
    const isFinished = chosen.finished === 'TRUE';
    const homeScore = chosen.home_score || '0';
    const awayScore = chosen.away_score || '0';

    // Build updated fifa object (preserve existing keys, only update match-related fields)
    const currentFifa = config.fifa || {};
    const currentRaceData = currentFifa.raceData || {};
    const updatedFifa = {
      ...currentFifa,
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

function enrichTokens(tokens) {
  const enriched = new Set(tokens);
  // Add common abbreviations/synonyms to prevent mismatched streams
  if (tokens.includes('united') && tokens.includes('states')) {
    enriched.add('usa');
  }
  if (tokens.includes('usa')) {
    enriched.add('united');
    enriched.add('states');
  }
  if (tokens.includes('korea')) {
    enriched.add('south');
    enriched.add('rep');
    enriched.add('republic');
  }
  if (tokens.includes('czech')) {
    enriched.add('czechia');
  }
  if (tokens.includes('ivory') && tokens.includes('coast')) {
    enriched.add('cote');
    enriched.add('d\'ivoire');
    enriched.add('divoire');
  }
  if (tokens.includes('saudi')) {
    enriched.add('ksa');
  }
  return Array.from(enriched);
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

  // Check if the next match is >10 min away — don't push streams yet; clear any stale ones
  const customTimerTarget = fifa.customTimer?.target;
  if (customTimerTarget) {
    const kickoffMs = new Date(customTimerTarget).getTime();
    const now_s = Date.now();
    const isLive = fifa.raceData?.isLive;
    if (!isLive && (kickoffMs - now_s) > 10 * 60 * 1000) {
      console.log('[sync-fifa] Next match is >10 minutes away and not live. Clearing stale stream links.');
      const updatedFifa = { ...fifa, streamLinks: [] };
      await ref.update({ fifa: updatedFifa });
      return;
    }
  }

  // Tokenize match name (e.g. "Canada VS Bosnia and Herzegovina" -> ["canada", "bosnia", "herzegovina"])
  const commonWords = new Set(['vs', 'and', 'the', 'a', 'or', 'fc', 'united', 'city', 'real', 'de', 'la', 'st', 'stadium', 'opening', 'ceremony']);
  const rawTokens = matchName.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !commonWords.has(t));

  const tokens = enrichTokens(rawTokens);

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

    // Find and rank all candidate matches
    const candidates = [];
    footballMatches.forEach(m => {
      if (!m.title) return;
      const titleLower = m.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
      let matchCount = 0;
      tokens.forEach(t => {
        if (titleLower.includes(t)) matchCount++;
      });
      if (matchCount > 0) {
        candidates.push({ match: m, count: matchCount });
      }
    });

    if (candidates.length === 0) {
      console.log('[sync-fifa] No matching football matches found on streamed.pk. Clearing stale stream links.');
      // Clear stale stream links so viewer doesn't see wrong match streams
      const updatedFifa = { ...fifa, streamLinks: [] };
      await ref.update({ fifa: updatedFifa });
      return;
    }

    // Sort candidates:
    // 1. Highest token match count first
    // 2. Tie breaker: most sources first (higher likelihood of functioning links)
    candidates.sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      const aSources = (a.match.sources || []).length;
      const bSources = (b.match.sources || []).length;
      return bSources - aSources;
    });

    console.log(`[sync-fifa] Found ${candidates.length} candidate matches. Trying sequentially...`);

    let selectedMatch = null;
    let resolvedStreamLinks = [];

    for (const cand of candidates) {
      const bestMatch = cand.match;
      console.log(`[sync-fifa] Trying candidate: "${bestMatch.title}" (ID: ${bestMatch.id}) with score ${cand.count} and ${bestMatch.sources?.length || 0} sources.`);

      if (bestMatch.sources && bestMatch.sources.length > 0) {
        const streamLinks = [];
        const streamPromises = bestMatch.sources.map(async (src) => {
          try {
            if (['golf', 'tennis', 'nba', 'nhl', 'nfl', 'mlb', 'ufc', 'boxing', 'cricket', 'rugby', 'f1', 'motogp', 'motorsport'].includes(src.source.toLowerCase())) {
              return;
            }
            const streamUrl = `https://streamed.pk/api/stream/${src.source}/${src.id}`;
            const streams = await fetchJson(streamUrl);
            if (Array.isArray(streams)) {
              streams.forEach((stream) => {
                if (stream.embedUrl) {
                  const name = `${src.source.toUpperCase()} ${stream.language || 'EN'} ${stream.hd ? '(HD)' : ''}`.trim();
                  streamLinks.push({
                    name: name,
                    id: `src_fifa_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                    url: stream.embedUrl
                  });
                }
              });
            }
          } catch (err) {
            console.error(`[sync-fifa] Failed to fetch streams for candidate ${bestMatch.id} source ${src.source}:`, err.message);
          }
        });

        await Promise.all(streamPromises);

        if (streamLinks.length > 0) {
          selectedMatch = bestMatch;
          resolvedStreamLinks = streamLinks;
          console.log(`[sync-fifa] Candidate "${bestMatch.title}" successfully resolved ${streamLinks.length} stream links!`);
          break; // Stop iteration — we found a working match!
        } else {
          console.log(`[sync-fifa] Candidate "${bestMatch.title}" resolved 0 working stream links. Trying next candidate.`);
        }
      } else {
        console.log(`[sync-fifa] Candidate "${bestMatch.title}" has no sources. Trying next candidate.`);
      }
    }

    if (selectedMatch && resolvedStreamLinks.length > 0) {
      // Update fifa.streamLinks field in Firestore
      const updatedFifa = {
        ...fifa,
        streamLinks: resolvedStreamLinks
      };
      await ref.update({ fifa: updatedFifa });
      console.log(`[sync-fifa] Successfully updated ${resolvedStreamLinks.length} FIFA stream links in Firestore using match "${selectedMatch.title}".`);
    } else {
      // No streams found — clear any old stale links
      console.log('[sync-fifa] None of the candidate matches yielded any active stream URLs. Clearing stale links.');
      const updatedFifa = { ...fifa, streamLinks: [] };
      await ref.update({ fifa: updatedFifa });
    }
  } catch (err) {
    console.error('[sync-fifa] Error during auto-sync:', err.message);
    throw err;
  }
}


module.exports = async (req, res) => {
  console.log(`[sync-standings API] Received request: ${req.method} ${req.url}`);
  if (!['GET','POST'].includes(req.method)) {
    console.log(`[sync-standings API] Invalid method: ${req.method}`);
    return res.status(405).end();
  }

  try {
    console.log('[sync-standings API] Accessing Firestore...');
    const db = admin.firestore();
    const ref = db.collection('app_data').doc('live_config');
    const doc = await ref.get();
    console.log('[sync-standings API] Firestore live_config doc exists:', doc.exists);
    if (!doc.exists) return res.json({ ok: false, message: 'live_config not found' });

    let config = doc.data();

    const requestedType = req.query.type; // standings, f1streams, fifadetails, fifastreams
    const runAll = !requestedType;

    // 1. Sync F1 Standings (if allowed and standings available)
    let standingsSynced = false;
    let standingsError = null;
    let syncedAt = null;
    let source = null;
    let changed = false;

    if (runAll || requestedType === 'standings') {
      console.log('[sync-standings API] config.autoSyncStandings:', config.autoSyncStandings, 'manual:', req.query.manual);
      // Check if auto-sync is disabled.
      // Allow manual triggers (?manual=true) to bypass this check.
      if (config.autoSyncStandings !== false || req.query.manual === 'true') {
        console.log('[sync-standings API] Triggering fetchStandings...');
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
    }

    // 2. Automatically sync F1 streams from pushembdz if enabled
    let f1StreamsSynced = false;
    let f1StreamsError = null;
    if (runAll || requestedType === 'f1streams') {
      console.log('[sync-standings API] Starting F1 streams sync...');
      try {
        await syncStreamsAutomatically(config, ref);
        console.log('[sync-standings API] F1 streams sync complete.');
        f1StreamsSynced = true;
      } catch (err) {
        console.error('[sync] F1 streams auto-fetch error:', err.message);
        f1StreamsError = err.message;
      }
    }

    // 3. Auto-update FIFA match details from worldcup26.ir (name, score, venue, timer)
    let fifaDetailsSynced = false;
    let fifaDetailsError = null;
    let updatedFifaConfig = null;
    if (runAll || requestedType === 'fifadetails') {
      console.log('[sync-standings API] Starting FIFA details sync...');
      try {
        updatedFifaConfig = await syncFifaMatchDetails(config, ref);
        if (updatedFifaConfig) {
          console.log('[sync-standings API] FIFA details config updated.');
          // Refresh config so stream sync uses the newly set match name
          config = { ...config, fifa: updatedFifaConfig };
        } else {
          console.log('[sync-standings API] FIFA details returned no update.');
        }
        fifaDetailsSynced = true;
      } catch (err) {
        console.error('[sync] FIFA details sync error:', err.message);
        fifaDetailsError = err.message;
      }
    }

    // 4. Automatically sync FIFA streams from streamed.pk
    let fifaStreamsSynced = false;
    let fifaStreamsError = null;
    if (runAll || requestedType === 'fifastreams') {
      console.log('[sync-standings API] Starting FIFA streams sync...');
      try {
        await syncFifaStreams(config, ref);
        console.log('[sync-standings API] FIFA streams sync complete.');
        fifaStreamsSynced = true;
      } catch (err) {
        console.error('[sync] FIFA streams auto-sync error:', err.message);
        fifaStreamsError = err.message;
      }
    }

    console.log('[sync-standings API] Sending response...');
    res.json({
      ok: true,
      standings: { synced: standingsSynced, updated: changed, syncedAt, source, error: standingsError },
      f1Streams: { synced: f1StreamsSynced, error: f1StreamsError },
      fifaDetails: { synced: fifaDetailsSynced, error: fifaDetailsError },
      fifaStreams: { synced: fifaStreamsSynced, error: fifaStreamsError }
    });
  } catch(err) {
    console.error('[sync-standings API] Error in main sync handler:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }

};
