/**
 * /api/sync-standings — Vercel Serverless Function
 * Called by cron-job.org every 30 seconds.
 * Tries f1.com API first, falls back to Jolpica (official FIA data).
 */

const axios = require('axios');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  } catch(e) { console.error('[sync] Firebase init error:', e.message); }
}

const TEAM_ALIASES = {
  'Mercedes':         ['mercedes', 'amg'],
  'Ferrari':          ['ferrari', 'scuderia'],
  'McLaren':          ['mclaren'],
  'Red Bull':         ['red bull', 'redbull', 'oracle'],
  'Red Bull Racing':  ['red bull', 'redbull', 'oracle'],
  'Aston Martin':     ['aston martin', 'aston'],
  'Alpine F1 Team':   ['alpine'],
  'Alpine':           ['alpine'],
  'Williams':         ['williams'],
  'RB F1 Team':       ['racing bulls', 'rb f1', 'rb ', 'vcarb', 'alphatauri'],
  'Racing Bulls':     ['racing bulls', 'rb f1', 'rb ', 'vcarb'],
  'Audi':             ['audi', 'sauber', 'kick'],
  'Haas F1 Team':     ['haas'],
  'Cadillac F1 Team': ['cadillac', 'andretti'],
  'Cadillac':         ['cadillac', 'andretti']
};

async function fetchStandings() {
  // Try f1.com official API first
  try {
    const headers = { 'apikey': 'qPgPPRJyGCIPxFT3el4MF7thXHyJCzAP', 'locale': 'en' };
    const [d, c] = await Promise.all([
      axios.get('https://api.formula1.com/v1/editorial-driverstandings/standings', { headers, timeout: 6000 }),
      axios.get('https://api.formula1.com/v1/editorial-constructorstandings/standings', { headers, timeout: 6000 })
    ]);
    const dl = d.data?.standings?.DriverStandings || d.data?.DriverStandings;
    const cl = c.data?.standings?.ConstructorStandings || c.data?.ConstructorStandings;
    if (dl?.length > 0) {
      console.log('[sync] Using f1.com API');
      return { dl, cl, source: 'f1.com' };
    }
  } catch(e) {
    console.warn('[sync] f1.com failed:', e.message, '— falling back to Jolpica');
  }

  // Fallback: Jolpica (official FIA data mirror)
  const [d, c] = await Promise.all([
    axios.get('https://api.jolpi.ca/ergast/f1/current/driverstandings/', { timeout: 8000 }),
    axios.get('https://api.jolpi.ca/ergast/f1/current/constructorstandings/', { timeout: 8000 })
  ]);
  return {
    dl: d.data?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings,
    cl: c.data?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings,
    source: 'jolpica'
  };
}

module.exports = async (req, res) => {
  if (!['GET','POST'].includes(req.method)) return res.status(405).end();

  try {
    const db = admin.firestore();
    const { dl, cl, source } = await fetchStandings();

    if (!dl?.length) return res.json({ ok: false, message: 'No data' });

    const ref = db.collection('app_data').doc('live_config');
    const doc = await ref.get();
    if (!doc.exists) return res.json({ ok: false, message: 'live_config not found' });

    const config = doc.data();
    const standings = config.standings || [];
    const constructors = config.constructors || [];
    let changed = false;

    dl.forEach(entry => {
      const lastName = (entry.Driver?.familyName || '').toLowerCase();
      const pts = parseInt(entry.points || 0);
      const match = standings.find(d => d.name && d.name.toLowerCase().includes(lastName));
      if (match && match.points !== pts) { match.points = pts; changed = true; }
    });
    if (changed) standings.sort((a, b) => (b.points||0) - (a.points||0));

    if (cl?.length) {
      cl.forEach(entry => {
        const name = entry.Constructor?.name || '';
        const pts = parseInt(entry.points || 0);
        const aliases = TEAM_ALIASES[name] || [name.toLowerCase()];
        const match = constructors.find(c => {
          if (!c.name) return false;
          const n = c.name.toLowerCase();
          return aliases.some(a => n.includes(a));
        });
        if (match && match.points !== pts) { match.points = pts; changed = true; }
      });
      if (changed) constructors.sort((a, b) => (b.points||0) - (a.points||0));
    }

    const syncedAt = new Date().toISOString();
    await ref.set({ standings, constructors, lastStandingsSync: syncedAt, standingsSource: source }, { merge: true });
    if (changed) console.log('[sync] Updated Firestore', syncedAt, source);

    res.json({ ok: true, updated: changed, syncedAt, source });
  } catch(err) {
    console.error('[sync] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
