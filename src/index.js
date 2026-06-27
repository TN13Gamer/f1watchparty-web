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
  syncFifaLiveFromStreamed,
  syncFifaMatchDetails,
  syncFifaStreams
} from "./sync";

import { API_URL as PUSH_EMB_API_URL, parseResponse, fixEmbedUrl } from "../api/providers/pushembdz";

import fallbackGames from "../api/fifa/fallback_games.json";
import fallbackTeams from "../api/fifa/fallback_teams.json";
import fallbackGroups from "../api/fifa/fallback_groups.json";

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
      // 1. GET /api/sync-standings
      if (path === "/api/sync-standings") {
        const type = url.searchParams.get("type");
        const manual = url.searchParams.get("manual") === "true";

        // Fetch current live config
        let config = firestore ? await firestore.getConfig() : await db.getConfig();

        // 1a) type=liveconfig
        if (type === "liveconfig") {
          return jsonResponse(config);
        }

        // 1b) type=fetchstreams
        if (type === "fetchstreams") {
          const res = await fetch(PUSH_EMB_API_URL);
          if (!res.ok) return jsonResponse({ error: `pushembdz API returned HTTP ${res.status}` }, 502);
          const data = await res.json();
          const { streams, warnings } = parseResponse(data);
          return jsonResponse({
            status: true,
            count: streams.length,
            warnings,
            categories: (data.categories || []).map(cat => ({
              ...cat,
              streams: (cat.streams || []).map(s => ({
                ...s,
                link: fixEmbedUrl(s.link)
              }))
            })),
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

        // 1c) type=fifapoll (GET or POST)
        if (type === "fifapoll") {
          const matchId = url.searchParams.get("matchId");
          if (!matchId) return jsonResponse({ error: "Missing matchId" }, 400);

          if (request.method === "GET") {
            const poll = await db.getPoll(matchId);
            return jsonResponse(poll);
          } else if (request.method === "POST") {
            const body = await request.json().catch(() => ({}));
            const voterId = body.voterId || "anonymous";
            const choice = body.choice;
            if (!["home", "away", "draw"].includes(choice)) {
              return jsonResponse({ error: "Invalid choice" }, 400);
            }
            const result = await db.castVote(matchId, voterId, choice);
            return jsonResponse(result);
          }
          return jsonResponse({ error: "Method not allowed" }, 405);
        }

        // 1d) Trigger background synchronizations
        const runAll = !type;
        let standingsSynced = false;
        let standingsUpdated = false;
        let standingsError = null;
        let syncedAt = null;
        let source = null;

        // F1 live / weather sync
        if (runAll || type === "f1live" || type === "standings") {
          await syncF1LiveAndWeather(config, firestore || db).catch(err => {
            console.error("F1 Live sync error:", err.message);
          });
        }

        // F1 standings sync
        if (runAll || type === "standings") {
          if (config.autoSyncStandings !== false || manual) {
            try {
              const result = await fetchStandings();
              source = result.source;
              if (result.dl && result.dl.length > 0) {
                const standings = config.standings || [];
                const constructors = config.constructors || [];

                result.dl.forEach(entry => {
                  const fullName = entry.Driver?.fullName || `${entry.Driver?.givenName} ${entry.Driver?.familyName}`;
                  const lastName = (entry.Driver?.familyName || "").toLowerCase();
                  const pts = parseInt(entry.points || 0, 10);
                  const idx = standings.findIndex(d => d.name && d.name.toLowerCase().includes(lastName));
                  if (idx !== -1) {
                    if (standings[idx].points !== pts) {
                      standings[idx].points = pts;
                      standingsUpdated = true;
                    }
                  } else {
                    standings.push({
                      name: fullName,
                      team: entry.Constructor?.name || "",
                      points: pts,
                      image: entry.image || ""
                    });
                    standingsUpdated = true;
                  }
                });
                standings.sort((a, b) => (b.points || 0) - (a.points || 0));

                if (result.cl?.length) {
                  result.cl.forEach(entry => {
                    const name = entry.Constructor?.name || "";
                    const pts = parseInt(entry.points || 0, 10);
                    const aliases = TEAM_ALIASES[name] || [name.toLowerCase()];
                    const idx = constructors.findIndex(c => {
                      if (!c.name) return false;
                      const n = c.name.toLowerCase();
                      return aliases.some(a => n.includes(a));
                    });
                    if (idx !== -1) {
                      if (constructors[idx].points !== pts) {
                        constructors[idx].points = pts;
                        standingsUpdated = true;
                      }
                    } else {
                      constructors.push({ name, points: pts });
                      standingsUpdated = true;
                    }
                  });
                  constructors.sort((a, b) => (b.points || 0) - (a.points || 0));
                }

                syncedAt = new Date().toISOString();
                const updatePayload = {
                  standings,
                  constructors,
                  lastStandingsSync: syncedAt,
                  standingsSource: source
                };
                if (firestore) await firestore.updateConfig(updatePayload);
                else await db.updateConfig(updatePayload);
                standingsSynced = true;
              }
            } catch (err) {
              console.error("F1 standings sync error:", err.message);
              standingsError = err.message;
            }
          }
        }

        // F1 streams sync
        let f1StreamsSynced = false;
        let f1StreamsError = null;
        if (runAll || type === "f1streams") {
          try {
            await syncStreamsAutomatically(config, firestore || db);
            f1StreamsSynced = true;
          } catch (err) {
            f1StreamsError = err.message;
          }
        }

        // FIFA match details sync
        let fifaDetailsSynced = false;
        let fifaDetailsError = null;
        let updatedFifaConfig = null;
        let streamedLiveSynced = false;
        if (runAll || type === "fifadetails" || (type === "fifastreams" && manual)) {
          const fifa = config.fifa || {};
          if (fifa.autoSyncDetails !== false || manual) {
            try {
              updatedFifaConfig = await syncFifaLiveFromStreamed(config, firestore || db);
              if (updatedFifaConfig) {
                config = { ...config, fifa: updatedFifaConfig };
                streamedLiveSynced = true;
                fifaDetailsSynced = true;
              }
            } catch (err) {
              fifaDetailsError = err.message;
            }

            if (!updatedFifaConfig) {
              try {
                updatedFifaConfig = await syncFifaMatchDetails(config, firestore || db, fallbackGames);
                if (updatedFifaConfig) {
                  config = { ...config, fifa: updatedFifaConfig };
                }
                fifaDetailsSynced = true;
              } catch (err) {
                fifaDetailsError = err.message;
              }
            }
          }
        }

        // FIFA streams sync
        let fifaStreamsSynced = false;
        let fifaStreamsError = null;
        if (runAll || type === "fifastreams") {
          try {
            if (streamedLiveSynced && config.fifa && Array.isArray(config.fifa.streamLinks) && config.fifa.streamLinks.length > 0) {
              // Already synced
            } else {
              await syncFifaStreams(config, firestore || db, { manual });
            }
            fifaStreamsSynced = true;
          } catch (err) {
            fifaStreamsError = err.message;
          }
        }

        const finalConfig = firestore ? await firestore.getConfig() : await db.getConfig();
        return jsonResponse({
          ok: true,
          sync: {
            standings: { synced: standingsSynced, updated: standingsUpdated, syncedAt, source, error: standingsError },
            f1Streams: { synced: f1StreamsSynced, error: f1StreamsError },
            fifaDetails: { synced: fifaDetailsSynced, source: streamedLiveSynced ? "streamed.st" : "worldcup26.ir", error: fifaDetailsError },
            fifaStreams: { synced: fifaStreamsSynced, error: fifaStreamsError }
          },
          data: {
            standings: finalConfig.standings || [],
            constructors: finalConfig.constructors || [],
            lastStandingsSync: finalConfig.lastStandingsSync || syncedAt,
            standingsSource: finalConfig.standingsSource || source,
            streamLinks: finalConfig.streamLinks || [],
            fifa: finalConfig.fifa || {}
          }
        });
      }

      // 2. GET /api/fetch-streams
      if (path === "/api/fetch-streams") {
        const q = url.searchParams.get("q") || "";
        const raw = url.searchParams.get("raw") === "1";

        const res = await fetch(PUSH_EMB_API_URL);
        if (!res.ok) return jsonResponse({ ok: false, error: "Failed to fetch streams" }, 502);
        const data = await res.json();
        const { streams, warnings } = parseResponse(data);

        let result = streams;
        const tokens = parseTokens(q);
        if (tokens.length > 0 && !raw) {
          result = streams
            .map(s => ({ s, score: scoreStream(s, tokens) }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(x => x.s);
        }

        return jsonResponse({
          ok: true,
          count: result.length,
          streams: result,
          warnings,
          fetchedAt: new Date().toISOString()
        });
      }

      // 3. GET /api/fifa/fixtures
      if (path === "/api/fifa/fixtures") {
        // Retrieve fixtures directly from worldcup26.ir or local fallback
        const cacheVal = await env.CONFIG_KV.get("fifa_fixtures");
        if (cacheVal) {
          return jsonResponse(JSON.parse(cacheVal));
        }

        const res = await fetch("https://worldcup26.ir/get/games").catch(() => null);
        if (res && res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.games)) {
            // Cache in KV for 60 seconds
            await env.CONFIG_KV.put("fifa_fixtures", JSON.stringify(data.games), { expirationTtl: 60 });
            return jsonResponse(data.games);
          }
        }

        // Return fallback games list if API fails
        return jsonResponse(fallbackGames.games || []);
      }

      // 4. GET /api/fifa/standings
      if (path === "/api/fifa/standings") {
        // Retrieve standings from worldcup26.ir or local fallback
        const cacheVal = await env.CONFIG_KV.get("fifa_standings");
        if (cacheVal) {
          return jsonResponse(JSON.parse(cacheVal));
        }

        const res = await fetch("https://worldcup26.ir/get/groups").catch(() => null);
        if (res && res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.groups)) {
            // Cache in KV for 60 seconds
            await env.CONFIG_KV.put("fifa_standings", JSON.stringify(data.groups), { expirationTtl: 60 });
            return jsonResponse(data.groups);
          }
        }

        // Return fallback groups if API fails
        return jsonResponse(fallbackGroups.groups || []);
      }

      // 5. GET /api/fifa/details
      if (path === "/api/fifa/details") {
        const save = url.searchParams.get("save") === "true";
        let config = firestore ? await firestore.getConfig() : await db.getConfig();
        const updatedFifa = await syncFifaMatchDetails(config, firestore || db, fallbackGames);
        return jsonResponse({
          ok: !!updatedFifa,
          raceData: updatedFifa?.raceData || config.fifa?.raceData || null
        });
      }

      // 6. GET /api/fifa/poll or POST /api/fifa/poll
      if (path === "/api/fifa/poll") {
        const matchId = url.searchParams.get("matchId");
        if (!matchId) return jsonResponse({ error: "Missing matchId" }, 400);

        if (request.method === "GET") {
          const poll = await db.getPoll(matchId);
          return jsonResponse(poll);
        } else if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const voterId = body.voterId;
          const choice = body.choice;
          if (!voterId) return jsonResponse({ error: "Missing voterId" }, 400);
          if (!["home", "away", "draw"].includes(choice)) return jsonResponse({ error: "Invalid choice" }, 400);

          const result = await db.castVote(matchId, voterId, choice);
          return jsonResponse(result);
        }
        return jsonResponse({ error: "Method not allowed" }, 405);
      }

      // 7. GET /api/chat/stream (Chat Message History)
      if (path === "/api/chat/stream") {
        const messages = await db.getChatMessages(60);
        return jsonResponse({ type: "chatList", data: messages });
      }

      // 8. POST /api/chat/send
      if (path === "/api/chat/send") {
        const body = await request.json().catch(() => ({}));
        if (!body.username || !body.text) {
          return jsonResponse({ error: "Missing username or text" }, 400);
        }
        const message = await db.addChatMessage({
          username: body.username,
          text: body.text,
          color: body.color,
          isAdmin: !!body.isAdmin
        });
        return jsonResponse(message);
      }

      // 9. POST /api/chat/delete
      if (path === "/api/chat/delete") {
        const body = await request.json().catch(() => ({}));
        if (!body.id) return jsonResponse({ error: "Missing message id" }, 400);
        await db.deleteChatMessage(body.id);
        return jsonResponse({ success: true });
      }

      // 10. POST /api/chat/clear
      if (path === "/api/chat/clear") {
        await db.clearChatMessages();
        return jsonResponse({ success: true });
      }

      // Endpoint Not Found
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
      let config = firestore ? await firestore.getConfig() : await db.getConfig();

      // 1. Sync F1 Live Session status & Weather
      await syncF1LiveAndWeather(config, firestore || db).catch(err => {
        console.error("[Cron Sync] F1 live sync failed:", err.message);
      });

      // 2. Sync F1 Standings
      if (config.autoSyncStandings !== false) {
        try {
          const result = await fetchStandings();
          if (result.dl && result.dl.length > 0) {
            const standings = config.standings || [];
            const constructors = config.constructors || [];

            result.dl.forEach(entry => {
              const fullName = entry.Driver?.fullName || `${entry.Driver?.givenName} ${entry.Driver?.familyName}`;
              const lastName = (entry.Driver?.familyName || "").toLowerCase();
              const pts = parseInt(entry.points || 0, 10);
              const idx = standings.findIndex(d => d.name && d.name.toLowerCase().includes(lastName));
              if (idx !== -1) {
                standings[idx].points = pts;
              } else {
                standings.push({
                  name: fullName,
                  team: entry.Constructor?.name || "",
                  points: pts,
                  image: entry.image || ""
                });
              }
            });
            standings.sort((a, b) => (b.points || 0) - (a.points || 0));

            if (result.cl?.length) {
              result.cl.forEach(entry => {
                const name = entry.Constructor?.name || "";
                const pts = parseInt(entry.points || 0, 10);
                const aliases = TEAM_ALIASES[name] || [name.toLowerCase()];
                const idx = constructors.findIndex(c => {
                  if (!c.name) return false;
                  const n = c.name.toLowerCase();
                  return aliases.some(a => n.includes(a));
                });
                if (idx !== -1) {
                  constructors[idx].points = pts;
                } else {
                  constructors.push({ name, points: pts });
                }
              });
              constructors.sort((a, b) => (b.points || 0) - (a.points || 0));
            }

            const updatePayload = {
              standings,
              constructors,
              lastStandingsSync: new Date().toISOString(),
              standingsSource: result.source
            };
            if (firestore) await firestore.updateConfig(updatePayload);
            else await db.updateConfig(updatePayload);
          }
        } catch (err) {
          console.error("[Cron Sync] F1 standings sync failed:", err.message);
        }
      }

      // 3. Sync F1 Streams
      await syncStreamsAutomatically(config, firestore || db).catch(err => {
        console.error("[Cron Sync] F1 streams sync failed:", err.message);
      });

      // 4. Sync FIFA Match Details
      let updatedFifaConfig = null;
      let streamedLiveSynced = false;
      try {
        updatedFifaConfig = await syncFifaLiveFromStreamed(config, firestore || db);
        if (updatedFifaConfig) {
          config = { ...config, fifa: updatedFifaConfig };
          streamedLiveSynced = true;
        }
      } catch (err) {
        console.error("[Cron Sync] FIFA streamed.st sync failed:", err.message);
      }

      if (!updatedFifaConfig) {
        try {
          updatedFifaConfig = await syncFifaMatchDetails(config, firestore || db, fallbackGames);
          if (updatedFifaConfig) {
            config = { ...config, fifa: updatedFifaConfig };
          }
        } catch (err) {
          console.error("[Cron Sync] FIFA details sync failed:", err.message);
        }
      }

      // 5. Sync FIFA Streams
      try {
        if (streamedLiveSynced && config.fifa && Array.isArray(config.fifa.streamLinks) && config.fifa.streamLinks.length > 0) {
          // Already synced
        } else {
          await syncFifaStreams(config, firestore || db);
        }
      } catch (err) {
        console.error("[Cron Sync] FIFA streams sync failed:", err.message);
      }

      console.log("[Scheduled Cron] Finished execution.");
    })());
  }
};
