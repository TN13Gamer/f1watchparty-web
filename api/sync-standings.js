/**
 * /api/sync-standings — Vercel Serverless Function
 * Called by cron-job.org every 30 seconds.
 * Tries f1.com API first, falls back to Jolpica (official FIA data).
 */

const axios = require('axios');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    } else {
      const fs = require('fs');
      const path = require('path');
      let keyPath = null;
      if (fs.existsSync(path.resolve(__dirname, '../serviceAccountKey.json'))) {
        keyPath = path.resolve(__dirname, '../serviceAccountKey.json');
      } else if (fs.existsSync(path.resolve(__dirname, '../../serviceAccountKey.json'))) {
        keyPath = path.resolve(__dirname, '../../serviceAccountKey.json');
      } else if (fs.existsSync(path.resolve(__dirname, '../f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json'))) {
        keyPath = path.resolve(__dirname, '../f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json');
      } else if (fs.existsSync(path.resolve(__dirname, '../../f1watchparty-web-main/f1watchparty-web-main/f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json'))) {
        keyPath = path.resolve(__dirname, '../../f1watchparty-web-main/f1watchparty-web-main/f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json');
      }
      
      if (keyPath) {
        const sa = require(keyPath);
        admin.initializeApp({ credential: admin.credential.cert(sa) });
        console.log('[sync] Firebase initialized using local file:', keyPath);
      } else {
        console.warn('[sync] No Firebase credentials found.');
      }
    }
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

    // Automatically sync streams from pushembdz if enabled
    await syncStreamsAutomatically(config, ref);

    res.json({ ok: true, updated: changed, syncedAt, source });
  } catch(err) {
    console.error('[sync] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
