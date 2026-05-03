const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const fs = require('fs');

// Puppeteer is only available when running locally (not on Vercel)
let scraper = null;
try {
    scraper = require('./f1_scraper.js');
    console.log('✅ Puppeteer scraper loaded (local mode).');
} catch (e) {
    console.warn('⚠️  Puppeteer scraper not available (Vercel/serverless mode). Live scraping disabled.');
}

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: Allow the admin panel to call this API from any origin
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Firebase initialization
let db;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Vercel / Production mode: load from environment variable
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('Firebase Admin initialized from Environment Variable.');
  } else if (fs.existsSync('./serviceAccountKey.json')) {
    // Local development mode: load from file
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('Firebase Admin initialized from local file.');
  } else {
    console.warn('\n!!! WARNING !!!\nNo Firebase credentials found (env or file). Firebase writes will be simulated.\n');
  }
} catch (error) {
  console.error('Failed to initialize Firebase Admin:', error);
}

// Load static 2026 schedule
const schedule2026 = require('./schedule_2026.json');

const state = {
  activeSession: null,
  livePositions: [],
  lastSync: null,
  weather: { air: 0, track: 0, condition: 'sunny' },
  isLiveRace: false
};

// --- Session Detection via OpenF1 ---
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
      state.isLiveRace = true;
      return true;
    }
  } catch (error) {
    console.error('Failed to fetch OpenF1 session:', error.message);
  }
  return false;
}

async function fetchWeather(location) {
    try {
        const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
        let temp = parseInt(data.current_condition[0].temp_C);
        let desc = data.current_condition[0].weatherDesc[0].value.toLowerCase();
        
        state.weather.air = temp;
        state.weather.track = temp + Math.floor(Math.random() * 8) + 4;
        
        if (desc.includes('rain') || desc.includes('drizzle') || desc.includes('shower')) state.weather.condition = 'rain';
        else if (desc.includes('cloud') || desc.includes('overcast')) state.weather.condition = 'cloudy';
        else if (desc.includes('storm') || desc.includes('thunder')) state.weather.condition = 'storm';
        else state.weather.condition = 'sunny';
        
    } catch(e) {
        console.error('Weather fetch error:', e.message);
    }
}

async function syncToFirebase() {
    if (!db) {
        console.log('Simulating sync to Firebase...', new Date().toLocaleTimeString());
        return;
    }
    try {
        const liveConfigRef = db.collection('app_data').doc('live_config');
        await liveConfigRef.set({
            weather: state.weather,
            isLiveRaceActive: state.isLiveRace,
            lastAutoSync: Date.now()
        }, { merge: true });
        console.log(`✅ Synced weather & session to Firebase at ${new Date().toLocaleTimeString()}.`);
    } catch (e) {
        console.error('Firebase sync error:', e);
    }
}

// Polling intervals (only start in long-running mode, not on Vercel serverless)
if (!process.env.VERCEL) {
    setInterval(fetchLatestSession, 60000);
    setInterval(syncToFirebase, 30000);
}

// --- API: Live Leaderboard (scraped from F1.com) ---
app.get('/api/live-leaderboard', async (req, res) => {
    try {
        if (!scraper) {
            // Vercel deployment: scraper not available, return empty
            return res.json([]);
        }
        const data = await scraper.scrapeLiveLeaderboard();
        res.json(data || []);
    } catch (e) {
        console.error('Scraper error:', e.message);
        res.json([]);
    }
});

// --- API: Status ---
app.get('/', (req, res) => {
  res.json({
    status: 'F1 Watch Party Backend Running',
    mode: scraper ? 'local (scraper enabled)' : 'vercel (scraper disabled)',
    activeSession: state.activeSession,
    weather: state.weather,
    scheduleCount: schedule2026.length
  });
});

app.listen(PORT, async () => {
  console.log(`🏎️  F1 Backend running on port ${PORT}`);
  if (!process.env.VERCEL) {
    console.log('Fetching initial session data...');
    await fetchLatestSession();
  }
});

module.exports = app;
