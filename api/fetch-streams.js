const axios = require('axios');

module.exports = async (req, res) => {
  // Set CORS headers so that client-side can call it from any domain (e.g., local development)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { data } = await axios.get('https://api.pushembdz.store/v1/streams', { 
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    return res.status(200).json(data);
  } catch (error) {
    console.error('[fetch-streams] Error fetching streams:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
