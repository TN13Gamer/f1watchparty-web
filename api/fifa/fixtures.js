const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

let cache = null;
let lastFetched = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Load initial fallback data
let fallbackGames = [];
let fallbackTeams = [];
try {
    const gamesJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fallback_games.json'), 'utf8'));
    const teamsJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fallback_teams.json'), 'utf8'));
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

function formatData(games, teamsData) {
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

    return games.map(g => {
        const stadium = STADIUM_MAP[g.stadium_id] || { name: 'Stadium' };
        const round = g.type === 'group'
            ? `Group ${g.group}`
            : (roundMap[g.type] || g.group || 'World Cup 2026');

        let friendlyDate = g.local_date || '';
        try {
            const parts = (g.local_date || '').split(' ');
            if (parts.length >= 2) {
                const dateParts = parts[0].split('/');
                const mm = parseInt(dateParts[0], 10);
                const dd = parseInt(dateParts[1], 10);
                if (!isNaN(mm) && !isNaN(dd)) {
                    friendlyDate = `${dd} ${months[mm - 1]} ${parts[1]}`;
                }
            }
        } catch (e) {}

        const homeInfo = lookupTeam(g.home_team_id, g.home_team_name_en || g.home_team_label);
        const awayInfo = lookupTeam(g.away_team_id, g.away_team_name_en || g.away_team_label);

        return {
            id: g.id,
            homeTeam: homeInfo.name,
            awayTeam: awayInfo.name,
            homeFlag: homeInfo.flag,
            awayFlag: awayInfo.flag,
            homeCode: homeInfo.code,
            awayCode: awayInfo.code,
            homeScore: g.home_score || '0',
            awayScore: g.away_score || '0',
            localDate: friendlyDate,
            status: g.time_elapsed,
            finished: g.finished === 'TRUE',
            round,
            stadium: stadium.name
        };
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const now = Date.now();
    if (cache && (now - lastFetched < CACHE_TTL)) {
        return res.status(200).json(cache);
    }

    try {
        const [gamesRes, teamsRes] = await Promise.all([
            axios.get('https://worldcup26.ir/get/games', { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }),
            axios.get('https://worldcup26.ir/get/teams',  { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
        ]);

        const games = gamesRes.data && gamesRes.data.games;
        const teamsData = teamsRes.data && teamsRes.data.teams;
        if (!Array.isArray(games)) {
            if (cache) return res.status(200).json(cache);
            return res.json([]);
        }

        const formatted = formatData(games, teamsData);
        cache = formatted;
        lastFetched = now;
        return res.status(200).json(formatted);
    } catch (e) {
        console.error('[api/fifa/fixtures] Error:', e.message);
        if (cache) {
            console.log('[api/fifa/fixtures] Returning cached data due to API error');
            return res.status(200).json(cache);
        }
        console.log('[api/fifa/fixtures] Returning static fallback data due to API error');
        const formatted = formatData(fallbackGames, fallbackTeams);
        return res.status(200).json(formatted);
    }
};
