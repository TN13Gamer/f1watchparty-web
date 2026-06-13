const axios = require('axios');

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

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const response = await axios.get('https://worldcup26.ir/get/games', {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const games = response.data && response.data.games;
        if (!Array.isArray(games)) return res.json([]);

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

        const formatted = games.map(g => {
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

            return {
                id: g.id,
                homeTeam: g.home_team_name_en || g.home_team_label || 'TBD',
                awayTeam: g.away_team_name_en || g.away_team_label || 'TBD',
                homeScore: g.home_score || '0',
                awayScore: g.away_score || '0',
                localDate: friendlyDate,
                status: g.time_elapsed,
                finished: g.finished === 'TRUE',
                round,
                stadium: stadium.name
            };
        });

        return res.status(200).json(formatted);
    } catch (e) {
        console.error('[api/fifa/fixtures] Error:', e.message);
        return res.status(500).json([]);
    }
};
