const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Puppeteer is only available when running locally (not on Vercel)
let scraper = null;
try {
    scraper = require('./f1_scraper.js');
    console.log('✅ Puppeteer scraper loaded (local mode).');
} catch (e) {
    console.warn('⚠️  Puppeteer scraper not available (Vercel/serverless mode). Live scraping disabled.');
}

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: Allow the admin panel to call this API from any origin
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Serve static frontend files (index.html, admin.html, etc.) when running locally
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Firebase initialization
let db;
try {
  if (admin.apps.length) {
    // Already initialized (e.g. by a required module like sync-standings.js)
    db = admin.firestore();
    console.log('[server] Reusing existing Firebase app instance.');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Vercel / Production mode: load from environment variable
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('Firebase Admin initialized from Environment Variable.');
  } else {
    // Local development mode: check root or nested folder for credentials
    const path = require('path');
    let keyPath = null;
    if (fs.existsSync('./serviceAccountKey.json')) {
      keyPath = path.resolve('./serviceAccountKey.json');
    } else if (fs.existsSync('./f1watchparty-web-main/f1watchparty-web-main/f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json')) {
      keyPath = path.resolve('./f1watchparty-web-main/f1watchparty-web-main/f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json');
    }

    if (keyPath) {
      const serviceAccount = require(keyPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      db = admin.firestore();
      console.log('Firebase Admin initialized from file:', keyPath);
    } else {
      console.warn('\n!!! WARNING !!!\nNo Firebase credentials found (env or file). Firebase writes will be simulated.\n');
    }
  }
} catch (error) {
  console.error('Failed to initialize Firebase Admin:', error);
}

// Helper to fetch JSON with high timeout and native curl fallback to avoid connection issues / DDoS-guard blocks
async function fetchJson(url, timeoutMs = 25000) {
  try {
    const { data } = await axios.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://streamed.pk/category/football'
      }
    });
    return data;
  } catch (e) {
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

// Load static 2026 schedule
const schedule2026 = require('./schedule_2026.json');

const state = {
  activeSession: null,
  livePositions: [],
  lastSync: null,
  weather: { air: 0, track: 0, condition: 'sunny' },
  isLiveRace: false
};

// --- Session Detection via OpenF1 ---
async function fetchLatestSession() {
  try {
    const { data } = await axios.get('https://api.openf1.org/v1/sessions?session_key=latest');
    if (data && data.length > 0) {
      const s = data[0];
      state.activeSession = {
        name: s.session_name,
        key: s.session_key,
        location: s.location,
        circuit: s.circuit_short_name || s.location,
        date: s.date_start,
        status: s.status
      };
      
      if (state.activeSession.location) fetchWeather(state.activeSession.location);
      state.isLiveRace = true;
      return true;
    }
  } catch (error) {
    console.error('Failed to fetch OpenF1 session:', error.message);
  }
  return false;
}

async function fetchWeather(location) {
    try {
        const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
        let temp = parseInt(data.current_condition[0].temp_C);
        let desc = data.current_condition[0].weatherDesc[0].value.toLowerCase();
        
        state.weather.air = temp;
        state.weather.track = temp + Math.floor(Math.random() * 8) + 4;
        
        if (desc.includes('rain') || desc.includes('drizzle') || desc.includes('shower')) state.weather.condition = 'rain';
        else if (desc.includes('cloud') || desc.includes('overcast')) state.weather.condition = 'cloudy';
        else if (desc.includes('storm') || desc.includes('thunder')) state.weather.condition = 'storm';
        else state.weather.condition = 'sunny';
        
    } catch(e) {
        console.error('Weather fetch error:', e.message);
    }
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

const STADIUM_MAP_SERVER = {
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

const FIFA_STADIUM_OFFSETS = {
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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

async function syncFifaMatchDetailsLocal(config, ref) {
    let games = null;
    try {
        const responseData = await fetchJson('https://worldcup26.ir/get/games', 25000);
        games = responseData && responseData.games;
    } catch (err) {
        console.error('[local-sync] FIFA details api fetch failed, trying fallback file:', err.message);
        try {
            const fbGamesFile = path.join(__dirname, 'api/fifa/fallback_games.json');
            if (fs.existsSync(fbGamesFile)) {
                const fbGamesData = JSON.parse(fs.readFileSync(fbGamesFile, 'utf8'));
                games = fbGamesData.games;
                console.log(`[local-sync] Loaded ${games ? games.length : 0} games from fallback file.`);
            }
        } catch (fileErr) {
            console.error('[local-sync] Failed to read fallback file:', fileErr.message);
        }
    }

    if (!Array.isArray(games) || games.length === 0) {
        console.log('[local-sync] No games data available to sync details.');
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

        function parseGameDate(localDate, stadiumId) {
            if (!localDate) return null;
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
                chosen = liveGame;
            } else {
                console.log(`[local-sync] Live match stale (kickoff >${THREE_QUARTER_HOURS_MS/3600000}h ago) — moving to next.`);
            }
        }
        if (!chosen) {
            const upcoming = games
                .filter(g => g.time_elapsed === 'notstarted')
                .map(g => ({ ...g, _kickoffMs: parseGameDate(g.local_date, g.stadium_id) }))
                .filter(g => g._kickoffMs && g._kickoffMs > (now - 2.5 * 60 * 60 * 1000))
                .sort((a, b) => a._kickoffMs - b._kickoffMs);
            chosen = upcoming[0] || null;
        }
        if (!chosen) return;

        const isKnockout = !chosen.home_team_name_en;
        const matchName = isKnockout
            ? `${chosen.home_team_label || 'TBD'} vs ${chosen.away_team_label || 'TBD'}`
            : `${chosen.home_team_name_en} vs ${chosen.away_team_name_en}`;

        const roundMap = { group: `Group ${chosen.group}`, r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-Final', sf: 'Semi-Final', third: '3rd Place Play-off', final: 'Final' };
        const round = roundMap[chosen.type] || chosen.group || 'World Cup 2026';

        const stadium = STADIUM_MAP_SERVER[chosen.stadium_id] || { name: 'Stadium', city: '', country: '' };
        const location = `${stadium.city}, ${stadium.country}`;

        const [datePart, timePart] = (chosen.local_date || '').split(' ');
        const [mm, dd, yyyy] = (datePart || '').split('/');

        // Kickoff datetime for timer
        const kickoffMs = parseGameDate(chosen.local_date, chosen.stadium_id);
        const isoTarget = new Date(kickoffMs).toISOString();

        const friendlyDate = formatFifaFixtureIst(kickoffMs);

        const isLive = chosen.time_elapsed === 'live';
        const isFinished = chosen.finished === 'TRUE';
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
                homeScore: chosen.home_score || '0',
                awayScore: chosen.away_score || '0',
                isLive: isLive,
                isFinished: isFinished,
            },
            customTimer: {
                ...(currentFifa.customTimer || {}),
                enabled: true,
                target: isoTarget,
                label: isLive ? 'LIVE NOW' : 'MATCH KICKS OFF',
            }
        };

        await ref.update({ fifa: updatedFifa });
        console.log(`[local-sync] FIFA: "${matchName}" | ${round} | ${stadium.name} | Kickoff: ${isoTarget} | Live: ${isLive}`);
        return updatedFifa;
    } catch (err) {
        console.error('[local-sync] FIFA details error:', err.message);
    }
}

function enrichTokens(tokens) {
  const enriched = new Set(tokens);
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

async function syncFifaStreamsLocal(config, ref) {
  const fifa = config.fifa || {};
  console.log('[local-sync-fifa] Starting FIFA stream sync. autoSyncStreams:', fifa.autoSyncStreams);
  if (fifa.autoSyncStreams === false) {
    console.log('[local-sync-fifa] Auto-sync disabled (autoSyncStreams is false).');
    return;
  }

  const matchName = fifa.raceData?.name;
  if (!matchName) {
    console.log('[local-sync-fifa] No match name in FIFA config.');
    return;
  }

  // Clear stale streams if the match is >10 min away and not live
  const customTimerTarget = fifa.customTimer?.target;
  if (customTimerTarget) {
    const kickoffMs = new Date(customTimerTarget).getTime();
    const now_s = Date.now();
    const isLive = fifa.raceData?.isLive;
    if (!isLive && (kickoffMs - now_s) > 10 * 60 * 1000) {
      console.log('[local-sync-fifa] Match is >10 min away and not live. Clearing stale stream links.');
      const updatedFifa = { ...fifa, streamLinks: [] };
      await ref.update({ fifa: updatedFifa });
      return;
    }
  }

  // Tokenize match name
  const commonWords = new Set(['vs', 'and', 'the', 'a', 'or', 'fc', 'united', 'city', 'real', 'de', 'la', 'st', 'stadium', 'opening', 'ceremony']);
  const rawTokens = matchName.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !commonWords.has(t));

  const tokens = enrichTokens(rawTokens);

  if (tokens.length === 0) {
    console.log('[local-sync-fifa] No valid search tokens extracted from:', matchName);
    return;
  }

  try {
    console.log(`[local-sync-fifa] Fetching matches to match tokens: ${tokens.join(' ')}`);
    const matches = await fetchJson('https://streamed.pk/api/matches/all');

    if (!Array.isArray(matches)) {
      console.log('[local-sync-fifa] Matches response is not an array.');
      return;
    }

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
      console.log('[local-sync-fifa] No matching football matches found on streamed.pk. Clearing stale stream links.');
      const updatedFifa = { ...fifa, streamLinks: [] };
      await ref.update({ fifa: updatedFifa });
      return;
    }

    // Sort candidates: token count desc, sources length desc
    candidates.sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      const aSources = (a.match.sources || []).length;
      const bSources = (b.match.sources || []).length;
      return bSources - aSources;
    });

    console.log(`[local-sync-fifa] Found ${candidates.length} candidate matches. Trying sequentially...`);

    let selectedMatch = null;
    let resolvedStreamLinks = [];

    for (const cand of candidates) {
      const bestMatch = cand.match;
      console.log(`[local-sync-fifa] Trying candidate: "${bestMatch.title}" (ID: ${bestMatch.id}) with score ${cand.count} and ${bestMatch.sources?.length || 0} sources.`);

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
            console.error(`[local-sync-fifa] Failed to fetch streams for candidate ${bestMatch.id} source ${src.source}:`, err.message);
          }
        });

        await Promise.all(streamPromises);

        if (streamLinks.length > 0) {
          selectedMatch = bestMatch;
          resolvedStreamLinks = streamLinks;
          console.log(`[local-sync-fifa] Candidate "${bestMatch.title}" successfully resolved ${streamLinks.length} stream links!`);
          break; // Stop iteration — we found a working match!
        } else {
          console.log(`[local-sync-fifa] Candidate "${bestMatch.title}" resolved 0 working stream links. Trying next candidate.`);
        }
      } else {
        console.log(`[local-sync-fifa] Candidate "${bestMatch.title}" has no sources. Trying next candidate.`);
      }
    }

    if (selectedMatch && resolvedStreamLinks.length > 0) {
      const updatedFifa = {
        ...fifa,
        streamLinks: resolvedStreamLinks
      };
      await ref.update({ fifa: updatedFifa });
      console.log(`[local-sync-fifa] Successfully updated ${resolvedStreamLinks.length} FIFA stream links in Firestore using match "${selectedMatch.title}".`);
    } else {
      console.log('[local-sync-fifa] None of the candidate matches yielded any active stream URLs. Clearing stale links.');
      const updatedFifa = { ...fifa, streamLinks: [] };
      await ref.update({ fifa: updatedFifa });
    }
  } catch (err) {
    console.error('[local-sync-fifa] Error during auto-sync:', err.message);
  }
}

