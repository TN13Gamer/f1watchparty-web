/**
 * src/index.js
 * Cloudflare Worker main entry point.
 * Provides routing for all /api/* endpoints and cron scheduled sync executions.
 */

import { D1Database } from "./db";
import { FirestoreClient } from "./firebase";
import {
  syncF1LiveAndWeather,
  fetchStandings,
  syncStreamsAutomatically,
  syncFotMobData,
  syncFifaStreamsAndFeeds
} from "./sync";

import { API_URL as PUSH_EMB_API_URL, parseResponse, fixEmbedUrl } from "../api/providers/pushembdz";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

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
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

function parseTokens(q) {
  if (!q) return [];
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s,]/g, " ")
    .split(/[\s,]+/)
    .filter(t => t.length > 0);
}

// -------------------------------------------------------------
// WORKER ROOT HANDLER
// -------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle OPTIONS CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // Initialize databases
    const db = new D1Database(env.DB);
    let firestore = null;
    if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
      firestore = new FirestoreClient(env.FIREBASE_PROJECT_ID, env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
    }

    try {
      // --- F1 LEGACY API ENDPOINTS ---
      if (path === "/api/sync-standings") {
        const type = url.searchParams.get("type");
        const manual = url.searchParams.get("manual") === "true";

        let config = firestore ? await firestore.getConfig() : await db.getConfig();

        if (type === "liveconfig") {
          // Adapt /api/sync-standings?type=liveconfig to load matches/standings/streams dynamically from D1!
          const liveMatches = await db.getMatches("live");
          const activeMatch = liveMatches[0] || (await db.getMatches("notstarted"))[0] || (await db.getMatches("finished"))[0];
          const matchStreams = activeMatch ? await db.getStreams(activeMatch.id) : [];

          // Translate into live config format expected by frontend
          const fifaConfig = {
            raceData: activeMatch ? {
              name: `${activeMatch.homeTeam} vs ${activeMatch.awayTeam}`,
              round: activeMatch.stage || "World Cup 2026",
              circuit: activeMatch.venue || "Stadium",
              location: activeMatch.venue || "FIFA Arena",
              date: formatIst(activeMatch.kickoff),
              homeScore: activeMatch.score?.split("-")[0]?.trim() || "0",
              awayScore: activeMatch.score?.split("-")[1]?.trim() || "0",
              isLive: activeMatch.status === "live",
              isFinished: activeMatch.status === "finished",
              matchTime: activeMatch.status === "live" ? "LIVE" : (activeMatch.status === "finished" ? "FT" : "0'")
            } : {},
            customTimer: {
              enabled: activeMatch && activeMatch.status === "notstarted",
              target: activeMatch ? new Date(activeMatch.kickoff).toISOString() : new Date().toISOString(),
              label: "KICKOFF COUNTDOWN"
            },
            streamLinks: matchStreams.map((s, index) => ({
              name: `${s.provider.toUpperCase()} EN ${s.quality === "1080P" ? "(HD)" : ""}`.trim(),
              id: `stream_${activeMatch.id}_${index}`,
              url: s.embedUrl
            }))
          };

          const mergedConfig = {
            ...config,
            fifa: fifaConfig
          };
          return jsonResponse(mergedConfig);
        }

        if (type === "fetchstreams") {
          const res = await fetch(PUSH_EMB_API_URL);
          if (!res.ok) return jsonResponse({ error: `pushembdz API returned HTTP ${res.status}` }, 502);
          const data = await res.json();
          const { streams, warnings } = parseResponse(data);
          return jsonResponse({
            status: true,
            count: streams.length,
            warnings,
            streams: streams.map(s => ({
              id: s.id,
              title: s.title,
              label: s.label,
              category: s.category,
              method: s.method,
              embedUrl: s.embedUrl
            }))
          });
        }

        // F1 sync trigger fallback
        await syncF1LiveAndWeather(config, firestore || db).catch(() => {});
        return jsonResponse({ ok: true });
      }

      if (path === "/api/fetch-streams") {
        const q = url.searchParams.get("q") || "";
        const res = await fetch(PUSH_EMB_API_URL);
        if (!res.ok) return jsonResponse({ ok: false, error: "Failed to fetch streams" }, 502);
        const data = await res.json();
        const { streams } = parseResponse(data);
        return jsonResponse({ ok: true, count: streams.length, streams });
      }

      // --- AUTOMATED FIFA WORLD CUP ENDPOINTS ---

      // GET /api/matches/live
      if (path === "/api/matches/live") {
        const results = await db.getMatches("live");
        return jsonResponse(results);
      }

      // GET /api/matches/upcoming
      if (path === "/api/matches/upcoming") {
        const results = await db.getMatches("notstarted");
        return jsonResponse(results);
      }

      // GET /api/matches/completed
      if (path === "/api/matches/completed") {
        const results = await db.getMatches("finished");
        return jsonResponse(results);
      }

      // GET /api/match/:id (e.g. /api/match/12345)
      if (path.startsWith("/api/match/")) {
        const id = path.split("/").pop();
        const match = await db.getMatch(id);
        if (!match) return jsonResponse({ error: "Match not found" }, 404);
        return jsonResponse(match);
      }

      // GET /api/standings
      if (path === "/api/standings") {
        const results = await db.getStandings();
        // Group by groupName
        const groups = {};
        results.forEach(r => {
          if (!groups[r.groupName]) groups[r.groupName] = [];
          groups[r.groupName].push(r);
        });
        const formatted = Object.keys(groups).map(g => ({
          name: g,
          teams: groups[g]
        }));
        return jsonResponse(formatted);
      }

      // GET /api/streams/:matchId
      if (path.startsWith("/api/streams/")) {
        const matchId = path.split("/").pop();
        const results = await db.getStreams(matchId);
        return jsonResponse(results);
      }

      // POST /admin/resync
      if (path === "/admin/resync" && request.method === "POST") {
        console.log("[admin] Force synchronization triggered...");
        await syncFotMobData(db);
        await syncFifaStreamsAndFeeds(db);

        // Push current active match to Firestore if enabled
        if (firestore) {
          const liveMatches = await db.getMatches("live");
          const activeMatch = liveMatches[0] || (await db.getMatches("notstarted"))[0] || (await db.getMatches("finished"))[0];
          if (activeMatch) {
            const streamsList = await db.getStreams(activeMatch.id);
            const fifaConfig = {
              raceData: {
                name: `${activeMatch.homeTeam} vs ${activeMatch.awayTeam}`,
                round: activeMatch.stage || "World Cup 2026",
                circuit: activeMatch.venue || "Stadium",
                location: activeMatch.venue || "FIFA Arena",
                date: formatIst(activeMatch.kickoff),
                homeScore: activeMatch.score?.split("-")[0]?.trim() || "0",
                awayScore: activeMatch.score?.split("-")[1]?.trim() || "0",
                isLive: activeMatch.status === "live",
                isFinished: activeMatch.status === "finished",
                matchTime: activeMatch.status === "live" ? "LIVE" : (activeMatch.status === "finished" ? "FT" : "0'")
              },
              customTimer: {
                enabled: activeMatch.status === "notstarted",
                target: new Date(activeMatch.kickoff).toISOString(),
                label: "KICKOFF COUNTDOWN"
              },
              streamLinks: streamsList.map((s, index) => ({
                name: `${s.provider.toUpperCase()} EN ${s.quality === "1080P" ? "(HD)" : ""}`.trim(),
                id: `stream_${activeMatch.id}_${index}`,
                url: s.embedUrl
              }))
            };
            await firestore.updateConfig({ fifa: fifaConfig });
          }
        }

        return jsonResponse({ success: true, message: "Sync engine executed successfully" });
      }

      // GET /health
      if (path === "/health") {
        const matches = await db.getMatches();
        const live = matches.filter(m => m.status === "live").length;
        const upcoming = matches.filter(m => m.status === "notstarted").length;
        return jsonResponse({
          status: "healthy",
          timestamp: new Date().toISOString(),
          matches: {
            total: matches.length,
            live,
            upcoming
          }
        });
      }

      // --- CHAT ENDPOINTS ---
      if (path === "/api/chat/stream") {
        const messages = await db.getChatMessages(60);
        return jsonResponse({ type: "chatList", data: messages });
      }

      if (path === "/api/chat/send" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!body.username || !body.text) return jsonResponse({ error: "Missing username or text" }, 400);
        const message = await db.addChatMessage({
          username: body.username,
          text: body.text,
          color: body.color,
          isAdmin: !!body.isAdmin
        });
        return jsonResponse(message);
      }

      if (path === "/api/chat/delete" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!body.id) return jsonResponse({ error: "Missing message id" }, 400);
        await db.deleteChatMessage(body.id);
        return jsonResponse({ success: true });
      }

      if (path === "/api/chat/clear" && request.method === "POST") {
        await db.clearChatMessages();
        return jsonResponse({ success: true });
      }

      return jsonResponse({ error: `Not found: ${path}` }, 404);

    } catch (err) {
      console.error(`Fatal handler error on ${path}:`, err.message);
      return jsonResponse({ error: err.message }, 500);
    }
  },

  // -------------------------------------------------------------
  // CRON TRIGGER SYNC TASK
  // -------------------------------------------------------------
  async scheduled(event, env, ctx) {
    console.log(`[Scheduled Cron] Execution triggered at ${new Date().toISOString()}`);

    const db = new D1Database(env.DB);
    let firestore = null;
    if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
      firestore = new FirestoreClient(env.FIREBASE_PROJECT_ID, env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
    }

    ctx.waitUntil((async () => {
      // 1. Sync F1 Live & Weather & Standings & Streams
      try {
        let config = firestore ? await firestore.getConfig() : await db.getConfig();
        await syncF1LiveAndWeather(config, firestore || db).catch(() => {});
        await syncStreamsAutomatically(config, firestore || db).catch(() => {});
      } catch (err) {
        console.error("F1 Scheduled sync failed:", err.message);
      }

      // 2. Sync FIFA Matches, Standings, and Stream Links
      try {
        await syncFotMobData(db);
        await syncFifaStreamsAndFeeds(db);

        // Push current active match to Firestore if enabled
        if (firestore) {
          const liveMatches = await db.getMatches("live");
          const activeMatch = liveMatches[0] || (await db.getMatches("notstarted"))[0] || (await db.getMatches("finished"))[0];
          if (activeMatch) {
            const streamsList = await db.getStreams(activeMatch.id);
            const fifaConfig = {
              raceData: {
                name: `${activeMatch.homeTeam} vs ${activeMatch.awayTeam}`,
                round: activeMatch.stage || "World Cup 2026",
                circuit: activeMatch.venue || "Stadium",
                location: activeMatch.venue || "FIFA Arena",
                date: formatIst(activeMatch.kickoff),
                homeScore: activeMatch.score?.split("-")[0]?.trim() || "0",
                awayScore: activeMatch.score?.split("-")[1]?.trim() || "0",
                isLive: activeMatch.status === "live",
                isFinished: activeMatch.status === "finished",
                matchTime: activeMatch.status === "live" ? "LIVE" : (activeMatch.status === "finished" ? "FT" : "0'")
              },
              customTimer: {
                enabled: activeMatch.status === "notstarted",
                target: new Date(activeMatch.kickoff).toISOString(),
                label: "KICKOFF COUNTDOWN"
              },
              streamLinks: streamsList.map((s, index) => ({
                name: `${s.provider.toUpperCase()} EN ${s.quality === "1080P" ? "(HD)" : ""}`.trim(),
                id: `stream_${activeMatch.id}_${index}`,
                url: s.embedUrl
              }))
            };
            await firestore.updateConfig({ fifa: fifaConfig });
          }
        }
      } catch (err) {
        console.error("FIFA Scheduled sync failed:", err.message);
      }

      console.log("[Scheduled Cron] Finished execution.");
    })());
  }
};
