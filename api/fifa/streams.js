/**
 * /api/fifa/streams — Fast FIFA stream fetcher
 * Uses streamed.st official API: GET /api/matches/football (sport-specific, small payload)
 * Then resolves embedUrls from match sources in parallel.
 * Designed to complete well within Vercel's 10s function limit.
 */

const axios = require('axios');
const { db } = require('../_supabase');

const STREAMED_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://streamed.st/',
  'Origin': 'https://streamed.st'
};

// Robust fetch helper with curl fallback to bypass Cloudflare TLS fingerprinting and handle timeouts/blocks gracefully
async function fetchJson(url, timeoutMs = 8000) {
  try {
    const { data } = await axios.get(url, {
      timeout: timeoutMs,
      headers: STREAMED_HEADERS
    });
    return data;
  } catch (e) {
    console.log(`[fifa/streams] Axios failed for ${url}: ${e.message}. Falling back to curl.`);
    try {
      const { exec } = require('child_process');
      return await new Promise((resolve, reject) => {
        const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
        const cmd = `${curlCmd} -s -L -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -H "Referer: https://streamed.st/" "${url}"`;
        exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
          if (error) return reject(error);
          try {
            resolve(JSON.parse(stdout));
          } catch (jsonErr) {
            reject(new Error(`Failed to parse JSON from curl stdout: ${jsonErr.message}. Output was: ${stdout.substring(0, 200)}`));
          }
        });
      });
    } catch (curlErr) {
      throw new Error(`Both Axios and curl failed to fetch ${url}. Axios: ${e.message}. Curl: ${curlErr.message}`);
    }
  }
}

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
    const TIMEOUT = 7000;
    const endpoints = [
      'https://streamed.st/api/matches/football',
      'https://streamed.st/api/matches/live',
    ];

    const fetchResults = await Promise.allSettled(
      endpoints.map(ep =>
        fetchJson(ep, TIMEOUT)
          .then(data => Array.isArray(data) ? data : [])
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
      return res.json({ ok: false, error: 'No matches returned from streamed.st', streamLinks: [] });
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
          const url = `https://streamed.st/api/stream/${src.source}/${src.id}`;
          const streams = await fetchJson(url, 4000);
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

    // Step 4: Optionally save to Supabase
    if (saveToFirestore) {
      try {
        const config = await db.getConfig();
        const currentFifa = config.fifa || {};
        await db.updateConfig({
          fifa: {
            ...currentFifa,
            streamLinks,
            lastStreamsSync: new Date().toISOString()
          }
        });
        console.log(`[fifa/streams] Saved ${streamLinks.length} links to Supabase`);
      } catch (e) {
        console.error('[fifa/streams] Supabase save error:', e.message);
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