async function syncToFirebase() {
    if (!db) {
        console.log('Simulating sync to Firebase...', new Date().toLocaleTimeString());
        return;
    }
    try {
        const liveConfigRef = db.collection('app_data').doc('live_config');
        await liveConfigRef.set({
            weather: state.weather,
            isLiveRaceActive: state.isLiveRace,
            lastAutoSync: Date.now()
        }, { merge: true });
        console.log(`✅ Synced weather & session to Firebase at ${new Date().toLocaleTimeString()}.`);

        // Fetch current config to check if stream auto-sync is enabled
        const configDoc = await liveConfigRef.get();
        if (configDoc.exists) {
            const config = configDoc.data();
            await syncStreamsAutomatically(config, liveConfigRef);

            // Auto-sync FIFA match details from worldcup26.ir (if enabled)
            try {
                let updatedFifa = null;
                if (config.fifa && config.fifa.autoSyncDetails !== false) {
                    updatedFifa = await syncFifaMatchDetailsLocal(config, liveConfigRef);
                }
                const currentConfig = {
                    ...config,
                    fifa: updatedFifa || config.fifa || {}
                };
                await syncFifaStreamsLocal(currentConfig, liveConfigRef);
            } catch(fe) {
                console.error('[local-sync] FIFA sync error:', fe.message);
            }
        }
    } catch (e) {
        console.error('Firebase sync error:', e);
    }
}

