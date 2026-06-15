// Server-side poll API for FIFA World Cup 2026 match polls
// Handles reading and writing poll votes using Firebase Admin (bypasses Firestore rules)

let _db = null;
function getDb() {
  if (_db) return _db;
  try {
    const admin = require('firebase-admin');
    if (admin.apps.length) {
      _db = admin.firestore();
      return _db;
    }
  } catch (e) {
    console.error('[poll] Firebase admin unavailable:', e.message);
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  if (!db) {
    return res.status(500).json({ error: 'Firebase not available' });
  }

  const matchId = req.query.matchId || (req.body && req.body.matchId);

  if (!matchId || typeof matchId !== 'string' || matchId.length > 80) {
    return res.status(400).json({ error: 'Invalid matchId' });
  }

  const pollRef = db.collection('app_data').doc('polls').collection('fifa').doc(matchId);

  // GET /api/fifa/poll?matchId=xxx → return current vote counts
  if (req.method === 'GET') {
    try {
      const snap = await pollRef.get();
      if (!snap.exists) {
        return res.json({ home: 0, away: 0, draw: 0, total: 0 });
      }
      const data = snap.data();
      const home = data.home || 0;
      const away = data.away || 0;
      const draw = data.draw || 0;
      const total = home + away + draw;
      return res.json({ home, away, draw, total });
    } catch (e) {
      console.error('[poll] GET error:', e.message);
      return res.status(500).json({ error: 'Failed to read poll' });
    }
  }

  // POST /api/fifa/poll?matchId=xxx body: { choice: 'home'|'away'|'draw' }
  if (req.method === 'POST') {
    const choice = req.body && req.body.choice;
    if (!['home', 'away', 'draw'].includes(choice)) {
      return res.status(400).json({ error: 'Invalid choice. Must be home, away, or draw.' });
    }

    try {
      const admin = require('firebase-admin');
      const inc = admin.firestore.FieldValue.increment(1);
      await pollRef.set({ [choice]: inc }, { merge: true });

      // Return updated counts
      const snap = await pollRef.get();
      const data = snap.exists ? snap.data() : { home: 0, away: 0, draw: 0 };
      const home = data.home || 0;
      const away = data.away || 0;
      const draw = data.draw || 0;
      const total = home + away + draw;
      return res.json({ home, away, draw, total, voted: choice });
    } catch (e) {
      console.error('[poll] POST error:', e.message);
      return res.status(500).json({ error: 'Failed to record vote' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
