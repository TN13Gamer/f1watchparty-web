const axios = require('axios');

// FotMob returns XML - parse it into a match map keyed by normalized team names
async function fetchFotmobLiveScores() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url = 'https://api.fotmob.com/matches?date=' + today;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Accept': '*/*',
    'Referer': 'https://www.fotmob.com/',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  const { data: xml } = await axios.get(url, { headers, timeout: 5000, responseType: 'text' });

  // Extract World Cup (pl="77") leagues
  const wcBlocks = xml.match(/<league[^>]*pl="77"[^>]*>[\s\S]*?<\/league>/g) || [];
  const liveMap = {}; // key: "homeName|awayName" -> match info

  for (const block of wcBlocks) {
    const leagueAttrs = (block.match(/<league([^>]*)>/) || [])[1] || '';
    const grpName = (leagueAttrs.match(/grpName="([^"]+)"/) || [])[1] || '';

    const matches = block.match(/<match[^>]*\/>/g) || [];
    for (const m of matches) {
      function get(key) { return (m.match(new RegExp(key + '="([^"]+)"')) || [])[1] || ''; }
      const hTeam = get('hTeam');
      const aTeam = get('aTeam');
      const hScore = get('hScore');
      const aScore = get('aScore');
      const status = get('Status'); // N=not started, L=live, F=finished
      const minute = get('minute');
      const matchId = get('id');

      // Build key using normalized names (lowercase, no punctuation)
      function norm(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }
      const key = norm(hTeam) + '|' + norm(aTeam);
      const reverseKey = norm(aTeam) + '|' + norm(hTeam);

      // Map FotMob status to our status strings
      let mappedStatus = 'notstarted';
      if (status === 'F' || status === 'FT') mappedStatus = 'finished';
      else if (status === 'L' || status === 'HT') mappedStatus = 'live';

      // Map minute
      let matchTime = '';
      if (mappedStatus === 'finished') matchTime = 'FT';
      else if (status === 'HT') matchTime = 'HT';
      else if (minute && /^\d+$/.test(minute)) matchTime = minute + "'";

      const entry = {
        homeScore: hScore || '0',
        awayScore: aScore || '0',
        status: mappedStatus,
        matchTime,
        group: grpName ? 'Group ' + grpName : '',
        fotmobId: matchId
      };

      liveMap[key] = entry;
      liveMap[reverseKey] = { ...entry, homeScore: aScore || '0', awayScore: hScore || '0' };
    }
  }

  return liveMap;
}

module.exports = { fetchFotmobLiveScores };
