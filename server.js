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

// Load static 2026 schedule we scraped/generated
const schedule2026 = require('./schedule_2026.json');

// Memory store
const state = {
  activeSession: null,
  livePositions: {},
  lastSync: null,
  weather: { air: 0, track: 0, condition: 'sunny' }
};

// --- OpenF1 Polling ---
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
      
      // Auto-fetch weather based on the current track location
      if(state.activeSession.location) fetchWeather(state.activeSession.location);

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
        state.weather.track = temp + Math.floor(Math.random() * 8) + 4; // Simulated track temp
        
        if(desc.includes('rain') || desc.includes('drizzle') || desc.includes('shower')) state.weather.condition = 'rain';
        else if(desc.includes('cloud') || desc.includes('overcast')) state.weather.condition = 'cloudy';
        else if(desc.includes('storm') || desc.includes('thunder')) state.weather.condition = 'storm';
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
    
    // In a full implementation, we'd map OpenF1 IDs to your existing Firestore drivers
    // and push the update.
    try {
        const liveConfigRef = db.collection('app_data').doc('live_config');
        
        // Push weather and latest session info
        await liveConfigRef.set({
            weather: state.weather,
            lastAutoSync: Date.now()
        }, { merge: true });
        
        console.log('Successfully synced to Firebase at', new Date().toLocaleTimeString());
    } catch (e) {
        console.error('Firebase sync error:', e);
    }
}

// Polling intervals
setInterval(fetchLatestSession, 60000); // Check session every minute
setInterval(syncToFirebase, 30000);     // Push to Firebase every 30s

app.get('/', (req, res) => {
  res.json({
    status: 'Automated F1 Backend is Running',
    activeSession: state.activeSession,
    weather: state.weather,
    scheduleCount: schedule2026.length
  });
});

app.listen(PORT, async () => {
  console.log(`F1 Automation Server running on port ${PORT}`);
  console.log('Fetching initial session data...');
  await fetchLatestSession();
});
