const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Firebase initialization
let db;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('Firebase Admin initialized from Environment Variable.');
  } else if (fs.existsSync('./serviceAccountKey.json')) {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('Firebase Admin initialized from local file.');
  } else {
    console.warn('\n!!! WARNING !!!\nNo Firebase credentials found. Firebase writes will be simulated.\n');
  }
} catch (error) {
  console.error('Failed to initialize Firebase Admin:', error);
}

// Load static 2026 schedule
let schedule2026 = [];
try { schedule2026 = require('./schedule_2026.json'); } catch(e) {}

// Memory store
const state = {
  activeSession: null,
  lastSync: null,
  weather: { air: 0, track: 0, condition: 'sunny' },
  lastStandingsSync: null
};

// Team name aliases: exact Jolpica API team name -> possible substrings in Firestore
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

// -------------------------------------------------------
// STANDINGS SYNC
// Fetches from Jolpica (official F1/FIA data, same source as f1.com)
// Matches drivers/teams by name and writes updated points to Firestore
// -------------------------------------------------------
async function syncStandings() {
  if (!db) { console.log('[Standings] No DB — skipping.'); return; }

  try {
    const [driverRes, constructorRes] = await Promise.all([
      axios.get('https://api.jolpi.ca/ergast/f1/current/driverstandings/'),
      axios.get('https://api.jolpi.ca/ergast/f1/current/constructorstandings/')
    ]);

    const driverList = driverRes.data &&
      driverRes.data.MRData &&
      driverRes.data.MRData.StandingsTable &&
      driverRes.data.MRData.StandingsTable.StandingsLists &&
      driverRes.data.MRData.StandingsTable.StandingsLists[0] &&
      driverRes.data.MRData.StandingsTable.StandingsLists[0].DriverStandings;

    const constructorList = constructorRes.data &&
      constructorRes.data.MRData &&
      constructorRes.data.MRData.StandingsTable &&
      constructorRes.data.MRData.StandingsTable.StandingsLists &&
      constructorRes.data.MRData.StandingsTable.StandingsLists[0] &&
      constructorRes.data.MRData.StandingsTable.StandingsLists[0].ConstructorStandings;

    if (!driverList || driverList.length === 0) {
      console.log('[Standings] No driver data returned from API.');
      return;
    }

    // Read current Firestore config
    const configRef = db.collection('app_data').doc('live_config');
    const configDoc = await configRef.get();
    if (!configDoc.exists) { console.log('[Standings] live_config doc not found.'); return; }

    const config = configDoc.data();
    const standings = config.standings || [];
    const constructors = config.constructors || [];
    let changed = false;

    // --- Match & update DRIVER points by last name ---
    driverList.forEach(entry => {
      const lastName = entry.Driver.familyName.toLowerCase();
      const apiPoints = parseInt(entry.points) || 0;

      const match = standings.find(d => {
        if (!d.name) return false;
        return d.name.toLowerCase().indexOf(lastName) !== -1;
      });
      if (match && match.points !== apiPoints) {
        match.points = apiPoints;
        changed = true;
      }
    });

    if (changed) {
      standings.sort((a, b) => (b.points || 0) - (a.points || 0));
    }

    // --- Match & update CONSTRUCTOR points ---
    if (constructorList && constructorList.length > 0) {
      constructorList.forEach(entry => {
        const apiTeamName = entry.Constructor.name; // e.g. "RB F1 Team"
        const apiPoints = parseInt(entry.points) || 0;
        const aliases = TEAM_ALIASES[apiTeamName] || [apiTeamName.toLowerCase()];

        const match = constructors.find(c => {
          if (!c.name) return false;
          const n = c.name.toLowerCase();
          return aliases.some(a => n.indexOf(a) !== -1);
        });
        if (match && match.points !== apiPoints) {
          match.points = apiPoints;
          changed = true;
        }
      });

      if (changed) {
        constructors.sort((a, b) => (b.points || 0) - (a.points || 0));
      }
    }

    if (changed) {
      await configRef.set({ standings, constructors }, { merge: true });
      state.lastStandingsSync = new Date().toISOString();
      console.log('[Standings] Updated & saved to Firestore at', state.lastStandingsSync);
    } else {
      console.log('[Standings] No changes — Firestore unchanged.');
    }

  } catch (err) {
    console.error('[Standings] Sync error:', err.message);
  }
}

// -------------------------------------------------------
// WEATHER SYNC
// -------------------------------------------------------
async function fetchWeather(location) {
  try {
    const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
    const temp = parseInt(data.current_condition[0].temp_C);
    const desc = data.current_condition[0].weatherDesc[0].value.toLowerCase();

    state.weather.air = temp;
    state.weather.track = temp + Math.floor(Math.random() * 8) + 4;

    if (desc.includes('rain') || desc.includes('drizzle') || desc.includes('shower')) state.weather.condition = 'rain';
    else if (desc.includes('cloud') || desc.includes('overcast')) state.weather.condition = 'cloudy';
    else if (desc.includes('storm') || desc.includes('thunder')) state.weather.condition = 'storm';
    else state.weather.condition = 'sunny';
  } catch(e) {
    console.error('[Weather] Fetch error:', e.message);
  }
}

async function syncWeatherToFirebase() {
  if (!db) return;
  try {
    await db.collection('app_data').doc('live_config').set({
      weather: state.weather,
      lastAutoSync: Date.now()
    }, { merge: true });
  } catch(e) {
    console.error('[Firebase] Weather sync error:', e.message);
  }
}

// -------------------------------------------------------
// SESSION SYNC
// -------------------------------------------------------
async function fetchLatestSession() {
  try {
    const { data } = await axios.get('https://api.openf1.org/v1/sessions?session_key=latest');
    if (data && data.length > 0) {
      const s = data[0];
      state.activeSession = {
        name: s.session_name,
        key: s.session_key,
        location: s.location,
        circuit: s.circuit_short_name || s.location,
        date: s.date_start,
        status: s.status
      };
      if (state.activeSession.location) fetchWeather(state.activeSession.location);
      return true;
    }
  } catch (err) {
    console.error('[Session] Fetch error:', err.message);
  }
  return false;
}

// -------------------------------------------------------
// POLLING INTERVALS
// -------------------------------------------------------
setInterval(fetchLatestSession, 60000);     // session check every 1 min
setInterval(syncWeatherToFirebase, 30000);  // weather → Firestore every 30s
setInterval(syncStandings, 30000);          // standings → Firestore every 30s

// -------------------------------------------------------
// API ROUTES
// -------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'F1 Backend Running',
    activeSession: state.activeSession,
    weather: state.weather,
    lastStandingsSync: state.lastStandingsSync,
    scheduleCount: schedule2026.length
  });
});

// Manual trigger endpoint — hit this to force an immediate sync
app.get('/api/sync-standings', async (req, res) => {
  await syncStandings();
  res.json({ ok: true, lastSync: state.lastStandingsSync });
});

app.listen(PORT, async () => {
  console.log(`F1 Backend running on port ${PORT}`);
  console.log('Initializing — fetching session & standings...');
  await fetchLatestSession();
  await syncStandings(); // run immediately on startup
});
