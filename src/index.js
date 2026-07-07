import { D1Database } from "./db";
import { FirestoreClient } from "./firebase";
import {
  syncF1LiveAndWeather,
  syncF1Standings,
  syncStreamsAutomatically,
  syncF1Streams,
  syncF1Schedule
} from "./sync";

import { API_URL as PUSH_EMB_API_URL, parseResponse, fixEmbedUrl } from "../api/providers/pushembdz";
import { adminHtml } from "./embed-html";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const DIAGNOSTIC_SOURCES = [
  { name: "streamed.pk API", url: "https://streamed.pk/api/matches/all" },
  { name: "streamed.pk Football", url: "https://streamed.pk/category/football" },
  { name: "soccerstreams.to", url: "https://soccerstreams.to/" },
  { name: "footybite.cc", url: "https://footybite.cc/" },
  { name: "1stream.eu Soccer", url: "https://1stream.eu/soccer" },
  { name: "livesports.world Football", url: "https://livesports.world/football" },
  { name: "pushembdz API", url: "https://api.pushembdz.store/v1/streams" }
];

async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function testStreamSources() {
  const results = [];
  for (const src of DIAGNOSTIC_SOURCES) {
    const start = Date.now();
    try {
      const res = await fetchWithTimeout(src.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
      }, 10000);
      const text = await res.text();
      const hasMatch = /[A-Za-z]{3,}\s+vs\s+[A-Za-z]{3,}/i.test(text);
      results.push({
        name: src.name,
        status: res.status,
        elapsed: Date.now() - start,
        bytes: text.length,
        hasMatchTitles: hasMatch,
        ok: res.ok
      });
    } catch (err) {
      results.push({
        name: src.name,
        status: "error",
        error: err.message.substring(0, 80),
        elapsed: Date.now() - start,
        ok: false
      });
    }
  }
  return results;
}

