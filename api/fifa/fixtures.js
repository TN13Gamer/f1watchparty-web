const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { fetchFotmobLiveScores } = require('./fotmob');

// Puppeteer-based helper to bypass Cloudflare DDoS protection
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
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw e;
    }
  } catch (err) {
    console.error(`[fetchJsonWithPuppeteer] Failed for ${url}:`, err.message);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

// Helper to fetch JSON with high timeout and Puppeteer/curl fallbacks to bypass DDoS-guard blocks
async function fetchJson(url, timeoutMs = 4000) {
  const cappedTimeout = Math.min(timeoutMs, 4000);

  if (url.includes('worldcup26.ir') && !process.env.VERCEL) {
    try {
      return await fetchJsonWithPuppeteer(url, cappedTimeout);
    } catch (e) {
      console.log(`[fetchJson] Puppeteer failed for ${url}: ${e.message}. Falling back to Axios.`);
    }
  }
  try {
    const { data } = await axios.get(url, {
      timeout: cappedTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://streamed.pk/category/football'
      }
    });
    return data;
  } catch (e) {
    const isTimeout = e.code === 'ECONNABORTED' || e.message.includes('timeout');
    if (process.env.VERCEL || isTimeout) {
      throw new Error(`Axios failed: ${e.message}`);
    }

    console.log(`[fetchJson] Axios failed for ${url}: ${e.message}. Falling back to curl.`);
    try {
      const { exec } = require('child_process');
      return await new Promise((resolve, reject) => {
        const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
        const cmd = `${curlCmd} -s -L -m ${Math.ceil(cappedTimeout / 1000)} -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "${url}"`;
        exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: cappedTimeout }, (error, stdout, stderr) => {
          if (error) return reject(error);
          try {
            resolve(JSON.parse(stdout));
          } catch (jsonErr) {
            reject(new Error(`Failed to parse JSON from curl: ${jsonErr.message}`));
          }
        });
      });
    } catch (curlErr) {
      throw new Error(`Both Axios and curl failed. Axios: ${e.message}. Curl: ${curlErr.message}`);
    }
  }
}

const STADIUM_MAP = {
    '1':  { name: 'Estadio Azteca' },
    '2':  { name: 'Estadio Akron' },
    '3':  { name: 'Estadio BBVA' },
    '4':  { name: 'AT&T Stadium' },
    '5':  { name: 'NRG Stadium' },
    '6':  { name: 'GEHA Field at Arrowhead Stadium' },
    '7':  { name: 'Mercedes-Benz Stadium' },
    '8':  { name: 'Hard Rock Stadium' },
    '9':  { name: 'Gillette Stadium' },
    '10': { name: 'Lincoln Financial Field' },
    '11': { name: 'MetLife Stadium' },
    '12': { name: 'BMO Field' },
    '13': { name: 'BC Place' },
    '14': { name: 'Lumen Field' },
    '15': { name: "Levi's Stadium" },
    '16': { name: 'SoFi Stadium' },
};

