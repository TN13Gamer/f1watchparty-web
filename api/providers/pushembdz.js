/**
 * pushembdz.js — Modular parser for https://api.pushembdz.store/v1/streams
 *
 * API format (confirmed 2026-06):
 *   {
 *     "status": true,
 *     "timestamp": 1782467946,
 *     "categories": [
 *       {
 *         "category": "Events",
 *         "id": 1,
 *         "streams": [
 *           {
 *             "id": "uuid",
 *             "title": "F1 - Austria - FP1 - EN1",
 *             "method": "jwp2p",
 *             "link": "https://api.pushembdz.store/embed/uuid"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * KNOWN ISSUE: The API returns embed links on the `api.` subdomain
 * (e.g. https://api.pushembdz.store/embed/…) which returns HTTP 404.
 * The correct working embed URL removes the `api.` prefix:
 *   https://pushembdz.store/embed/…   →  HTTP 200
 *
 * This module normalises that automatically.
 */

'use strict';

const PROVIDER_ID = 'pushembdz';
const API_URL = 'https://api.pushembdz.store/v1/streams';

/**
 * Normalise a raw link from the API response so it always points to
 * the working embed domain (pushembdz.store, not api.pushembdz.store).
 *
 * @param {string} rawLink
 * @returns {string}
 */
function fixEmbedUrl(rawLink) {
  if (!rawLink) return '';
  // Replace api.pushembdz.store → pushembdz.store (embed subdomain fix)
  return rawLink.replace(/^https?:\/\/api\.pushembdz\.store/, 'https://pushembdz.store');
}

/**
 * Extract a human-readable label from a stream title.
 * E.g. "F1 - Austria - FP1 - EN1" → "F1 - Austria - EN1"
 *
 * @param {string} title
 * @returns {string}
 */
function labelFromTitle(title) {
  if (!title) return 'Unknown';
  const parts = title.split(' - ').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const suffix = parts[parts.length - 1];
    // Suffix tags like "EN1", "EN2", "ESP", "LowRes", "HD" are ≤ 8 chars
    if (suffix.length <= 8) {
      return `${parts[0]} - ${suffix}`;
    }
  }
  return title;
}

/**
 * Parse the raw JSON response from the pushembdz API into a flat,
 * normalised stream list.
 *
 * @param {object} rawData  – The parsed JSON body from the API
 * @returns {{ streams: Array, warnings: string[] }}
 */
function parseResponse(rawData) {
  const warnings = [];

  if (!rawData || typeof rawData !== 'object') {
    warnings.push('Response is not a JSON object');
    return { streams: [], warnings };
  }

  if (rawData.status !== true) {
    warnings.push(`API returned status=${rawData.status} (expected true)`);
    return { streams: [], warnings };
  }

  const categories = rawData.categories;
  if (!Array.isArray(categories)) {
    warnings.push('Response has no "categories" array');
    return { streams: [], warnings };
  }

  const streams = [];
  const seen = new Set();

  for (const cat of categories) {
    if (!Array.isArray(cat.streams)) {
      warnings.push(`Category "${cat.category}" has no streams array`);
      continue;
    }

    for (const s of cat.streams) {
      if (!s.title || !s.link) {
        warnings.push(`Stream missing title/link: ${JSON.stringify(s)}`);
        continue;
      }

      const embedUrl = fixEmbedUrl(s.link);

      // Deduplicate by embed URL
      if (seen.has(embedUrl)) continue;
      seen.add(embedUrl);

      streams.push({
        providerId: PROVIDER_ID,
        id: s.id || embedUrl,
        title: s.title,
        label: labelFromTitle(s.title),
        category: cat.category || 'Unknown',
        categoryId: cat.id,
        method: s.method || 'unknown',
        embedUrl,
        rawLink: s.link,   // keep original for debugging
      });
    }
  }

  if (streams.length === 0) {
    warnings.push('No valid streams found after parsing');
  }

  return { streams, warnings };
}

/**
 * Score a stream against a set of search tokens.
 * Returns a score between 0 and 100.
 *
 * @param {object} stream  – Normalised stream object from parseResponse()
 * @param {string[]} tokens  – Lower-case search tokens to match against the title
 * @returns {number}  0 = no match, >0 = partial, 100 = perfect
 */
function scoreStream(stream, tokens) {
  if (!stream.title || !tokens.length) return 0;
  const normalized = stream.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const matchedCount = tokens.filter(t => normalized.includes(t)).length;
  return Math.round((matchedCount / tokens.length) * 100);
}

module.exports = {
  PROVIDER_ID,
  API_URL,
  fixEmbedUrl,
  labelFromTitle,
  parseResponse,
  scoreStream,
};
