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
  } else {
    // Local development mode: check root or nested folder for credentials
    const path = require('path');
    let keyPath = null;
    if (fs.existsSync('./serviceAccountKey.json')) {
      keyPath = path.resolve('./serviceAccountKey.json');
    } else if (fs.existsSync('./f1watchparty-web-main/f1watchparty-web-main/f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json')) {
      keyPath = path.resolve('./f1watchparty-web-main/f1watchparty-web-main/f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json');
    }

    if (keyPath) {
      const serviceAccount = require(keyPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      db = admin.firestore();
      console.log('Firebase Admin initialized from file:', keyPath);
    } else {
      console.warn('\n!!! WARNING !!!\nNo Firebase credentials found (env or file). Firebase writes will be simulated.\n');
    }
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

async function syncStreamsAutomatically(config, ref) {
    if (!config.autoSyncStreams) return;

    try {
        let rawLocation = config.raceData?.location || "";
        if (!rawLocation && config.raceData?.name) {
            rawLocation = config.raceData.name;
        }
        
        let location = "";
        if (rawLocation) {
            let parts = rawLocation.split(',');
            let lastPart = parts[parts.length - 1].trim();
            location = lastPart.replace(/[0-9]/g, '').trim();
        }

        if (!location) return;

        let sessionAbbr = "FP1"; // Fallback
        if (config.schedule && config.schedule.length > 0) {
            const now = Date.now();
            let closestFutureTime = Infinity;
            let activeSess = null;

            config.schedule.forEach(s => {
                if (!s.timer) return;
                const start = new Date(s.timer).getTime();
                if (isNaN(start)) return;
                
                let end = start + (2 * 60 * 60 * 1000); 
                if (s.endTime && s.endTime.includes(':')) {
                    const parts = s.endTime.split(':');
                    const d = new Date(s.timer);
                    d.setHours(parseInt(parts[0]), parseInt(parts[1]), 0);
                    end = d.getTime();
                    if (end < start) end += 86400000;
                }

                if (now >= start && now < end) {
                    activeSess = s;
                } else if (now < start && start < closestFutureTime) {
                    closestFutureTime = start;
                    if (!activeSess) activeSess = s;
                }
            });

            if (!activeSess && config.schedule.length > 0) {
                 activeSess = config.schedule[0];
            }

            if (activeSess && activeSess.name) {
                let nameLower = activeSess.name.toLowerCase();
                if (nameLower.includes("practice 1") || nameLower.includes("fp1")) {
                    sessionAbbr = "FP1";
                } else if (nameLower.includes("practice 2") || nameLower.includes("fp2")) {
                    sessionAbbr = "FP2";
                } else if (nameLower.includes("practice 3") || nameLower.includes("fp3")) {
                    sessionAbbr = "FP3";
                } else if (nameLower.includes("qualifying") || nameLower.includes("qualy") || nameLower.includes("qual")) {
                    sessionAbbr = "Qualifying";
                } else if (nameLower.includes("sprint")) {
                    sessionAbbr = "Sprint";
                } else if (nameLower.includes("race") || nameLower.includes("grand prix")) {
                    sessionAbbr = "Race";
                }
            }
        }

        let searchTokens = ["f1", location.toLowerCase(), sessionAbbr.toLowerCase()];

        const { data } = await axios.get('https://api.pushembdz.store/v1/streams', { 
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (data && data.categories) {
            let allStreams = [];
            data.categories.forEach(cat => {
                if (cat.streams) allStreams = allStreams.concat(cat.streams);
            });

            let matched = allStreams.filter(s => {
                if (!s.title) return false;
                let titleLower = s.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
                return searchTokens.every(token => titleLower.includes(token));
            });

            if (matched.length > 0) {
                let newLinks = matched.map((s, index) => {
                    let parts = s.title.split(' - ');
                    let name = s.title;
                    if (parts.length > 1) {
                        let lastPart = parts[parts.length - 1].trim();
                        if (lastPart.length <= 10) {
                            name = parts[0].trim() + " - " + lastPart;
                        }
                    }
                    let url = s.link || "";
                    if (url.includes("api.pushembdz.store")) {
                        url = url.replace("api.pushembdz.store", "pushembdz.store");
                    }
                    return {
                        name: name,
                        id: "src_" + (Date.now() + index),
                        url: url
                    };
                });

                await ref.update({ streamLinks: newLinks });
                console.log(`[sync] Automatically updated ${newLinks.length} stream links in Firestore.`);
            }
        }
    } catch (err) {
        console.error('[sync] Stream auto-fetch error:', err.message);
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

        // Fetch current config to check if stream auto-sync is enabled
        const configDoc = await liveConfigRef.get();
        if (configDoc.exists) {
            const config = configDoc.data();
            await syncStreamsAutomatically(config, liveConfigRef);
        }
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

// --- API: Fetch Streams from pushembdz.store ---
app.get('/api/fetch-streams', async (req, res) => {
    try {
        const { data } = await axios.get('https://api.pushembdz.store/v1/streams', { 
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        res.json(data);
    } catch (e) {
        console.error('Error fetching streams:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- API: Sync Standings (Vercel cron handler) ---
app.all('/api/sync-standings', require('./api/sync-standings.js'));

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