const STADIUM_OFFSETS = {
    '1': -6,
    '2': -6,
    '3': -6,
    '4': -5,
    '5': -5,
    '6': -5,
    '7': -4,
    '8': -4,
    '9': -4,
    '10': -4,
    '11': -4,
    '12': -4,
    '13': -7,
    '14': -7,
    '15': -7,
    '16': -7,
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

let cache = null;
let lastFetched = 0;
const CACHE_TTL = 30 * 1000; // 30 seconds – short TTL so live scores update quickly

// Load initial fallback data
let fallbackGames = [];
let fallbackTeams = [];
try {
    const gamesJson = require('./fallback_games.json');
    const teamsJson = require('./fallback_teams.json');
    fallbackGames = gamesJson.games || [];
    fallbackTeams = teamsJson.teams || [];
} catch (e) {
    console.error('Failed to load local FIFA fallback files:', e.message);
}

// Hardcoded country name -> flag URL map using flagcdn.com for common countries
const COUNTRY_FLAG_MAP = {
    'mexico': 'https://flagcdn.com/w80/mx.png',
    'south africa': 'https://flagcdn.com/w80/za.png',
    'south korea': 'https://flagcdn.com/w80/kr.png',
    'czech republic': 'https://flagcdn.com/w80/cz.png',
    'canada': 'https://flagcdn.com/w80/ca.png',
    'bosnia and herzegovina': 'https://flagcdn.com/w80/ba.png',
    'united states': 'https://flagcdn.com/w80/us.png',
    'usa': 'https://flagcdn.com/w80/us.png',
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

function getFlagByName(name) {
    if (!name) return '';
    return COUNTRY_FLAG_MAP[name.toLowerCase()] || '';
}

function getFixtureKickoffMs(game) {
    const localDate = game && game.local_date;
    if (!localDate) return Number.MAX_SAFE_INTEGER;

    const parts = localDate.trim().split(/\s+/);
    if (parts.length < 2) return Number.MAX_SAFE_INTEGER;

    const dateParts = parts[0].split('/').map(Number);
    const timeParts = parts[1].split(':').map(Number);
    if (dateParts.length < 3 || timeParts.length < 2) return Number.MAX_SAFE_INTEGER;

    const [month, day, year] = dateParts;
    const [hour, minute] = timeParts;
    const offset = STADIUM_OFFSETS[String(game.stadium_id)] ?? -4;
    const kickoffMs = Date.UTC(year, month - 1, day, hour - offset, minute);
    return isNaN(kickoffMs) ? Number.MAX_SAFE_INTEGER : kickoffMs;
}

function getFixtureSortMs(game) {
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

function getGameStatus(game) {
    const raw = String(game && game.time_elapsed || '').trim().toLowerCase();
    const isFinished = String(game && game.finished || '').toUpperCase() === 'TRUE' ||
        raw === 'finished' ||
        raw === 'ft';

    const isNotStarted = raw === 'notstarted' ||
        raw === 'not started' ||
        raw === 'ns' ||
        raw === '';

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

// Normalize team name for FotMob map lookup
function normName(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function formatData(games, teamsData, fotmobMap) {
    fotmobMap = fotmobMap || {};
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const roundMap = {
        group: null, // filled below
        r32: 'Round of 32',
        r16: 'Round of 16',
        qf: 'Quarter-Final',
        sf: 'Semi-Final',
        third: '3rd Place Play-off',
        final: 'Final'
    };

    // Build ID-based and name-based lookup maps
    const teamsById = {};
    const teamsByName = {};
    if (Array.isArray(teamsData)) {
        teamsData.forEach(t => {
            if (t && t.id) {
                const entry = { name: t.name_en, flag: t.flag || '', code: t.fifa_code };
                teamsById[String(t.id)] = entry;
                if (t.name_en) teamsByName[t.name_en.toLowerCase()] = entry;
            }
        });
    }

    function lookupTeam(id, nameFromGame) {
        // 1) Try by ID
        const byId = teamsById[String(id)];
        if (byId && byId.flag) return byId;

        // 2) Try by name from game data against teams API
        const nameKey = (nameFromGame || '').toLowerCase();
        const byName = teamsByName[nameKey];
        if (byName && byName.flag) return byName;

        // 3) Hardcoded country flag fallback
        const hardcodedFlag = getFlagByName(nameFromGame);
        return { name: nameFromGame || 'TBD', flag: hardcodedFlag, code: '' };
    }

    const now = Date.now();
    return games.slice().sort((a, b) => getFixtureKickoffMs(a) - getFixtureKickoffMs(b)).map(g => {
        const stadium = STADIUM_MAP[g.stadium_id] || { name: 'Stadium' };
        const round = g.type === 'group'
            ? `Group ${g.group}`
            : (roundMap[g.type] || g.group || 'World Cup 2026');

        const kickoffTs = getFixtureKickoffMs(g);
        const friendlyDate = formatFixtureIst(kickoffTs);
        const homeInfo = lookupTeam(g.home_team_id, g.home_team_name_en || g.home_team_label);
        const awayInfo = lookupTeam(g.away_team_id, g.away_team_name_en || g.away_team_label);

        // --- FotMob live score overlay ---
        const fmKey = normName(homeInfo.name) + '|' + normName(awayInfo.name);
        const fmData = fotmobMap[fmKey];

        const gameStatus = getGameStatus(g);
        let isFinished = gameStatus.isFinished;
        let isLive = gameStatus.isLive;
        let matchTime = '';
        let homeScore = g.home_score || '0';
        let awayScore = g.away_score || '0';

        if (fmData) {
            // FotMob data is authoritative for live and finished matches
            homeScore = fmData.homeScore;
            awayScore = fmData.awayScore;
            if (fmData.status === 'live') { isLive = true; isFinished = false; }
            else if (fmData.status === 'finished') { isFinished = true; isLive = false; }
            else if (fmData.status === 'notstarted') { isLive = false; isFinished = false; }
            matchTime = fmData.matchTime;
        } else {
            if (isLive && kickoffTs && kickoffTs !== Number.MAX_SAFE_INTEGER) {
                const rawElapsed = String(g.time_elapsed || '').trim();
                const elapsedMins = /^\d+$/.test(rawElapsed)
                    ? parseInt(rawElapsed, 10)
                    : Math.floor((now - kickoffTs) / 60000);
                if (String(g.time_elapsed || '').trim().toLowerCase() === 'ht') matchTime = 'HT';
                else if (elapsedMins < 0) matchTime = "0'";
                else if (elapsedMins < 45) matchTime = elapsedMins + "'";
                else if (elapsedMins < 60) matchTime = 'HT';
                else if (elapsedMins < 105) matchTime = (elapsedMins - 15) + "'";
                else matchTime = "90+'";
            } else if (isFinished) {
                matchTime = 'FT';
            }
        }

        const derivedStatus = isLive ? 'live' : (isFinished ? 'finished' : 'notstarted');

        return {
            id: g.id,
            homeTeam: homeInfo.name,
            awayTeam: awayInfo.name,
            homeFlag: homeInfo.flag,
            awayFlag: awayInfo.flag,
            homeCode: homeInfo.code,
            awayCode: awayInfo.code,
            homeScore,
            awayScore,
            localDate: friendlyDate,
            timezone: 'IST',
            kickoffTs,
            sortTs: kickoffTs,
            status: derivedStatus,
            finished: isFinished,
            round,
            stadium: stadium.name,
            matchTime,
            liveSource: fmData ? 'fotmob' : 'worldcup26'
        };
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, s-maxage=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const now = Date.now();
    if (cache && (now - lastFetched < CACHE_TTL)) {
        return res.status(200).json(cache);
    }

    try {
        // Fetch fixture schedule + teams in parallel with FotMob live scores
        const [gamesRes, teamsRes, fotmobMap] = await Promise.all([
            fetchJson('https://worldcup26.ir/get/games', 3000),
            fetchJson('https://worldcup26.ir/get/teams', 3000),
            fetchFotmobLiveScores().catch(e => {
                console.warn('[api/fifa/fixtures] FotMob fetch failed:', e.message);
                return {};
            })
        ]);

        const games = gamesRes && gamesRes.games;
        const teamsData = teamsRes && teamsRes.teams;
        if (!Array.isArray(games)) {
            if (cache) return res.status(200).json(cache);
            return res.json([]);
        }

        const formatted = formatData(games, teamsData, fotmobMap);
        cache = formatted;
        lastFetched = now;
        console.log('[api/fifa/fixtures] FotMob overlay applied to', Object.keys(fotmobMap).length / 2, 'matches');
        return res.status(200).json(formatted);
    } catch (e) {
        console.error('[api/fifa/fixtures] Error:', e.message);
        if (cache) {
            console.log('[api/fifa/fixtures] Returning cached data due to API error');
            return res.status(200).json(cache);
        }
        // Try FotMob-only fallback with static fixture schedule
        console.log('[api/fifa/fixtures] Trying FotMob-only with static fallback schedule...');
        const fotmobMap = await fetchFotmobLiveScores().catch(() => ({}));
        const formatted = formatData(fallbackGames, fallbackTeams, fotmobMap);
        return res.status(200).json(formatted);
    }
};