// Polling intervals (only start in long-running mode, not on Vercel serverless)
if (!process.env.VERCEL) {
    setInterval(fetchLatestSession, 30000);
    setInterval(syncToFirebase, 30000);
}

// --- API: Live Leaderboard (scraped from F1.com) ---
app.get('/api/live-leaderboard', async (req, res) => {
    try {
        if (!scraper) {
            // Vercel deployment: scraper not available, return empty
            return res.json([]);
        }
        const data = await scraper.scrapeLiveLeaderboard();
        res.json(data || []);
    } catch (e) {
        console.error('Scraper error:', e.message);
        res.json([]);
    }
});

// --- API: Fetch Streams from pushembdz.store ---
app.get('/api/fetch-streams', async (req, res) => {
    try {
        const { data } = await axios.get('https://api.pushembdz.store/v1/streams', { 
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        res.json(data);
    } catch (e) {
        console.error('Error fetching streams:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Cache variables for FIFA APIs
let cacheFixtures = null;
let cacheFixturesTime = 0;
let cacheStandings = null;
let cacheStandingsTime = 0;

// Hardcoded country name -> flag URL for fixture flags
const COUNTRY_FLAG_MAP_SERVER = {
    'mexico': 'https://flagcdn.com/w80/mx.png',
    'south africa': 'https://flagcdn.com/w80/za.png',
    'south korea': 'https://flagcdn.com/w80/kr.png',
    'czech republic': 'https://flagcdn.com/w80/cz.png',
    'canada': 'https://flagcdn.com/w80/ca.png',
    'bosnia and herzegovina': 'https://flagcdn.com/w80/ba.png',
    'united states': 'https://flagcdn.com/w80/us.png',
    'paraguay': 'https://flagcdn.com/w80/py.png',
    'haiti': 'https://flagcdn.com/w80/ht.png',
    'scotland': 'https://flagcdn.com/w80/gb-sct.png',
    'australia': 'https://flagcdn.com/w80/au.png',
    'turkey': 'https://flagcdn.com/w80/tr.png',
    'brazil': 'https://flagcdn.com/w80/br.png',
    'morocco': 'https://flagcdn.com/w80/ma.png',
    'qatar': 'https://flagcdn.com/w80/qa.png',
    'switzerland': 'https://flagcdn.com/w80/ch.png',
    'ivory coast': 'https://flagcdn.com/w80/ci.png',
    'ecuador': 'https://flagcdn.com/w80/ec.png',
    'germany': 'https://flagcdn.com/w80/de.png',
    'curaçao': 'https://flagcdn.com/w80/cw.png',
    'curacao': 'https://flagcdn.com/w80/cw.png',
    'netherlands': 'https://flagcdn.com/w80/nl.png',
    'japan': 'https://flagcdn.com/w80/jp.png',
    'sweden': 'https://flagcdn.com/w80/se.png',
    'tunisia': 'https://flagcdn.com/w80/tn.png',
    'iran': 'https://flagcdn.com/w80/ir.png',
    'new zealand': 'https://flagcdn.com/w80/nz.png',
    'spain': 'https://flagcdn.com/w80/es.png',
    'cape verde': 'https://flagcdn.com/w80/cv.png',
    'belgium': 'https://flagcdn.com/w80/be.png',
    'egypt': 'https://flagcdn.com/w80/eg.png',
    'saudi arabia': 'https://flagcdn.com/w80/sa.png',
    'uruguay': 'https://flagcdn.com/w80/uy.png',
    'france': 'https://flagcdn.com/w80/fr.png',
    'senegal': 'https://flagcdn.com/w80/sn.png',
    'iraq': 'https://flagcdn.com/w80/iq.png',
    'norway': 'https://flagcdn.com/w80/no.png',
    'argentina': 'https://flagcdn.com/w80/ar.png',
    'algeria': 'https://flagcdn.com/w80/dz.png',
    'austria': 'https://flagcdn.com/w80/at.png',
    'jordan': 'https://flagcdn.com/w80/jo.png',
    'portugal': 'https://flagcdn.com/w80/pt.png',
    'democratic republic of the congo': 'https://flagcdn.com/w80/cd.png',
    'england': 'https://flagcdn.com/w80/gb-eng.png',
    'croatia': 'https://flagcdn.com/w80/hr.png',
    'uzbekistan': 'https://flagcdn.com/w80/uz.png',
    'colombia': 'https://flagcdn.com/w80/co.png',
    'ghana': 'https://flagcdn.com/w80/gh.png',
    'panama': 'https://flagcdn.com/w80/pa.png',
};

function getFifaFixtureKickoffMs(game) {
    const localDate = game && game.local_date;
    if (!localDate) return Number.MAX_SAFE_INTEGER;

    const parts = localDate.trim().split(/\s+/);
    if (parts.length < 2) return Number.MAX_SAFE_INTEGER;

    const dateParts = parts[0].split('/').map(Number);
    const timeParts = parts[1].split(':').map(Number);
    if (dateParts.length < 3 || timeParts.length < 2) return Number.MAX_SAFE_INTEGER;

    const [month, day, year] = dateParts;
    const [hour, minute] = timeParts;
    const offset = FIFA_STADIUM_OFFSETS[String(game.stadium_id)] ?? -4;
    const kickoffMs = Date.UTC(year, month - 1, day, hour - offset, minute);
    return isNaN(kickoffMs) ? Number.MAX_SAFE_INTEGER : kickoffMs;
}

function getFifaFixtureSortMs(game) {
    const localDate = game && game.local_date;
    if (!localDate) return Number.MAX_SAFE_INTEGER;

    const parts = localDate.trim().split(/\s+/);
    if (parts.length < 2) return Number.MAX_SAFE_INTEGER;

    const dateParts = parts[0].split('/').map(Number);
    const timeParts = parts[1].split(':').map(Number);
    if (dateParts.length < 3 || timeParts.length < 2) return Number.MAX_SAFE_INTEGER;

    const [month, day, year] = dateParts;
    const [hour, minute] = timeParts;
    const sortMs = Date.UTC(year, month - 1, day, hour, minute);
    return isNaN(sortMs) ? Number.MAX_SAFE_INTEGER : sortMs;
}

function sortFifaFixturesByKickoff(games) {
    return games.slice().sort((a, b) => getFifaFixtureKickoffMs(a) - getFifaFixtureKickoffMs(b));
}

function formatFifaFixtureIst(kickoffMs) {
    if (!isFinite(kickoffMs) || kickoffMs === Number.MAX_SAFE_INTEGER) return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const istDate = new Date(kickoffMs + IST_OFFSET_MS);
    const day = istDate.getUTCDate();
    const month = months[istDate.getUTCMonth()];
    const hour = String(istDate.getUTCHours()).padStart(2, '0');
    const minute = String(istDate.getUTCMinutes()).padStart(2, '0');
    return `${day} ${month} ${hour}:${minute}`;
}

// Proactive background refresh of fixtures (every 2 minutes)
async function refreshFifaFixtures() {
    try {
        const [gamesRes, teamsRes] = await Promise.all([
            fetchJson('https://worldcup26.ir/get/games', 25000),
            fetchJson('https://worldcup26.ir/get/teams', 25000)
        ]);
        const games = gamesRes && gamesRes.games;
        const teams = teamsRes && teamsRes.teams;
        if (!Array.isArray(games)) return;

        // Auto-save to fallback files so data survives server restarts
        try {
            fs.writeFileSync(path.join(__dirname, 'api/fifa/fallback_games.json'), JSON.stringify({ games }, null, 2));
            if (Array.isArray(teams)) fs.writeFileSync(path.join(__dirname, 'api/fifa/fallback_teams.json'), JSON.stringify({ teams }, null, 2));
            const finished = games.filter(g => g.finished === 'TRUE').length;
            const live = games.filter(g => g.time_elapsed === 'live').length;
            console.log(`[fifa-refresh] Updated fallback data: ${games.length} games, ${finished} finished, ${live} live`);
        } catch(writeErr) {
            console.error('[fifa-refresh] Failed to save fallback:', writeErr.message);
        }

        // Build teams maps
        const teamsById = {}, teamsByName = {};
        if (Array.isArray(teams)) {
            teams.forEach(t => {
                if (t && t.id) {
                    const entry = { flag: t.flag || '' };
                    teamsById[String(t.id)] = entry;
                    if (t.name_en) teamsByName[t.name_en.toLowerCase()] = entry;
                }
            });
        }
        function getFlag(id, name) {
            const byId = teamsById[String(id)];
            if (byId && byId.flag) return byId.flag;
            const byName = teamsByName[(name || '').toLowerCase()];
            if (byName && byName.flag) return byName.flag;
            return COUNTRY_FLAG_MAP_SERVER[(name || '').toLowerCase()] || '';
        }
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const roundMap = { group: null, r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-Final', sf: 'Semi-Final', third: '3rd Place Play-off', final: 'Final' };
        const formatted = sortFifaFixturesByKickoff(games).map(g => {
            const stadium = STADIUM_MAP_SERVER[g.stadium_id] || { name: 'Stadium' };
            const round = g.type === 'group' ? `Group ${g.group}` : (roundMap[g.type] || g.group || 'World Cup 2026');
            const kickoffTs = getFifaFixtureKickoffMs(g);
            const friendlyDate = formatFifaFixtureIst(kickoffTs);
            const homeName = g.home_team_name_en || g.home_team_label || 'TBD';
            const awayName = g.away_team_name_en || g.away_team_label || 'TBD';
            return {
                id: g.id, homeTeam: homeName, awayTeam: awayName,
                homeFlag: getFlag(g.home_team_id, homeName),
                awayFlag: getFlag(g.away_team_id, awayName),
                homeScore: g.home_score || '0', awayScore: g.away_score || '0',
                localDate: friendlyDate, timezone: 'IST', kickoffTs, sortTs: kickoffTs, status: g.time_elapsed,
                finished: g.finished === 'TRUE', round, stadium: stadium.name
            };
        });
        cacheFixtures = formatted;
        cacheFixturesTime = Date.now();
    } catch(e) {
        console.error('[fifa-refresh] Failed to refresh fixtures:', e.message);
    }
}

// Start proactive background refresh every 2 minutes
if (!process.env.VERCEL) {
    setInterval(refreshFifaFixtures, 2 * 60 * 1000);
    // Also run immediately on startup
    setTimeout(refreshFifaFixtures, 3000);
}

// --- API: Fetch FIFA Fixtures ---
app.get('/api/fifa/fixtures', async (req, res) => {
    try {
        if (cacheFixtures && (Date.now() - cacheFixturesTime < 60000)) {
            return res.json(cacheFixtures);
        }
        const [gamesRes, teamsRes] = await Promise.all([
            fetchJson('https://worldcup26.ir/get/games', 25000),
            fetchJson('https://worldcup26.ir/get/teams', 25000)
        ]);
        const games = gamesRes && gamesRes.games;
        if (!Array.isArray(games)) {
            return res.json([]);
        }

        // Build teams map by ID and name for flag lookup
        const teamsById = {};
        const teamsByName = {};
        if (teamsRes && Array.isArray(teamsRes.teams)) {
            teamsRes.teams.forEach(t => {
                if (t && t.id) {
                    const entry = { flag: t.flag || '' };
                    teamsById[String(t.id)] = entry;
                    if (t.name_en) teamsByName[t.name_en.toLowerCase()] = entry;
                }
            });
        }

        function getFlag(id, name) {
            const byId = teamsById[String(id)];
            if (byId && byId.flag) return byId.flag;
            const byName = teamsByName[(name || '').toLowerCase()];
            if (byName && byName.flag) return byName.flag;
            return COUNTRY_FLAG_MAP_SERVER[(name || '').toLowerCase()] || '';
        }

        const formatted = sortFifaFixturesByKickoff(games).map(g => {
            const stadium = STADIUM_MAP_SERVER[g.stadium_id] || { name: 'Stadium', city: '', country: '' };
            const isFinished = g.finished === 'TRUE';
            const roundMap = { group: `Group ${g.group}`, r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-Final', sf: 'Semi-Final', third: '3rd Place Play-off', final: 'Final' };
            const round = roundMap[g.type] || g.group || 'World Cup 2026';
            
            const kickoffTs = getFifaFixtureKickoffMs(g);
            const friendlyDate = formatFifaFixtureIst(kickoffTs);

            const homeName = g.home_team_name_en || g.home_team_label || 'TBD';
            const awayName = g.away_team_name_en || g.away_team_label || 'TBD';

            return {
                id: g.id,
                homeTeam: homeName,
                awayTeam: awayName,
                homeFlag: getFlag(g.home_team_id, homeName),
                awayFlag: getFlag(g.away_team_id, awayName),
                homeScore: g.home_score || '0',
                awayScore: g.away_score || '0',
                localDate: friendlyDate,
                timezone: 'IST',
                kickoffTs,
                sortTs: kickoffTs,
                status: g.time_elapsed,
                finished: isFinished,
                round: round,
                stadium: stadium.name
            };
        });
        cacheFixtures = formatted;
        cacheFixturesTime = Date.now();
        // Auto-save fresh data to fallback files
        try {
            fs.writeFileSync(path.join(__dirname, 'api/fifa/fallback_games.json'), JSON.stringify({ games }, null, 2));
            if (teamsRes && Array.isArray(teamsRes.teams)) fs.writeFileSync(path.join(__dirname, 'api/fifa/fallback_teams.json'), JSON.stringify({ teams: teamsRes.teams }, null, 2));
        } catch(we) { /* silent */ }
        res.json(formatted);
    } catch (e) {
        console.error('Error fetching FIFA fixtures:', e.message);
        // Fallback: serve cached or static fallback with flags
        if (cacheFixtures) return res.json(cacheFixtures);
        // Build from local fallback files
        try {
            const fbGames = JSON.parse(fs.readFileSync(path.join(__dirname, 'api/fifa/fallback_games.json'), 'utf8')).games || [];
            const fbTeams = JSON.parse(fs.readFileSync(path.join(__dirname, 'api/fifa/fallback_teams.json'), 'utf8')).teams || [];
            const fbTeamsById = {};
            const fbTeamsByName = {};
            fbTeams.forEach(t => {
                if (t && t.id) {
                    fbTeamsById[String(t.id)] = { flag: t.flag || '' };
                    if (t.name_en) fbTeamsByName[t.name_en.toLowerCase()] = { flag: t.flag || '' };
                }
            });
            function getFlagFb(id, name) {
                const byId = fbTeamsById[String(id)];
                if (byId && byId.flag) return byId.flag;
                const byName = fbTeamsByName[(name || '').toLowerCase()];
                if (byName && byName.flag) return byName.flag;
                return COUNTRY_FLAG_MAP_SERVER[(name || '').toLowerCase()] || '';
            }
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const roundMap = { group: null, r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-Final', sf: 'Semi-Final', third: '3rd Place Play-off', final: 'Final' };
            const fallback = sortFifaFixturesByKickoff(fbGames).map(g => {
                const stadium = STADIUM_MAP_SERVER[g.stadium_id] || { name: 'Stadium' };
                const round = g.type === 'group' ? `Group ${g.group}` : (roundMap[g.type] || g.group || 'World Cup 2026');
                const kickoffTs = getFifaFixtureKickoffMs(g);
                const friendlyDate = formatFifaFixtureIst(kickoffTs);
                const homeName = g.home_team_name_en || g.home_team_label || 'TBD';
                const awayName = g.away_team_name_en || g.away_team_label || 'TBD';
                return {
                    id: g.id, homeTeam: homeName, awayTeam: awayName,
                    homeFlag: getFlagFb(g.home_team_id, homeName),
                    awayFlag: getFlagFb(g.away_team_id, awayName),
                    homeScore: g.home_score || '0', awayScore: g.away_score || '0',
                    localDate: friendlyDate, timezone: 'IST', kickoffTs, sortTs: kickoffTs, status: g.time_elapsed,
                    finished: g.finished === 'TRUE', round, stadium: stadium.name
                };
            });
            res.json(fallback);
        } catch(fe) {
            res.json([]);
        }
    }
});


// --- API: Fetch FIFA Standings ---
app.get('/api/fifa/standings', async (req, res) => {
    try {
        if (cacheStandings && (Date.now() - cacheStandingsTime < 30000)) {
            return res.json(cacheStandings);
        }
        const [groupsRes, teamsRes] = await Promise.all([
            fetchJson('https://worldcup26.ir/get/groups', 25000),
            fetchJson('https://worldcup26.ir/get/teams', 25000)
        ]);
        const groupsData = groupsRes && groupsRes.groups;
        const teamsData = teamsRes && teamsRes.teams;
        if (!Array.isArray(groupsData) || !Array.isArray(teamsData)) {
            return res.json([]);
        }
        const teamsMap = {};
        teamsData.forEach(t => {
            teamsMap[t.id] = {
                name: t.name_en,
                flag: t.flag,
                code: t.fifa_code
            };
        });
        const formatted = groupsData.map(g => {
            return {
                name: `Group ${g.name}`,
                teams: (g.teams || []).map(t => {
                    const teamInfo = teamsMap[t.team_id] || { name: `Team ${t.team_id}`, flag: '', code: '' };
                    return {
                        teamId: t.team_id,
                        name: teamInfo.name,
                        flag: teamInfo.flag,
                        code: teamInfo.code,
                        mp: parseInt(t.mp || 0),
                        w: parseInt(t.w || 0),
                        d: parseInt(t.d || 0),
                        l: parseInt(t.l || 0),
                        gf: parseInt(t.gf || 0),
                        ga: parseInt(t.ga || 0),
                        gd: parseInt(t.gd || 0),
                        pts: parseInt(t.pts || 0)
                    };
                }).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf)
            };
        });
        cacheStandings = formatted;
        cacheStandingsTime = Date.now();
        res.json(formatted);
    } catch (e) {
        console.error('Error fetching FIFA standings:', e.message);
        res.json(cacheStandings || []);
    }
});

// --- API: FIFA Poll (GET counts, POST vote) ---
app.use('/api/fifa/poll', require('./api/fifa/poll.js'));

// --- API: Sync Standings (Vercel cron handler) ---
app.all('/api/sync-standings', require('./api/sync-standings.js'));

// --- Custom Chat System SSE Broadcast ---
let sseClients = [];

function broadcastSSE(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(data);
    } catch (e) {
      // ignore write errors
    }
  });
}

// Listen to Firestore chat_messages changes on the backend using Admin SDK (which bypasses client rules)
if (db) {
  db.collection("chat_messages")
    .orderBy("timestamp", "desc")
    .limit(60)
    .onSnapshot(snapshot => {
      const msgs = [];
      snapshot.forEach(doc => {
        const d = doc.data();
        msgs.push({
          id: doc.id,
          username: d.username,
          text: d.text,
          timestamp: d.timestamp ? d.timestamp.toDate().getTime() : Date.now(),
          color: d.color || '#a970ff',
          isAdmin: !!d.isAdmin
        });
      });
      broadcastSSE({ type: 'chatList', data: msgs.reverse() });
    }, err => {
      console.error('Firestore chat listener error:', err);
    });
}

// SSE stream endpoint
app.get('/api/chat/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Add client to active clients list
  const client = { res };
  sseClients.push(client);

  // Send the current chat list immediately on connection if Firestore is loaded
  if (db) {
    db.collection("chat_messages")
      .orderBy("timestamp", "desc")
      .limit(60)
      .get()
      .then(snapshot => {
        const msgs = [];
        snapshot.forEach(doc => {
          const d = doc.data();
          msgs.push({
            id: doc.id,
            username: d.username,
            text: d.text,
            timestamp: d.timestamp ? d.timestamp.toDate().getTime() : Date.now(),
            color: d.color || '#a970ff',
            isAdmin: !!d.isAdmin
          });
        });
        res.write(`data: ${JSON.stringify({ type: 'chatList', data: msgs.reverse() })}\n\n`);
      })
      .catch(err => {
        console.error('Error fetching initial chat list for SSE:', err);
      });
  }

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== client);
  });
});

// Chat send endpoint
app.post('/api/chat/send', (req, res) => {
  const { username, text, color, isAdmin } = req.body;
  if (!text || !username) {
    return res.status(400).json({ error: 'Missing username or text' });
  }

  if (!db) {
    return res.status(500).json({ error: 'Database not initialized' });
  }

  db.collection("chat_messages").add({
    username: username,
    text: text,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    color: color || '#a970ff',
    isAdmin: !!isAdmin
  }).then(() => {
    res.json({ success: true });
  }).catch(err => {
    console.error('Error writing to Firestore:', err);
    res.status(500).json({ error: err.message });
  });
});

// Chat delete endpoint (moderation)
app.post('/api/chat/delete', (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing document id' });
  }

  if (!db) {
    return res.status(500).json({ error: 'Database not initialized' });
  }

  db.collection("chat_messages").doc(id).delete()
    .then(() => {
      res.json({ success: true });
    })
    .catch(err => {
      console.error('Error deleting from Firestore:', err);
      res.status(500).json({ error: err.message });
    });
});

