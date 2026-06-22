const axios = require('axios');
const { setCors } = require('./_firebase');

module.exports = async (req, res) => {
  setCors(res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { data } = await axios.get('https://api.pushembdz.store/v1/streams', {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    return res.json(data);
  } catch (e) {
    console.error('[api/fetch-streams] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
