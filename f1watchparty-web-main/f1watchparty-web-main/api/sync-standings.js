/**
 * Vercel Serverless Function — /api/sync-standings
 *
 * Called by an external cron service (cron-job.org) every 30 seconds.
 * Fetches official F1 championship standings and writes them to Firestore.
 * No persistent server required — runs on-demand in ~1 second, then exits.
 *
 * Setup:
 *   1. Deploy to Vercel (set FIREBASE_SERVICE_ACCOUNT env variable)
 *   2. Register https://your-site.vercel.app/api/sync-standings
 *      at https://cron-job.org — set interval to 30 seconds (free)
 */

const axios = require('axios');
const admin = require('firebase-admin');

// Firebase Admin — safe to call multiple times due to cold-start caching
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (e) {
    console.error('[sync-standings] Firebase init error:', e.message);
  }
}

const TEAM_ALIASES = {
  'Red Bull':         ['red bull', 'redbull', 'oracle'],
  'Mercedes':         ['mercedes', 'amg'],
  'Ferrari':          ['ferrari', 'scuderia'],
  'McLaren':          ['mclaren'],
  'Aston Martin':     ['aston martin', 'aston'],
  'Alpine F1 Team':   ['alpine'],
  'Williams':         ['williams'],
  'RB F1 Team':       ['rb f1', 'racing bulls', 'rb ', 'vcarb', 'alphatauri'],
  'Audi':             ['audi', 'sauber', 'kick'],
  'Haas F1 Team':     ['haas'],
  'Cadillac F1 Team': ['cadillac', 'andretti']
};

module.exports = async (req, res) => {
  // Allow GET (cron ping) and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const db = admin.firestore();

    // --- Fetch standings from official F1/FIA data source ---
    const [driverRes, constructorRes] = await Promise.all([
      axios.get('https://api.jolpi.ca/ergast/f1/current/driverstandings/', { timeout: 8000 }),
      axios.get('https://api.jolpi.ca/ergast/f1/current/constructorstandings/', { timeout: 8000 })
    ]);

    const driverList =
      driverRes.data?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings;
    const constructorList =
      constructorRes.data?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings;

    if (!driverList || driverList.length === 0) {
      return res.status(200).json({ ok: false, message: 'No driver data returned' });
    }

    // --- Read current Firestore config ---
    const configRef = db.collection('app_data').doc('live_config');
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      return res.status(200).json({ ok: false, message: 'live_config not found in Firestore' });
    }

    const config = configDoc.data();
    const standings = config.standings || [];
    const constructors = config.constructors || [];
    let changed = false;

    // --- Match & update DRIVER points by last name ---
    driverList.forEach(entry => {
      const lastName = entry.Driver.familyName.toLowerCase();
      const apiPoints = parseInt(entry.points) || 0;

      const match = standings.find(d =>
        d.name && d.name.toLowerCase().includes(lastName)
      );
      if (match && match.points !== apiPoints) {
        match.points = apiPoints;
        changed = true;
      }
    });

    if (changed) standings.sort((a, b) => (b.points || 0) - (a.points || 0));

    // --- Match & update CONSTRUCTOR points ---
    if (constructorList?.length > 0) {
      constructorList.forEach(entry => {
        const apiTeamName = entry.Constructor.name;
        const apiPoints = parseInt(entry.points) || 0;
        const aliases = TEAM_ALIASES[apiTeamName] || [apiTeamName.toLowerCase()];

        const match = constructors.find(c => {
          if (!c.name) return false;
          const n = c.name.toLowerCase();
          return aliases.some(a => n.includes(a));
        });
        if (match && match.points !== apiPoints) {
          match.points = apiPoints;
          changed = true;
        }
      });

      if (changed) constructors.sort((a, b) => (b.points || 0) - (a.points || 0));
    }

    // --- Write back to Firestore only if something changed ---
    const syncedAt = new Date().toISOString();
    if (changed) {
      await configRef.set({ standings, constructors, lastStandingsSync: syncedAt }, { merge: true });
      console.log('[sync-standings] Updated Firestore at', syncedAt);
      return res.status(200).json({ ok: true, updated: true, syncedAt });
    }

    // Always update the timestamp so we know the cron is alive
    await configRef.set({ lastStandingsSync: syncedAt }, { merge: true });
    return res.status(200).json({ ok: true, updated: false, message: 'No point changes', syncedAt });

  } catch (err) {
    console.error('[sync-standings] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
