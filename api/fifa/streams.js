/**
 * /api/fifa/streams — Fast FIFA stream fetcher
 * Uses streamed.pk official API: GET /api/matches/football (sport-specific, small payload)
 * Then resolves embedUrls from match sources in parallel.
 * Designed to complete well within Vercel's 10s function limit.
 */

const axios = require('axios');
const admin = require('firebase-admin');

// Firebase init (shared pattern)
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    } else {
      const fs = require('fs');
      const path = require('path');
      const possiblePaths = [
        path.resolve(__dirname, '../../serviceAccountKey.json'),
        path.resolve(__dirname, '../../f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json'),
      ];
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          admin.initializeApp({ credential: admin.credential.cert(require(p)) });
          break;
        }
      }
    }
  } catch (e) { console.error('[fifa/streams] Firebase init error:', e.message); }
}

const STREAMED_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://streamed.pk/',
  'Origin': 'https://streamed.pk'
};

// Blocked sources that never return valid stream embeds
const BLOCKED_SOURCES = new Set(['golf', 'tennis', 'nba', 'nhl', 'nfl', 'mlb', 'ufc', 'boxing', 'cricket', 'rugby', 'f1', 'motogp', 'motorsport']);

function normTitle(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreMatch(match, tokens) {
  if (!match || !match.title) return 0;
  const title = normTitle(match.title);
  return tokens.reduce((n, t) => n + (title.includes(t) ? 1 : 0), 0);
}

function tokenize(name) {
  const stopWords = new Set(['vs', 'fc', 'the', 'a', 'and', 'or', 'de', 'la', 'st']);
  return normTitle(name).split(' ').filter(t => t.length > 1 && !stopWords.has(t));
}

function enrichTokens(tokens) {
  const set = new Set(tokens);
  if (set.has('usa') || (set.has('united') && set.has('states'))) {
    set.add('usa'); set.add('united'); set.add('states');
  }
  if (set.has('korea') || set.has('south')) { set.add('korea'); set.add('south'); set.add('rep'); }
  if (set.has('ivory') || set.has('coast')) { set.add('cote'); set.add('divoire'); }
  return Array.from(set);
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const matchName = req.query.match || '';
  const saveToFirestore = req.query.save === 'true';

  console.log(`[fifa/streams] Fetching streams for match: "${matchName}"`);

  try {
    // Step 1: Fetch football matches ONLY (correct sport-specific endpoint = fast, small payload)
    // Try live first, fall back to all-today and all in parallel
    const TIMEOUT = 4000;
    const endpoints = [
      'https://streamed.pk/api/matches/football',
      'https://streamed.pk/api/matches/live',
    ];

    const fetchResults = await Promise.allSettled(
      endpoints.map(ep =>
        axios.get(ep, { timeout: TIMEOUT, headers: STREAMED_HEADERS })
          .then(r => Array.isArray(r.data) ? r.data : [])
          .catch(e => { console.warn(`[fifa/streams] ${ep} failed:`, e.message); return []; })
      )
    );

    // Merge deduplicated results
    const seen = new Set();
    const allMatches = [];
    for (const r of fetchResults) {
      if (r.status !== 'fulfilled') continue;
      for (const m of r.value) {
        const key = m.id || m.title;
        if (key && !seen.has(key)) { seen.add(key); allMatches.push(m); }
      }
    }

    console.log(`[fifa/streams] Got ${allMatches.length} total football/live matches`);

    if (allMatches.length === 0) {
      return res.json({ ok: false, error: 'No matches returned from streamed.pk', streamLinks: [] });
    }

    // Step 2: Find best matching football match
    const footballMatches = allMatches.filter(m => m.category === 'football');
    const tokens = enrichTokens(tokenize(matchName));
    console.log(`[fifa/streams] Searching with tokens: ${tokens.join(', ')}`);

    let ranked = footballMatches
      .map(m => ({ m, score: scoreMatch(m, tokens) }))
      .filter(x => x.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.m.sources || []).length - (a.m.sources || []).length;
      });

    // If no token match, try popular football match
    if (ranked.length === 0 && footballMatches.length > 0) {
      console.log('[fifa/streams] No token match — using popular football match');
      ranked = footballMatches
        .filter(m => m.popular)
        .map(m => ({ m, score: 0 }));
      if (ranked.length === 0) ranked = [{ m: footballMatches[0], score: 0 }];
    }

    if (ranked.length === 0) {
      return res.json({ ok: false, error: 'No matching football match found', streamLinks: [] });
    }

    const bestMatch = ranked[0].m;
    console.log(`[fifa/streams] Best match: "${bestMatch.title}" (score=${ranked[0].score}) with ${(bestMatch.sources || []).length} sources`);

    // Step 3: Resolve all stream sources IN PARALLEL (correct API: /api/stream/{source}/{id})
    const sources = (bestMatch.sources || []).filter(s => s && s.source && !BLOCKED_SOURCES.has(s.source.toLowerCase()));
    
    const streamLinks = [];
    await Promise.all(
      sources.map(async (src) => {
        try {
          const url = `https://streamed.pk/api/stream/${src.source}/${src.id}`;
          const resp = await axios.get(url, { timeout: 3000, headers: STREAMED_HEADERS });
          const streams = resp.data;
          if (Array.isArray(streams)) {
            streams.forEach(stream => {
              if (stream.embedUrl) {
                streamLinks.push({
                  name: `${src.source.toUpperCase()} ${stream.language || 'EN'}${stream.hd ? ' (HD)' : ''}`.trim(),
                  id: `src_fifa_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                  url: stream.embedUrl
                });
              }
            });
          }
        } catch (e) {
          console.warn(`[fifa/streams] Source ${src.source}/${src.id} failed:`, e.message);
        }
      })
    );

    console.log(`[fifa/streams] Resolved ${streamLinks.length} stream links`);

    // Step 4: Optionally save to Firestore
    if (saveToFirestore && admin.apps.length) {
      try {
        const db = admin.firestore();
        const ref = db.collection('app_data').doc('live_config');
        const doc = await ref.get();
        if (doc.exists) {
          const currentFifa = (doc.data().fifa) || {};
          await ref.update({
            fifa: {
              ...currentFifa,
              streamLinks,
              lastStreamsSync: new Date().toISOString()
            }
          });
          console.log(`[fifa/streams] Saved ${streamLinks.length} links to Firestore`);
        }
      } catch (e) {
        console.error('[fifa/streams] Firestore save error:', e.message);
      }
    }

    return res.json({
      ok: true,
      matchTitle: bestMatch.title,
      streamLinks,
      count: streamLinks.length
    });

  } catch (err) {
    console.error('[fifa/streams] Fatal error:', err.message);
    return res.status(500).json({ ok: false, error: err.message, streamLinks: [] });
  }
};
