/**
 * /api/fetch-streams.js  —  Vercel Serverless Function
 *
 * Proxies the pushembdz.store stream list, applies necessary URL fixes,
 * and optionally filters results by keyword/session tokens.
 *
 * Query parameters:
 *   q         – Optional search query (comma-separated tokens, e.g. "f1,austria,fp1")
 *   raw       – If "1", return the full parsed+normalised list without filtering
 *
 * Response (JSON):
 *   {
 *     ok: true,
 *     count: <number>,
 *     streams: [ { id, title, label, category, method, embedUrl }, … ],
 *     warnings: [ <string>, … ],
 *     fetchedAt: <ISO string>
 *   }
 */

'use strict';

const axios = require('axios');
const { API_URL, parseResponse, scoreStream } = require('./providers/pushembdz');

const FETCH_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'application/json, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://pushembdz.store/',
  Origin: 'https://pushembdz.store',
};

/**
 * Fetch the raw JSON from the pushembdz API with retry logic.
 */
async function fetchRaw(log) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      log(`[fetch-streams] Attempt ${attempt}/${MAX_RETRIES + 1} — GET ${API_URL}`);
      const { data, status } = await axios.get(API_URL, {
        timeout: FETCH_TIMEOUT_MS,
        headers: REQUEST_HEADERS,
        validateStatus: () => true,   // handle non-2xx ourselves
      });

      log(`[fetch-streams] HTTP ${status} received`);

      if (status === 200) {
        return { data, httpStatus: status, error: null };
      }

      if (status === 429 || status === 503) {
        // Rate-limited or service unavailable — wait before retry
        lastError = new Error(`HTTP ${status} from API`);
        if (attempt <= MAX_RETRIES) {
          log(`[fetch-streams] Received ${status}. Waiting ${RETRY_DELAY_MS}ms before retry…`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }

      // Non-retryable HTTP error
      return {
        data: null,
        httpStatus: status,
        error: `API returned HTTP ${status}`,
      };
    } catch (err) {
      lastError = err;
      const isTimeout = err.code === 'ECONNABORTED' || err.message.includes('timeout');
      log(`[fetch-streams] ${isTimeout ? 'Timeout' : 'Network error'} on attempt ${attempt}: ${err.message}`);
      if (attempt <= MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  return {
    data: null,
    httpStatus: null,
    error: lastError ? lastError.message : 'All retry attempts failed',
  };
}

/**
 * Parse a comma/space-separated query string into a list of lowercase tokens.
 */
function parseTokens(q) {
  if (!q) return [];
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s,]/g, ' ')
    .split(/[\s,]+/)
    .filter(t => t.length > 0);
}

// ─── Serverless handler ────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const logs = [];
  const log = msg => { console.log(msg); logs.push(msg); };

  const fetchedAt = new Date().toISOString();
  const tokens = parseTokens(req.query.q || '');
  const returnRaw = req.query.raw === '1';

  log(`[fetch-streams] Request received. tokens=${JSON.stringify(tokens)} raw=${returnRaw}`);

  // ── 1. Fetch from API ───────────────────────────────────────────────────────
  const { data: rawData, httpStatus, error: fetchError } = await fetchRaw(log);

  if (fetchError || !rawData) {
    const msg = fetchError || 'No data returned from API';
    log(`[fetch-streams] ❌ Fetch failed: ${msg}`);
    return res.status(502).json({
      ok: false,
      error: `Failed to fetch from pushembdz API: ${msg}`,
      httpStatus,
      fetchedAt,
      logs,
    });
  }

  // ── 2. Parse + normalise (apply embed URL fix) ─────────────────────────────
  const { streams, warnings } = parseResponse(rawData);

  log(`[fetch-streams] Parsed ${streams.length} streams. Warnings: ${warnings.length}`);
  if (warnings.length) {
    warnings.forEach(w => log(`[fetch-streams] ⚠  ${w}`));
  }

  // ── 3. Optional filter by search tokens ───────────────────────────────────
  let result = streams;
  if (tokens.length > 0 && !returnRaw) {
    // Primary filter: all tokens must match
    result = streams.filter(s => scoreStream(s, tokens) === 100);

    if (result.length === 0) {
      // Fallback: strip session-type tokens, match on sport+location only
      const coreTokens = tokens.filter(
        t => !['fp1', 'fp2', 'fp3', 'practice', 'qualifying', 'qualy', 'qual', 'sprint', 'race'].includes(t)
      );
      if (coreTokens.length > 0) {
        result = streams.filter(s => scoreStream(s, coreTokens) === 100);
        log(`[fetch-streams] Fallback filter with core tokens ${JSON.stringify(coreTokens)}: ${result.length} results`);
      }
    }

    log(`[fetch-streams] Filtered to ${result.length} streams for tokens: ${tokens.join(', ')}`);
  }

  // ── 4. Respond ──────────────────────────────────────────────────────────────
  return res.status(200).json({
    ok: true,
    count: result.length,
    streams: result.map(s => ({
      id: s.id,
      title: s.title,
      label: s.label,
      category: s.category,
      method: s.method,
      embedUrl: s.embedUrl,    // ← always the corrected, working URL
    })),
    warnings,
    fetchedAt,
  });
};