function formatIst(ms) {
  if (!ms || !isFinite(ms)) return "";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

function parseTokens(q) {
  if (!q) return [];
  return q.toLowerCase().replace(/[^a-z0-9\s,]/g, " ").split(/[\s,]+/).filter(t => t.length > 0);
}

function getBody(request) {
  return request.json().catch(() => ({}));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Polyfill missing bindings (DB + KV were deleted from account)
    if (!env.DB) {
      const noopDb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => {} }) }) };
      env.DB = noopDb;
    }
    if (!env.CONFIG_KV) {
      env.CONFIG_KV = { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => [] };
    }
    const db = new D1Database(env.DB);
    let firestore = null;
    if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
      firestore = new FirestoreClient(env.FIREBASE_PROJECT_ID, env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
    }

    const log = (msg) => console.log(`[worker] ${msg}`);



    try {
      // ---- F1 legacy endpoints ----
      if (path === "/api/sync-standings") {
        const type = url.searchParams.get("type");
        let config = firestore ? await firestore.getConfig() : await db.getConfig();

        if (type === "liveconfig") {
          return jsonResponse(config);
        }

        if (type === "fetchstreams") {
          const res = await fetch(PUSH_EMB_API_URL);
          if (!res.ok) return jsonResponse({ success: false, error: `pushembdz API returned HTTP ${res.status}` }, 502);
          const data = await res.json();
          const { streams, warnings } = parseResponse(data);
          return jsonResponse({
            success: true, count: streams.length, warnings,
            streams: streams.map(s => ({ id: s.id, title: s.title, label: s.label, category: s.category, method: s.method, embedUrl: s.embedUrl }))
          });
        }

        if (type === "f1streams") {
          const result = await syncF1Streams(config, firestore || db, env.CONFIG_KV);
          return jsonResponse({
            success: !result.error,
            accepted: result.accepted,
            rejected: result.rejected,
            groups: result.groups,
            detected: result.detected,
            error: result.error,
            logs: result.logs.slice(-20),
            streams: result.streams
          });
        }

        if (type === "standings") {
          const payload = await syncF1Standings(config, firestore || db).catch(() => null);
          return jsonResponse({ success: !!payload, data: payload });
        }

        return jsonResponse({ success: false, error: "Unknown type" });
      }

      if (path === "/api/fetch-streams") {
        const res = await fetch(PUSH_EMB_API_URL);
        if (!res.ok) return jsonResponse({ success: false, error: "Failed to fetch streams" }, 502);
        const data = await res.json();
        const { streams } = parseResponse(data);
        return jsonResponse({ success: true, count: streams.length, streams });
      }

      // ---- F1 endpoints ----
      if (path === "/api/f1/sync-streams") {
        const f1Config = firestore ? await firestore.getConfig().catch(() => ({})) : await db.getConfig().catch(() => ({}));
        const result = await syncF1Streams(f1Config, firestore || db, env.CONFIG_KV);
        return jsonResponse({
          success: !result.error,
          accepted: result.accepted,
          rejected: result.rejected,
          groups: result.groups,
          detected: result.detected,
          error: result.error,
          logs: result.logs.slice(-20)
        });
      }

      if (path === "/api/f1/sync-schedule") {
        const result = await syncF1Schedule(env.CONFIG_KV, firestore || db);
        return jsonResponse({
          success: result.success,
          race: result.race,
          sessions: result.sessions,
          sprint: result.sprint,
          error: result.error,
          logs: result.logs.slice(-20)
        });
      }

      if (path === "/api/f1/status") {
        const lastStreamResult = await env.CONFIG_KV.get("f1_streams_last_result").catch(() => null);
        const lastStreamLogs = await env.CONFIG_KV.get("f1_streams_last_logs").catch(() => null);
        const streamsCount = await env.CONFIG_KV.get("f1_streams_count").catch(() => null);
        const lastAccepted = await env.CONFIG_KV.get("f1_streams_last_accepted").catch(() => null);
        const lastRejected = await env.CONFIG_KV.get("f1_streams_last_rejected").catch(() => null);
        const scheduleCount = await env.CONFIG_KV.get("f1_schedule_count").catch(() => null);
        const scheduleRace = await env.CONFIG_KV.get("f1_schedule_race").catch(() => null);
        const scheduleSprint = await env.CONFIG_KV.get("f1_schedule_sprint").catch(() => null);
        const scheduleLastSync = await env.CONFIG_KV.get("f1_schedule_last_sync").catch(() => null);
        return jsonResponse({
          success: true,
          streams: {
            lastResult: lastStreamResult ? JSON.parse(lastStreamResult) : null,
            logs: lastStreamLogs ? JSON.parse(lastStreamLogs) : [],
            count: streamsCount ? parseInt(streamsCount, 10) : 0,
            lastAccepted: lastAccepted ? parseInt(lastAccepted, 10) : 0,
            lastRejected: lastRejected ? parseInt(lastRejected, 10) : 0
          },
          schedule: {
            count: scheduleCount ? parseInt(scheduleCount, 10) : 0,
            race: scheduleRace || "Unknown",
            sprint: scheduleSprint || "unknown",
            lastSync: scheduleLastSync || "Never"
          },
          timestamp: new Date().toISOString()
        });
      }



      // ---- Match endpoints ----
      if (path === "/api/matches" || path === "/api/matches/all") {
        const results = await db.getMatches();
        return jsonResponse(results);
      }

      if (path === "/api/matches/live") {
        return jsonResponse(await db.getMatches("live"));
      }
      if (path === "/api/matches/upcoming") {
        return jsonResponse(await db.getMatches("notstarted"));
      }
      if (path === "/api/matches/completed") {
        return jsonResponse(await db.getMatches("finished"));
      }

      if (path.startsWith("/api/match/")) {
        const id = path.split("/").pop();
        const match = await db.getMatch(id);
        if (!match) return jsonResponse({ success: false, error: "Match not found" }, 404);
        return jsonResponse(match);
      }

      if (path === "/api/standings") {
        const results = await db.getStandings();
        const groups = {};
        results.forEach(r => {
          const groupName = r.groupName || "Group";
          if (groupName.includes("3rd") || groupName.toLowerCase().includes("third")) return;
          if (!groups[groupName]) groups[groupName] = [];
          groups[groupName].push(r);
        });
        return jsonResponse(Object.keys(groups).map(g => ({ name: g, teams: groups[g] })));
      }

      // ---- Stream endpoints ----
      if (path.startsWith("/api/streams/") && !path.startsWith("/api/admin/")) {
        const matchId = path.split("/").pop();
        let streams = await db.getStreams(matchId);
        if (streams.length === 0) {
          try {
            const fallback = await env.CONFIG_KV.get(`stream_fallback_${matchId}`, "json");
            if (fallback && Array.isArray(fallback)) streams = fallback;
          } catch (_) {}
        }
        return jsonResponse(streams);
      }

      if (path.startsWith("/api/admin/streams/")) {
        const matchId = path.replace("/api/admin/streams/", "").split("/")[0];
        if (!matchId) return jsonResponse({ success: false, error: "Missing matchId" }, 400);
        const results = await db.getAllStreams(matchId);
        return jsonResponse({ success: true, streams: results, matchId, count: results.length });
      }

      // ---- Admin endpoints ----
      if (path === "/api/admin/status") {
        const f1StreamsCount = await env.CONFIG_KV.get("f1_streams_count").catch(() => null);
        const f1ScheduleRace = await env.CONFIG_KV.get("f1_schedule_race").catch(() => null);
        const f1ScheduleCount = await env.CONFIG_KV.get("f1_schedule_count").catch(() => null);
        const f1ScheduleLastSync = await env.CONFIG_KV.get("f1_schedule_last_sync").catch(() => null);
        const f1StreamsLastResult = await env.CONFIG_KV.get("f1_streams_last_result").catch(() => null);

        return jsonResponse({
          success: true,
          f1: {
            streamsCount: f1StreamsCount ? parseInt(f1StreamsCount, 10) : 0,
            lastStreamResult: f1StreamsLastResult ? JSON.parse(f1StreamsLastResult) : null,
            scheduleRace: f1ScheduleRace || "Unknown",
            scheduleCount: f1ScheduleCount ? parseInt(f1ScheduleCount, 10) : 0,
            scheduleLastSync: f1ScheduleLastSync || "Never"
          }
        });
      }

      if (path === "/api/admin/stats") {
        const f1ScheduleRace = await env.CONFIG_KV.get("f1_schedule_race").catch(() => null);
        return jsonResponse({ success: true, f1ScheduleRace });
      }

      if (path === "/api/debug/stream-sources") {
        const sources = await testStreamSources();
        return jsonResponse({ sources });
      }

      if (path === "/api/debug") {
        return jsonResponse({
          sources: {
            config: { firestore: 'app_data/live_config (Firebase)', kv: 'CONFIG_KV' }
          },
          timestamp: new Date().toISOString()
        });
      }

      if (path === "/health") {
        return jsonResponse({ status: "healthy", timestamp: new Date().toISOString() });
      }



      // ---- Serve F1 app at root (from /f1) ----
      if (path === "/" || path === "") {
        try {
          const origin = new URL("https://watchf1.live/f1");
          const res = await fetch(origin.toString(), {
            headers: {
              "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
              "Accept": request.headers.get("Accept") || "*/*",
              "Accept-Language": request.headers.get("Accept-Language") || "en-US,en;q=0.9"
            }
          });
          const headers = new Headers(res.headers);
          headers.set("cache-control", "public, max-age=300");
          return new Response(res.body, { status: res.status, headers });
        } catch (e) {
          log(`Failed to fetch /f1: ${e.message}`);
        }
      }

      // ---- Serve HTML pages directly from Worker ----
      if (path === "/admin.html" || path === "/admin") {
        return new Response(adminHtml, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "public, max-age=300" } });
      }

      return jsonResponse({ success: false, error: `Not found: ${path}` }, 404);

    } catch (err) {
      console.error(`[worker] Fatal error on ${path}:`, err.stack || err.message);
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  },

  // ---------------------------------------------------------------
  // CRON TRIGGER
  // ---------------------------------------------------------------
  async scheduled(event, env, ctx) {
    console.log(`[cron] Triggered at ${new Date().toISOString()}`);
    const db = new D1Database(env.DB);
    let firestore = null;
    if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
      firestore = new FirestoreClient(env.FIREBASE_PROJECT_ID, env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
    }

    ctx.waitUntil((async () => {
      try {
        let config = firestore ? await firestore.getConfig() : await db.getConfig();

        // F1 schedule auto-sync (every cron run)
        await syncF1Schedule(env.CONFIG_KV, firestore || db).catch(e => console.error("[cron] F1 schedule:", e.message));

        // F1 weather sync
        await syncF1LiveAndWeather(config, firestore || db).catch(e => console.error("[cron] F1 sync:", e.message));

        // F1 standings auto-sync
        if (config.autoSyncStandings !== false) {
          await syncF1Standings(config, firestore || db).catch(e => console.error("[cron] F1 standings:", e.message));
        }

        // F1 streams auto-sync with F1-only filtering
        if (config.autoSyncStreams !== false) {
          await syncF1Streams(config, firestore || db, env.CONFIG_KV).catch(e => console.error("[cron] F1 streams:", e.message));
        }
      } catch (e) { console.error("[cron] F1 block:", e.message); }



      console.log("[cron] Finished.");
    })());
  }
};