// Chat clear endpoint (moderation)
app.post('/api/chat/clear', (req, res) => {
  if (!db) {
    return res.status(500).json({ error: 'Database not initialized' });
  }

  db.collection("chat_messages").get()
    .then(snapshot => {
      const batch = db.batch();
      snapshot.forEach(doc => {
        batch.delete(doc.ref);
      });
      return batch.commit();
    })
    .then(() => {
      res.json({ success: true });
    })
    .catch(err => {
      console.error('Error clearing Firestore collection:', err);
      res.status(500).json({ error: err.message });
    });
});

// Route for /admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Route for /fifa
app.get('/fifa', (req, res) => {
  res.sendFile(path.join(__dirname, 'fifa.html'));
});

// Route for /f1
app.get('/f1', (req, res) => {
  res.sendFile(path.join(__dirname, 'f1.html'));
});

// --- API: Status ---
app.get('/', (req, res) => {
  if (req.accepts('html')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.json({
      status: 'F1 Watch Party Backend Running',
      mode: scraper ? 'local (scraper enabled)' : 'vercel (scraper disabled)',
      activeSession: state.activeSession,
      weather: state.weather,
      scheduleCount: schedule2026.length
    });
  }
});

const HOST = process.argv.includes('--host') ? '0.0.0.0' : 'localhost';

app.listen(PORT, HOST, async () => {
  console.log(`🏎️  F1 Backend running at http://${HOST === '0.0.0.0' ? '0.0.0.0' : 'localhost'}:${PORT}`);
  if (!process.env.VERCEL) {
    console.log('Fetching initial session data...');
    await fetchLatestSession();
  }
});

module.exports = app;
