// Server-side poll API for FIFA World Cup 2026 match polls
// Handles reading and writing poll votes using Supabase (with fallback logic)

const { db } = require('../_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = {};
  if (req.body) {
    if (typeof req.body === 'object') {
      body = req.body;
    } else {
      try {
        body = JSON.parse(req.body);
      } catch (e) {
        // ignore
      }
    }
  }

  const matchId = req.query.matchId || body.matchId;
  const voterId = req.query.voterId || body.voterId;

  if (!matchId || typeof matchId !== 'string' || matchId.length > 80) {
    return res.status(400).json({ error: 'Invalid matchId' });
  }

  // GET /api/fifa/poll?matchId=xxx → return current vote counts
  if (req.method === 'GET') {
    try {
      const poll = await db.getPoll(matchId);
      return res.json(poll);
    } catch (e) {
      console.error('[poll] GET error:', e.message);
      return res.status(500).json({ error: 'Failed to read poll' });
    }
  }

  // POST /api/fifa/poll?matchId=xxx body: { choice: 'home'|'away'|'draw', voterId: 'xxx' }
  if (req.method === 'POST') {
    const choice = body.choice;
    if (!['home', 'away', 'draw'].includes(choice)) {
      return res.status(400).json({ error: 'Invalid choice. Must be home, away, or draw.' });
    }
    if (!voterId) {
      return res.status(400).json({ error: 'Missing voterId' });
    }

    try {
      const result = await db.castVote(matchId, voterId, choice);
      return res.json(result);
    } catch (e) {
      console.error('[poll] POST error:', e.message);
      return res.status(500).json({ error: 'Failed to record vote' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
