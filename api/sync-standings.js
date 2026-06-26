/**
 * /api/sync-standings — Vercel Serverless Function
 * Called automatically by Vercel Cron and manually from the admin panel.
 * Tries f1.com API first, falls back to Jolpica (official FIA data).
 */

const axios = require('axios');
const supabaseDb = require('./_supabase').db;
const cheerio = require('cheerio');
const pushembdz = require('./providers/pushembdz');

// Puppeteer-based helper to fetch JSON and bypass Cloudflare/DDoS blocks
async function fetchJsonWithPuppeteer(url, timeoutMs = 25000) {
  let browser;
  try {
    const puppeteer = eval("require('puppeteer')");
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    const text = await page.evaluate(() => document.body.innerText);
    try {
      return JSON.parse(text.trim());
    } catch (e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      throw e;
    }
  } catch (err) {
    console.error(`[fetchJsonWithPuppeteer] Puppeteer fetch failed for ${url}:`, err.message);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function fetchJson(url, timeoutMs = 25000) {
  if (url.includes('worldcup26.ir') && !process.env.VERCEL) {
    try {
      console.log(`[fetchJson] Using Puppeteer to fetch ${url}...`);
      const data = await fetchJsonWithPuppeteer(url, timeoutMs);
      return data;
    } catch (e) {
      console.log(`[fetchJson] Puppeteer failed for ${url}: ${e.message}. Falling back to Axios/curl.`);
    }
  }

  try {
    // Try Axios first (much faster and avoids process spawning overhead/hanging)
    const { data } = await axios.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://streamed.st/category/football'
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


// Firebase Admin initialization removed in V2 in favor of Supabase.

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

    if (searchTokens.length === 0) {
      console.log('[sync] No search tokens derived — skipping stream fetch.');
      return;
    }

    const targetUrl = config.streamProxyUrl || pushembdz.API_URL;
    console.log(`[sync] Fetching pushembdz stream list from: ${targetUrl} for tokens: ${searchTokens.join(', ')}`);

    // ── Fetch with retry ────────────────────────────────────────────────────
    let rawData = null;
    let fetchError = null;
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 1500;
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        const { data, status } = await axios.get(targetUrl, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept': 'application/json, */*',
            'Referer': 'https://pushembdz.store/',
            'Origin': 'https://pushembdz.store',
          },
          validateStatus: () => true,
        });
        console.log(`[sync] API attempt ${attempt}: HTTP ${status}`);
        if (status === 200) { rawData = data; break; }
        if (attempt <= MAX_RETRIES && (status === 429 || status === 503)) {
          console.log(`[sync] Rate-limited (${status}), retrying in ${RETRY_DELAY_MS}ms…`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        } else {
          throw new Error(`pushembdz API returned HTTP ${status}`);
        }
      } catch (err) {
        fetchError = err;
        if (attempt <= MAX_RETRIES) {
          console.warn(`[sync] Fetch attempt ${attempt} failed: ${err.message}. Retrying…`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    if (!rawData) {
      throw new Error(`All fetch attempts failed for pushembdz API: ${fetchError ? fetchError.message : 'unknown error'}`);
    }

    // ── Parse + normalise (applies embed URL fix automatically) ─────────────
    const { streams: allStreams, warnings } = pushembdz.parseResponse(rawData);
    if (warnings.length) console.warn('[sync] pushembdz parse warnings:', warnings);
    console.log(`[sync] pushembdz: ${allStreams.length} total streams parsed`);

    // ── Match streams by search tokens ──────────────────────────────────────
    let matched = allStreams.filter(s => pushembdz.scoreStream(s, searchTokens) === 100);

    if (matched.length === 0) {
      // Fallback: strip session-type tokens, keep sport+location
      const coreTokens = searchTokens.filter(t =>
        !['fp1', 'fp2', 'fp3', 'practice', 'qualifying', 'qualy', 'qual', 'sprint', 'race'].includes(t)
      );
      if (coreTokens.length > 0) {
        matched = allStreams.filter(s => pushembdz.scoreStream(s, coreTokens) === 100);
        console.log(`[sync] Fallback match with core tokens [${coreTokens.join(', ')}]: ${matched.length} results`);
      }
    }

    if (matched.length > 0) {
      const newLinks = matched.map((s, index) => ({
        name: s.label,
        id: `src_${Date.now()}_${index}`,
        url: s.embedUrl,   // ← always the corrected, working pushembdz.store/embed/… URL
      }));

      await ref.update({ streamLinks: newLinks });
      console.log(`[sync] ✅ Updated ${newLinks.length} stream link(s) for tokens: ${searchTokens.join(' ')}`);
      newLinks.forEach((l, i) => console.log(`  [${i+1}] ${l.name} → ${l.url}`));
    } else {
      console.log(`[sync] ⚠  No streams matched tokens: ${searchTokens.join(', ')}`);
      console.log(`[sync] Available stream titles: ${allStreams.map(s => s.title).join(' | ')}`);
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

function getFifaGameStatus(game) {
  const raw = String(game && game.time_elapsed || '').trim().toLowerCase();
  let isFinished = String(game && game.finished || '').toUpperCase() === 'TRUE' ||
    raw === 'finished' ||
    raw === 'ft';

  // Check if kickoff was over 2.5 hours ago
  try {
    const localDate = game && game.local_date;
    if (localDate) {
      const STADIUM_OFFSETS = {
        '1': -6, '2': -6, '3': -6, '4': -5, '5': -5, '6': -5, '7': -4, '8': -4, '9': -4, '10': -4, '11': -4, '12': -4, '13': -7, '14': -7, '15': -7, '16': -7,
      };
      const [datePart, timePart] = localDate.trim().split(/\s+/);
      if (datePart && timePart) {
        const [month, day, year] = datePart.split('/').map(Number);
        const [hour, minute] = timePart.split(':').map(Number);
        const offset = STADIUM_OFFSETS[String(game.stadium_id)] || -4;
        const kickoffMs = Date.UTC(year, month - 1, day, hour - offset, minute);
        if (!isNaN(kickoffMs) && (Date.now() - kickoffMs) > 2.5 * 60 * 60 * 1000) {
          isFinished = true;
        }
      }
    }
  } catch (err) {
    console.error('[getFifaGameStatus] Kickoff parse error:', err.message);
  }

  const isNotStarted = !isFinished && (
    raw === 'notstarted' ||
    raw === 'not started' ||
    raw === 'ns' ||
    raw === ''
  );

  const isLive = !isFinished && !isNotStarted && (
    raw === 'live' ||
    raw === 'ht' ||
    raw.includes("'") ||
    /^\d+$/.test(raw)
  );

  return {
    status: isLive ? 'live' : (isFinished ? 'finished' : 'notstarted'),
    isLive,
    isFinished
  };
}

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
    const responseData = await fetchJson('https://worldcup26.ir/get/games', 12000);
    games = responseData && responseData.games;
  } catch (err) {
    console.error('[sync-fifa-details] FIFA details API fetch failed, trying local fallback file:', err.message);
    try {
      const fbGamesData = require('./fifa/fallback_games.json');
      games = fbGamesData.games;
      console.log(`[sync-fifa-details] Loaded ${games ? games.length : 0} games from fallback file.`);
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
    const liveGame = games.find(g => getFifaGameStatus(g).isLive);
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
        .filter(g => getFifaGameStatus(g).status === 'notstarted')
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

    // Kickoff datetime for timer - prefer manual custom target if set
    const kickoffMs = (fifa.customTimer && fifa.customTimer.isManual && fifa.customTimer.target)
      ? new Date(fifa.customTimer.target).getTime()
      : parseGameDate(chosen.local_date, chosen.stadium_id);
    const isoTarget = new Date(kickoffMs).toISOString();

    // Friendly date string formatted in IST for display (e.g. "13 Jun 23:30")
    const friendlyDate = formatFixtureIst(kickoffMs);

    const chosenStatus = getFifaGameStatus(chosen);
    const isLive = chosenStatus.isLive;
    const isFinished = chosenStatus.isFinished;
    const homeScore = chosen.home_score || '0';
    const awayScore = chosen.away_score || '0';

    let matchTime = '';
    if (isLive && kickoffMs) {
      const rawElapsed = String(chosen.time_elapsed || '').trim();
      const elapsedMins = /^\d+$/.test(rawElapsed)
        ? parseInt(rawElapsed, 10)
        : Math.floor((Date.now() - kickoffMs) / 60000);
      if (rawElapsed.toLowerCase() === 'ht') {
        matchTime = 'HT';
      } else if (elapsedMins < 0) {
        matchTime = '0\'';
      } else if (elapsedMins < 45) {
        matchTime = `${elapsedMins}'`;
      } else if (elapsedMins < 60) {
        matchTime = 'HT';
      } else if (elapsedMins < 105) {
        matchTime = `${elapsedMins - 15}'`;
      } else {
        matchTime = '90+\'';
      }
    } else if (isFinished) {
      matchTime = 'FT';
    }

    if (isLive) {
      const googleMatchTime = await fetchGoogleFifaMatchTime(matchName);
      if (googleMatchTime) matchTime = googleMatchTime;
    }

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
        matchTime: matchTime,
      },
      // Auto-update customTimer target to kickoff time (enable it too)
      customTimer: (currentFifa.customTimer && currentFifa.customTimer.isManual)
        ? currentFifa.customTimer
        : {
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

function tokenizeMatchTitle(title) {
  const commonWords = new Set(['vs', 'and', 'the', 'a', 'or', 'fc', 'united', 'city', 'real', 'de', 'la', 'st', 'stadium', 'opening', 'ceremony']);
  return String(title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !commonWords.has(t));
}

function scoreStreamedMatch(match, tokens) {
  if (!match || !match.title) return 0;
  const titleLower = match.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  if (!tokens || tokens.length === 0) return 1;
  return tokens.reduce((count, token) => count + (titleLower.includes(token) ? 1 : 0), 0);
}

function pickStreamedFootballMatch(matches, matchName) {
  const footballMatches = (Array.isArray(matches) ? matches : []).filter(m => m.category === 'football');
  if (footballMatches.length === 0) return null;

  const tokens = enrichTokens(tokenizeMatchTitle(matchName));
  const ranked = footballMatches
    .map(match => ({ match, score: scoreStreamedMatch(match, tokens) }))
    .filter(item => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.match.sources || []).length - (a.match.sources || []).length;
    });

  if (ranked[0]) return ranked[0].match;
  return tokens.length === 0 ? footballMatches[0] : null;
}

async function fetchStreamedFootballMatches(matchName, preferLiveOnly = false) {
  const endpoints = preferLiveOnly
    ? ['https://streamed.st/api/matches/live']
    : [
        'https://streamed.st/api/matches/live',
        'https://streamed.st/api/matches/all-today',
        'https://streamed.st/api/matches/all'
      ];

  for (const endpoint of endpoints) {
    try {
      const matches = await fetchJson(endpoint, 8000);
      if (!Array.isArray(matches)) continue;

      const selected = pickStreamedFootballMatch(matches, matchName);
      if (selected) {
        console.log(`[sync-fifa] Matched streamed.st football event from ${endpoint}: "${selected.title}"`);
        return { matches, selected, endpoint };
      }
    } catch (err) {
      console.error(`[sync-fifa] Failed to fetch ${endpoint}:`, err.message);
    }
  }

  return { matches: [], selected: null, endpoint: null };
}

async function resolveStreamedLinks(match) {
  if (!match || !Array.isArray(match.sources) || match.sources.length === 0) return [];

  const streamLinks = [];
  const streamPromises = match.sources.map(async (src) => {
    try {
      if (!src || !src.source || !src.id) return;
      if (['golf', 'tennis', 'nba', 'nhl', 'nfl', 'mlb', 'ufc', 'boxing', 'cricket', 'rugby', 'f1', 'motogp', 'motorsport'].includes(src.source.toLowerCase())) {
        return;
      }

      const streamUrl = `https://streamed.st/api/stream/${src.source}/${src.id}`;
      const streams = await fetchJson(streamUrl, 8000);
      if (Array.isArray(streams)) {
        streams.forEach((stream) => {
          if (stream.embedUrl) {
            const name = `${src.source.toUpperCase()} ${stream.language || 'EN'} ${stream.hd ? '(HD)' : ''}`.trim();
            streamLinks.push({
              name,
              id: `src_fifa_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              url: stream.embedUrl
            });
          }
        });
      }
    } catch (err) {
      console.error(`[sync-fifa] Failed to fetch streamed.st source ${src.source}:`, err.message);
    }
  });

  await Promise.all(streamPromises);
  return streamLinks;
}

function parseGoogleMatchTimeFromHtml(html, matchName) {
  const $ = cheerio.load(html || '');
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const teamTokens = tokenizeMatchTitle(matchName).filter(t => t.length > 2);
  const googleText = text.toLowerCase();
  const matchingTeams = teamTokens.filter(token => googleText.includes(token)).length;
  const hasTeams = teamTokens.length === 0 || matchingTeams >= Math.min(2, teamTokens.length);
  if (!hasTeams) return '';

  const patterns = [
    /\b(?:HT|FT|Full-time|Half-time)\b/i,
    /\b(?:\d{1,2}|90)(?:\+\d{1,2})?['’]/,
    /\b(?:\d{1,2}|90)(?:\+\d{1,2})?\s*min\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[0]) {
      const value = match[0].replace(/Full-time/i, 'FT').replace(/Half-time/i, 'HT').replace(/\s*min/i, "'");
      return value.replace('’', "'");
    }
  }

  return '';
}

async function fetchGoogleFifaMatchTime(matchName) {
  try {
    const query = matchName ? `fifa ${matchName}` : 'fifa live';
    const { data } = await axios.get('https://www.google.com/search', {
      timeout: 10000,
      params: { q: query, hl: 'en', gl: 'IN' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-IN,en;q=0.9'
      }
    });

    const matchTime = parseGoogleMatchTimeFromHtml(data, matchName);
    if (matchTime) {
      console.log(`[sync-fifa-google] Parsed match time from Google for "${matchName}": ${matchTime}`);
    } else {
      console.log(`[sync-fifa-google] No match time found in Google result for "${matchName}".`);
    }
    return matchTime;
  } catch (err) {
    console.error('[sync-fifa-google] Google match time fetch failed:', err.message);
    return '';
  }
}

async function syncFifaLiveFromStreamed(config, ref, options = {}) {
  const fifa = config.fifa || {};
  const currentRaceData = fifa.raceData || {};

  try {
    const { selected: selectedMatch } = await fetchStreamedFootballMatches(currentRaceData.name, true);
    if (!selectedMatch) {
      console.log('[sync-fifa-live] No live football match found on streamed.st.');
      return null;
    }

    const streamLinks = await resolveStreamedLinks(selectedMatch);
    const teams = selectedMatch.teams || {};
    const homeName = teams.home?.name || String(selectedMatch.title || '').split(/\s+vs\s+/i)[0] || 'TBD';
    const awayName = teams.away?.name || String(selectedMatch.title || '').split(/\s+vs\s+/i)[1] || 'TBD';
    const matchName = selectedMatch.title || `${homeName} vs ${awayName}`;
    const kickoffDate = selectedMatch.date ? new Date(selectedMatch.date) : null;
    const googleMatchTime = await fetchGoogleFifaMatchTime(matchName);

    const updatedFifa = {
      ...fifa,
      raceData: {
        ...currentRaceData,
        name: matchName,
        round: currentRaceData.round || 'Live Football',
        circuit: currentRaceData.circuit || 'streamed.st',
        location: currentRaceData.location || 'Live',
        date: kickoffDate && !isNaN(kickoffDate.getTime()) ? formatFixtureIst(kickoffDate.getTime()) : (currentRaceData.date || ''),
        isLive: true,
        isFinished: false,
        matchTime: googleMatchTime || currentRaceData.matchTime || 'LIVE'
      },
      customTimer: (fifa.customTimer && fifa.customTimer.isManual)
        ? fifa.customTimer
        : {
            ...(fifa.customTimer || {}),
            enabled: true,
            target: kickoffDate && !isNaN(kickoffDate.getTime()) ? kickoffDate.toISOString() : new Date().toISOString(),
            label: 'LIVE NOW'
          },
      streamLinks
    };

    await ref.update({ fifa: updatedFifa });
    console.log(`[sync-fifa-live] Updated FIFA live match from streamed.st: "${matchName}" with ${streamLinks.length} stream links.`);
    return updatedFifa;
  } catch (err) {
    console.error('[sync-fifa-live] streamed.st live sync failed:', err.message);
    if (options.throwOnError) throw err;
    return null;
  }
}

async function syncFifaStreams(config, ref, options = {}) {
  const fifa = config.fifa || {};
  const isManual = !!options.manual;
  console.log('[sync-fifa] Starting FIFA stream sync. config.fifa exists:', !!config.fifa, 'autoSyncStreams:', fifa.autoSyncStreams);
  if (fifa.autoSyncStreams === false && !isManual) {
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
    if (!isManual && !isLive && (kickoffMs - now_s) > 10 * 60 * 1000) {
      console.log('[sync-fifa] Next match is >10 minutes away and not live. Clearing stale stream links.');
      const updatedFifa = { ...fifa, streamLinks: [] };
      await ref.update({ fifa: updatedFifa });
      return;
    } else if (isManual && !isLive && (kickoffMs - now_s) > 10 * 60 * 1000) {
      console.log('[sync-fifa] Manual stream sync requested before the 10-minute live window; searching streams anyway.');
    }
  }

  const tokens = enrichTokens(tokenizeMatchTitle(matchName));

  if (tokens.length === 0) {
    console.log('[sync-fifa] No valid search tokens extracted from:', matchName);
    return;
  }

  try {
    console.log(`[sync-fifa] Fetching live streamed.st matches to match tokens: ${tokens.join(' ')}`);
    let matches = await fetchJson('https://streamed.st/api/matches/live', 8000);

    if (!Array.isArray(matches)) {
      console.log('[sync-fifa] Live matches response is not an array. Falling back to all matches.');
      matches = await fetchJson('https://streamed.st/api/matches/all', 8000);
      if (!Array.isArray(matches)) {
        console.log('[sync-fifa] Matches response is not an array.');
        return;
      }
    }

    // Filter by category: football
    const footballMatches = matches.filter(m => m.category === 'football');

    // Find and rank all candidate matches
    let candidates = [];
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
      const fallbackEndpoints = [
        'https://streamed.st/api/matches/all-today',
        'https://streamed.st/api/matches/all'
      ];

      for (const endpoint of fallbackEndpoints) {
        try {
          const fallbackMatches = await fetchJson(endpoint, 8000);
          if (!Array.isArray(fallbackMatches)) continue;

          candidates = fallbackMatches
            .filter(m => m.category === 'football' && m.title)
            .map(match => ({ match, count: scoreStreamedMatch(match, tokens) }))
            .filter(item => item.count > 0);

          if (candidates.length > 0) {
            console.log(`[sync-fifa] Found ${candidates.length} matching candidates from ${endpoint}.`);
            break;
          }
        } catch (err) {
          console.error(`[sync-fifa] Failed fallback endpoint ${endpoint}:`, err.message);
        }
      }
    }

    if (candidates.length === 0) {
      console.log('[sync-fifa] No matching football matches found on streamed.st. Preserving existing stream links.');
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
            const streamUrl = `https://streamed.st/api/stream/${src.source}/${src.id}`;
            const streams = await fetchJson(streamUrl, 8000);
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

    if (!selectedMatch || resolvedStreamLinks.length === 0) {
      const fallbackEndpoints = [
        'https://streamed.st/api/matches/all-today',
        'https://streamed.st/api/matches/all'
      ];

      for (const endpoint of fallbackEndpoints) {
        try {
          const fallbackMatches = await fetchJson(endpoint, 8000);
          if (!Array.isArray(fallbackMatches)) continue;

          const fallbackCandidates = fallbackMatches
            .filter(m => m.category === 'football' && m.title)
            .map(match => ({ match, count: scoreStreamedMatch(match, tokens) }))
            .filter(item => item.count > 0)
            .sort((a, b) => {
              if (b.count !== a.count) return b.count - a.count;
              return (b.match.sources || []).length - (a.match.sources || []).length;
            });

          for (const candidate of fallbackCandidates) {
            const links = await resolveStreamedLinks(candidate.match);
            if (links.length > 0) {
              selectedMatch = candidate.match;
              resolvedStreamLinks = links;
              console.log(`[sync-fifa] Resolved ${links.length} links from fallback ${endpoint} using "${candidate.match.title}".`);
              break;
            }
          }

          if (selectedMatch && resolvedStreamLinks.length > 0) break;
        } catch (err) {
          console.error(`[sync-fifa] Failed stream fallback ${endpoint}:`, err.message);
        }
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
      console.log('[sync-fifa] None of the candidate matches yielded active stream URLs. Preserving existing links.');
    }
  } catch (err) {
    console.error('[sync-fifa] Error during auto-sync:', err.message);
    throw err;
  }
}

async function fetchWeather(location) {
  const weather = { air: 0, track: 0, condition: 'sunny' };
  try {
    const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, { timeout: 8000 });
    if (data && data.current_condition && data.current_condition[0]) {
      let temp = parseInt(data.current_condition[0].temp_C || 0);
      let desc = (data.current_condition[0].weatherDesc && data.current_condition[0].weatherDesc[0] && data.current_condition[0].weatherDesc[0].value || '').toLowerCase();
      
      weather.air = temp;
      weather.track = temp + Math.floor(Math.random() * 8) + 4;
      
      if (desc.includes('rain') || desc.includes('drizzle') || desc.includes('shower')) weather.condition = 'rain';
      else if (desc.includes('cloud') || desc.includes('overcast')) weather.condition = 'cloudy';
      else if (desc.includes('storm') || desc.includes('thunder')) weather.condition = 'storm';
      else weather.condition = 'sunny';
    }
  } catch(e) {
    console.error('[sync-standings API] Weather fetch error:', e.message);
  }
  return weather;
}

async function syncF1LiveAndWeather(config, ref) {
  try {
    console.log('[sync-standings API] Fetching latest OpenF1 session...');
    const { data } = await axios.get('https://api.openf1.org/v1/sessions?session_key=latest', { timeout: 8000 });
    if (data && data.length > 0) {
      const s = data[0];
      const activeSession = {
        name: s.session_name,
        key: s.session_key,
        location: s.location,
        circuit: s.circuit_short_name || s.location,
        date: s.date_start,
        status: s.status
      };
      
      let weatherObj = { air: 0, track: 0, condition: 'sunny' };
      if (activeSession.location) {
        weatherObj = await fetchWeather(activeSession.location);
      }

      // Check schedule live state
      let scheduleIsLive = false;
      if (Array.isArray(config.schedule)) {
        const nowMs = Date.now();
        config.schedule.forEach(sess => {
          if (sess.timer) {
            const start = new Date(sess.timer).getTime();
            if (!isNaN(start)) {
              let end = start + (2 * 60 * 60 * 1000); // 2 hours
              if (sess.endTime && sess.endTime.includes(':')) {
                const parts = sess.endTime.split(':');
                const d = new Date(sess.timer);
                d.setHours(parseInt(parts[0]), parseInt(parts[1]), 0);
                end = d.getTime();
                if (end < start) end += 86400000;
              }
              if (nowMs >= start && nowMs < end) {
                scheduleIsLive = true;
              }
            }
          }
        });
      }

      const isLiveRaceActive = (s.status === 'active') || scheduleIsLive;

      await ref.update({
        weather: weatherObj,
        isLiveRaceActive: isLiveRaceActive,
        lastF1LiveSync: new Date().toISOString()
      });
      console.log(`[sync-standings API] F1 Live update complete. isLiveRaceActive=${isLiveRaceActive}`);
    }
  } catch (err) {
    console.error('[sync-standings API] F1 Live/Weather sync error:', err.message);
  }
}


const memoryPolls = {};

module.exports = async (req, res) => {
  console.log(`[sync-standings API] Received request: ${req.method} ${req.url}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const requestedType = req.query.type;

  // ── LIVE-CONFIG: return Supabase config directly ──────────────────
  if (requestedType === 'liveconfig') {
    try {
      const config = await supabaseDb.getConfig();
      return res.json(config);
    } catch (e) {
      console.warn('[sync-standings liveconfig] Supabase error:', e.message);
      return res.json({});
    }
  }

  // ── FETCH-STREAMS: proxy pushembdz.store stream list ──────────────────────
  // Returns normalised streams with corrected embed URLs (api.→www subdomain fix).
  if (requestedType === 'fetchstreams') {
    try {
      const { data, status } = await axios.get(pushembdz.API_URL, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'application/json, */*',
          'Referer': 'https://pushembdz.store/',
          'Origin': 'https://pushembdz.store',
        },
        validateStatus: () => true,
      });
      if (status !== 200) {
        return res.status(502).json({ error: `pushembdz API returned HTTP ${status}` });
      }
      const { streams, warnings } = pushembdz.parseResponse(data);
      // Return the same shape the admin panel expects, but with corrected URLs
      return res.json({
        status: true,
        count: streams.length,
        warnings,
        // Reconstruct categories shape for backward-compatibility with admin panel
        categories: (data.categories || []).map(cat => ({
          ...cat,
          streams: (cat.streams || []).map(s => ({
            ...s,
            link: pushembdz.fixEmbedUrl(s.link),  // ← corrected URL
          })),
        })),
        // Also expose flat normalised list for convenience
        streams: streams.map(s => ({
          id: s.id,
          title: s.title,
          label: s.label,
          category: s.category,
          method: s.method,
          embedUrl: s.embedUrl,
        })),
      });
    } catch (e) {
      console.error('[sync-standings fetchstreams] Error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── FIFA POLL: GET/POST vote counts ───────────────────────────────────────
  if (requestedType === 'fifapoll') {
    const matchId = req.query.matchId || (req.body && req.body.matchId);
    const voterId = req.query.voterId || (req.body && req.body.voterId) || 'anonymous';
    if (!matchId || typeof matchId !== 'string' || matchId.length > 80) return res.status(400).json({ error: 'Invalid matchId' });

    if (req.method === 'GET') {
      try {
        const poll = await supabaseDb.getPoll(matchId);
        return res.json(poll);
      } catch (e) {
        return res.status(500).json({ error: 'Failed to read poll' });
      }
    }
    if (req.method === 'POST') {
      const choice = req.body && req.body.choice;
      if (!['home','away','draw'].includes(choice)) return res.status(400).json({ error: 'Invalid choice' });

      try {
        const result = await supabaseDb.castVote(matchId, voterId, choice);
        return res.json(result);
      } catch (e) {
        return res.status(500).json({ error: 'Failed to record vote' });
      }
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!['GET','POST'].includes(req.method)) {
    console.log(`[sync-standings API] Invalid method: ${req.method}`);
    return res.status(405).end();
  }

  try {
    console.log('[sync-standings API] Accessing Supabase...');
    let config = {};
    try {
      config = await supabaseDb.getConfig();
    } catch (dbErr) {
      console.warn('[sync-standings API] Supabase config load failed:', dbErr.message);
    }

    const ref = {
      update: async (data) => {
        try {
          await supabaseDb.updateConfig(data);
          for (const k in data) {
            config[k] = data[k];
          }
        } catch (e) {
          console.warn('[sync-standings API] Supabase update failed:', e.message);
        }
      },
      set: async (data, options) => {
        try {
          await supabaseDb.setConfig(data, options);
          if (options && options.merge) {
            for (const k in data) {
              config[k] = data[k];
            }
          } else {
            config = data;
          }
        } catch (e) {
          console.warn('[sync-standings API] Supabase set failed:', e.message);
        }
      },
      get: async () => {
        return {
          exists: true,
          data: () => config
        };
      }
    };

    const runAll = !requestedType;

    // 0. Sync F1 Live and Weather info
    if (runAll || requestedType === 'f1live' || requestedType === 'standings') {
      try {
        await syncF1LiveAndWeather(config, ref);
      } catch (err) {
        console.error('[sync-standings API] F1 Live/Weather sync failed:', err.message);
      }
    }

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
    let streamedLiveSynced = false;
    if (runAll || requestedType === 'fifadetails' || (requestedType === 'fifastreams' && req.query.manual === 'true')) {
      const fifa = config.fifa || {};
      const shouldSync = fifa.autoSyncDetails !== false || req.query.manual === 'true';
      if (shouldSync) {
        console.log('[sync-standings API] Starting FIFA streamed.st live sync...');
        try {
          updatedFifaConfig = await syncFifaLiveFromStreamed(config, ref);
          if (updatedFifaConfig) {
            console.log('[sync-standings API] FIFA live config updated from streamed.st.');
            config = { ...config, fifa: updatedFifaConfig };
            streamedLiveSynced = true;
            fifaDetailsSynced = true;
          }
        } catch (err) {
          console.error('[sync] streamed.st FIFA live sync error:', err.message);
          fifaDetailsError = err.message;
        }

        if (!updatedFifaConfig) {
          console.log('[sync-standings API] No streamed.st live match found. Falling back to FIFA details sync...');
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
      } else {
        console.log('[sync-standings API] FIFA details auto-sync is disabled. Skipping.');
      }
    }

    // 4. Automatically sync FIFA streams from streamed.st
    let fifaStreamsSynced = false;
    let fifaStreamsError = null;
    if (runAll || requestedType === 'fifastreams') {
      console.log('[sync-standings API] Starting FIFA streams sync...');
      try {
        if (streamedLiveSynced && config.fifa && Array.isArray(config.fifa.streamLinks) && config.fifa.streamLinks.length > 0) {
          console.log('[sync-standings API] FIFA streams already updated by streamed.st live sync.');
        } else {
          await syncFifaStreams(config, ref, { manual: req.query.manual === 'true' });
        }
        console.log('[sync-standings API] FIFA streams sync complete.');
        fifaStreamsSynced = true;
      } catch (err) {
        console.error('[sync] FIFA streams auto-sync error:', err.message);
        fifaStreamsError = err.message;
      }
    }

    const finalDoc = await ref.get();
    const finalConfig = finalDoc.exists ? finalDoc.data() : config;

    console.log('[sync-standings API] Sending response...');
    res.json({
      ok: true,
      sync: {
        standings: { synced: standingsSynced, updated: changed, syncedAt, source, error: standingsError },
        f1Streams: { synced: f1StreamsSynced, error: f1StreamsError },
        fifaDetails: { synced: fifaDetailsSynced, source: streamedLiveSynced ? 'streamed.st' : 'worldcup26.ir', error: fifaDetailsError },
        fifaStreams: { synced: fifaStreamsSynced, error: fifaStreamsError }
      },
      data: {
        standings: finalConfig.standings || [],
        constructors: finalConfig.constructors || [],
        lastStandingsSync: finalConfig.lastStandingsSync || syncedAt,
        standingsSource: finalConfig.standingsSource || source,
        streamLinks: finalConfig.streamLinks || [],
        fifa: finalConfig.fifa || {}
      },
      standings: { synced: standingsSynced, updated: changed, syncedAt, source, error: standingsError },
      f1Streams: { synced: f1StreamsSynced, error: f1StreamsError },
      fifaDetails: { synced: fifaDetailsSynced, source: streamedLiveSynced ? 'streamed.st' : 'worldcup26.ir', error: fifaDetailsError },
      fifaStreams: { synced: fifaStreamsSynced, error: fifaStreamsError }
    });
  } catch(err) {
    console.error('[sync-standings API] Error in main sync handler:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }

};
