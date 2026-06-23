const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
async function fetchJson(url, timeoutMs = 25000) {
  if (url.includes('worldcup26.ir') && !process.env.VERCEL) {
    try {
      return await fetchJsonWithPuppeteer(url, timeoutMs);
    } catch (e) {
      console.log(`[fetchJson] Puppeteer failed for ${url}: ${e.message}. Falling back to Axios/curl.`);
    }
  }
  try {
    const { data } = await axios.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://streamed.st/category/football'
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
          if (error) return reject(error);
          try {
            resolve(JSON.parse(stdout));
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

let cache = null;
let lastFetched = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds – standings update after goals/match ends

// Load initial fallback data
let fallbackGroups = [];
let fallbackTeams = [];
try {
    const groupsJson = require('./fallback_groups.json');
    const teamsJson = require('./fallback_teams.json');
    fallbackGroups = groupsJson.groups || [];
    fallbackTeams = teamsJson.teams || [];
} catch (e) {
    console.error('Failed to load local FIFA standings fallback files:', e.message);
}

function formatStandings(groupsData, teamsData) {
    if (!Array.isArray(groupsData) || !Array.isArray(teamsData)) return [];

    const teamsMap = {};
    teamsData.forEach(t => {
        if (t && t.id) {
            teamsMap[String(t.id)] = { name: t.name_en, flag: t.flag, code: t.fifa_code };
        }
    });

    return groupsData.map(g => ({
        name: `Group ${g.name}`,
        teams: (g.teams || []).map(t => {
            const info = teamsMap[String(t.team_id)] || { name: `Team ${t.team_id}`, flag: '', code: '' };
            return {
                teamId: t.team_id,
                name: info.name,
                flag: info.flag,
                code: info.code,
                mp:  parseInt(t.mp  || 0),
                w:   parseInt(t.w   || 0),
                d:   parseInt(t.d   || 0),
                l:   parseInt(t.l   || 0),
                gf:  parseInt(t.gf  || 0),
                ga:  parseInt(t.ga  || 0),
                gd:  parseInt(t.gd  || 0),
                pts: parseInt(t.pts || 0)
            };
        }).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf)
    })).sort((a, b) => a.name.localeCompare(b.name));
}

function computeDynamicStandings() {
    let games = [];
    let groups = [];
    let teams = [];
    try {
        const gamesJson = require('./fallback_games.json');
        const groupsJson = require('./fallback_groups.json');
        const teamsJson = require('./fallback_teams.json');
        games = gamesJson.games || [];
        groups = groupsJson.groups || [];
        teams = teamsJson.teams || [];
    } catch (e) {
        console.error('[computeDynamicStandings] Error loading files:', e.message);
        return [];
    }

    const STADIUM_OFFSETS = {
      '1': -6, '2': -6, '3': -6, '4': -5, '5': -5, '6': -5, '7': -4, '8': -4, '9': -4, '10': -4, '11': -4, '12': -4, '13': -7, '14': -7, '15': -7, '16': -7,
    };

    function parseLocalGameDate(localDate, stadiumId) {
      if (!localDate) return null;
      const [datePart, timePart] = localDate.split(' ');
      if (!datePart || !timePart) return null;
      const [month, day, year] = datePart.split('/').map(Number);
      const [hour, minute] = timePart.split(':').map(Number);
      const offset = STADIUM_OFFSETS[String(stadiumId)] || -4;
      return Date.UTC(year, month - 1, day, hour - offset, minute);
    }

    const teamStats = {};
    teams.forEach(t => {
        if (t && t.id) {
            teamStats[String(t.id)] = {
                teamId: String(t.id),
                name: t.name_en,
                flag: t.flag || '',
                code: t.fifa_code || '',
                mp: 0,
                w: 0,
                d: 0,
                l: 0,
                gf: 0,
                ga: 0,
                gd: 0,
                pts: 0
            };
        }
    });

    games.forEach(g => {
        if (g.type !== 'group') return;

        const homeId = String(g.home_team_id);
        const awayId = String(g.away_team_id);

        if (!teamStats[homeId]) teamStats[homeId] = { teamId: homeId, name: g.home_team_name_en || 'TBD', flag: '', code: '', mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
        if (!teamStats[awayId]) teamStats[awayId] = { teamId: awayId, name: g.away_team_name_en || 'TBD', flag: '', code: '', mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };

        const raw = String(g.time_elapsed || '').trim().toLowerCase();
        let isFinished = String(g.finished || '').toUpperCase() === 'TRUE' ||
            raw === 'finished' ||
            raw === 'ft';

        const kickoffMs = parseLocalGameDate(g.local_date, g.stadium_id);
        if (kickoffMs && (Date.now() - kickoffMs) > 2.5 * 60 * 60 * 1000) {
            isFinished = true;
        }

        if (isFinished) {
            const hs = parseInt(g.home_score || 0, 10);
            const as = parseInt(g.away_score || 0, 10);

            teamStats[homeId].mp += 1;
            teamStats[awayId].mp += 1;

            teamStats[homeId].gf += hs;
            teamStats[homeId].ga += as;
            teamStats[awayId].gf += as;
            teamStats[awayId].ga += hs;

            if (hs > as) {
                teamStats[homeId].w += 1;
                teamStats[homeId].pts += 3;
                teamStats[awayId].l += 1;
            } else if (as > hs) {
                teamStats[awayId].w += 1;
                teamStats[awayId].pts += 3;
                teamStats[homeId].l += 1;
            } else {
                teamStats[homeId].d += 1;
                teamStats[homeId].pts += 1;
                teamStats[awayId].d += 1;
                teamStats[awayId].pts += 1;
            }

            teamStats[homeId].gd = teamStats[homeId].gf - teamStats[homeId].ga;
            teamStats[awayId].gd = teamStats[awayId].gf - teamStats[awayId].ga;
        }
    });

    return groups.map(g => {
        const groupTeams = (g.teams || []).map(t => {
            const tid = String(t.team_id);
            return teamStats[tid] || {
                teamId: tid,
                name: `Team ${tid}`,
                flag: '',
                code: '',
                mp: 0,
                w: 0,
                d: 0,
                l: 0,
                gf: 0,
                ga: 0,
                gd: 0,
                pts: 0
            };
        }).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);

        return {
            name: `Group ${g.name}`,
            teams: groupTeams
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
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
        const [groupsRes, teamsRes] = await Promise.all([
            fetchJson('https://worldcup26.ir/get/groups', 25000),
            fetchJson('https://worldcup26.ir/get/teams', 25000)
        ]);

        const groupsData = groupsRes && groupsRes.groups;
        const teamsData  = teamsRes  && teamsRes.teams;
        if (!Array.isArray(groupsData) || !Array.isArray(teamsData)) {
            if (cache) return res.status(200).json(cache);
            return res.json([]);
        }

        const formatted = formatStandings(groupsData, teamsData);
        cache = formatted;
        lastFetched = now;
        return res.status(200).json(formatted);
    } catch (e) {
        console.error('[api/fifa/standings] Error:', e.message);
        if (cache) {
            console.log('[api/fifa/standings] Returning cached data due to API error');
            return res.status(200).json(cache);
        }
        console.log('[api/fifa/standings] Calculating dynamic standings due to API error');
        const computed = computeDynamicStandings();
        return res.status(200).json(computed);
    }
};
