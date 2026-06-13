const axios = require('axios');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const [groupsRes, teamsRes] = await Promise.all([
            axios.get('https://worldcup26.ir/get/groups', { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }),
            axios.get('https://worldcup26.ir/get/teams',  { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })
        ]);

        const groupsData = groupsRes.data && groupsRes.data.groups;
        const teamsData  = teamsRes.data  && teamsRes.data.teams;
        if (!Array.isArray(groupsData) || !Array.isArray(teamsData)) return res.json([]);

        const teamsMap = {};
        teamsData.forEach(t => {
            teamsMap[t.id] = { name: t.name_en, flag: t.flag, code: t.fifa_code };
        });

        const formatted = groupsData.map(g => ({
            name: `Group ${g.name}`,
            teams: (g.teams || []).map(t => {
                const info = teamsMap[t.team_id] || { name: `Team ${t.team_id}`, flag: '', code: '' };
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

        return res.status(200).json(formatted);
    } catch (e) {
        console.error('[api/fifa/standings] Error:', e.message);
        return res.status(500).json([]);
    }
};
