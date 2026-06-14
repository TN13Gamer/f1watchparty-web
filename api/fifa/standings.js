const axios = require('axios');
const fs = require('fs');
const path = require('path');

let cache = null;
let lastFetched = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Load initial fallback data
let fallbackGroups = [];
let fallbackTeams = [];
try {
    const groupsJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fallback_groups.json'), 'utf8'));
    const teamsJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fallback_teams.json'), 'utf8'));
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
    }));
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
        const [groupsRes, teamsRes] = await Promise.all([
            axios.get('https://worldcup26.ir/get/groups', { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }),
            axios.get('https://worldcup26.ir/get/teams',  { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
        ]);

        const groupsData = groupsRes.data && groupsRes.data.groups;
        const teamsData  = teamsRes.data  && teamsRes.data.teams;
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
        console.log('[api/fifa/standings] Returning static fallback data due to API error');
        const formatted = formatStandings(fallbackGroups, fallbackTeams);
        return res.status(200).json(formatted);
    }
};
