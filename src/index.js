import { D1Database } from "./db";
import { FirestoreClient } from "./firebase";
import {
  syncF1LiveAndWeather,
  fetchStandings,
  syncStreamsAutomatically,
  syncFotMobData,
  syncMatchDetails,
  syncFifaStreamsAndFeeds,
  syncF1Streams,
  syncF1Schedule
} from "./sync";

import { API_URL as PUSH_EMB_API_URL, parseResponse, fixEmbedUrl } from "../api/providers/pushembdz";
import { fetchGoogleSportsMatches, mergeGoogleScoresIntoFixtures, syncGoogleScoresToDb } from "./fifa/google-sports";
import { getAllStadiums, findStadium, searchStadiums } from "./fifa/stadiums";
import { fifaHtml, adminHtml } from "./fifa/embed-html";

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

    const db = new D1Database(env.DB);
    let firestore = null;
    if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
      firestore = new FirestoreClient(env.FIREBASE_PROJECT_ID, env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
    }

    const log = (msg) => console.log(`[worker] ${msg}`);

    // -----------------------------------------------------------
    // SYNC ENGINE
    // -----------------------------------------------------------
    async function runSyncPipeline() {
      const startTime = Date.now();
      const steps = [];
      const logs = [];
      let updated = 0;
      let error = null;

      logs.push("Manual sync started");
      log("Manual sync started");

      try {
        logs.push("Fetching football fixtures from FotMob...");
        log("Fetching fixtures...");
        await syncFotMobData(db);
        steps.push("fixtures:ok");
        logs.push("Fixtures fetched successfully");
      } catch (e) {
        const msg = `Fixture fetch failed: ${e.message}`;
        logs.push(msg);
        log(msg);
        steps.push("fixtures:fail");
        if (!error) error = msg;
      }

      try {
        logs.push("Fetching match details from FotMob...");
        log("Fetching match details...");
        await syncMatchDetails(db);
        steps.push("details:ok");
        logs.push("Match details updated");
      } catch (e) {
        const msg = `Match details fetch failed: ${e.message}`;
        logs.push(msg);
        log(msg);
        steps.push("details:fail");
        if (!error) error = msg;
      }

      try {
        logs.push("Fetching streams from streamed.pk...");
        log("Fetching streams...");
        await syncFifaStreamsAndFeeds(db);
        const totalStreams = await db.d1.prepare("SELECT count(*) as c FROM streams").first("c") || 0;
        updated = totalStreams;
        steps.push("streams:ok");
        logs.push(`Streams synced: ${totalStreams} in database`);
      } catch (e) {
        const msg = `Stream fetch failed: ${e.message}`;
        logs.push(msg);
        log(msg);
        steps.push("streams:fail");
        if (!error) error = msg;
      }

      try {
        logs.push("Syncing live scores from Google Sports...");
        log("Syncing live scores...");
        const googleResult = await syncGoogleScoresToDb(db, env.CONFIG_KV);
        if (googleResult.source) {
          await env.CONFIG_KV.put("fifa_live_score_source", googleResult.source).catch(() => {});
        }
        steps.push(googleResult.errors.length === 0 ? "livescores:ok" : "livescores:warn");
        logs.push(`Live scores synced: ${googleResult.synced} matches, source: ${googleResult.source || "none"}`);
        if (googleResult.errors.length) {
          logs.push(`Live score warnings: ${googleResult.errors.join("; ")}`);
        }
      } catch (e) {
        const msg = `Live scores sync failed: ${e.message}`;
        logs.push(msg); log(msg);
        steps.push("livescores:fail");
        if (!error) error = msg;
      }

      try {
        await env.CONFIG_KV.put("fifa_last_sync_time", new Date().toISOString());
        await env.CONFIG_KV.put("fifa_last_sync_status", steps.includes("fixtures:ok") ? "OK" : "Partial");
      } catch (e) {}

      if (firestore) {
        try {
          const liveMatches = await db.getMatches("live");
          const upcomingMatches = (await db.getMatches("notstarted"))
            .filter(m => m.kickoff && m.kickoff > (Date.now() - 2.5 * 60 * 60 * 1000));
          const finishedMatches = await db.getMatches("finished");
          const activeMatch = liveMatches[0] || upcomingMatches[0] || finishedMatches[finishedMatches.length - 1];
          if (activeMatch) {
            const streamsList = await db.getStreams(activeMatch.id);
            const mCircuit = activeMatch?.venue || activeMatch?.stadium || 'Venue to be confirmed';
            const mLocation = activeMatch?.city ? `${activeMatch.city}${activeMatch.country ? ', ' + activeMatch.country : ''}` : mCircuit;
            await firestore.updateConfig({
              fifa: {
                raceData: {
                  name: `${activeMatch.homeTeam} vs ${activeMatch.awayTeam}`,
                  round: activeMatch.stage || "World Cup 2026",
                  circuit: mCircuit, location: mLocation,
                  date: formatIst(activeMatch.kickoff),
                  homeScore: activeMatch.score?.split("-")[0]?.trim() || "0",
                  awayScore: activeMatch.score?.split("-")[1]?.trim() || "0",
                  isLive: activeMatch.status === "live",
                  isFinished: activeMatch.status === "finished",
                  matchTime: activeMatch.status === "live" ? (activeMatch.matchTime || "LIVE") : (activeMatch.status === "finished" ? "FT" : "0'")
                },
                customTimer: {
                  enabled: activeMatch.status === "notstarted",
                  target: new Date(activeMatch.kickoff).toISOString(),
                  label: "KICKOFF COUNTDOWN"
                },
                streamLinks: streamsList.map((s, i) => ({
                  name: s.provider.toUpperCase(),
                  id: `stream_${activeMatch.id}_${i}`, url: s.embedUrl,
                  lang: s.language || "EN",
                  quality: s.quality || "720P"
                }))
              }
            });
            logs.push("Firestore config updated");
          }
        } catch (e) { log(`Firestore push failed: ${e.message}`); logs.push(`Firestore push failed: ${e.message}`); }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const status = error ? "failed" : "success";
      logs.push(`Sync ${status}: ${updated} streams in ${elapsed}s`);
      log(`Sync ${status}: ${updated} streams in ${elapsed}s`);

      try {
        const execRecord = {
          timestamp: new Date().toISOString(),
          status,
          steps,
          updated,
          elapsed,
          error,
          logs: logs.slice(-50)
        };
        const existingLogs = JSON.parse(await env.CONFIG_KV.get("fifa_sync_execution_logs").catch(() => "[]") || "[]");
        existingLogs.unshift(execRecord);
        if (existingLogs.length > 20) existingLogs.length = 20;
        await env.CONFIG_KV.put("fifa_sync_execution_logs", JSON.stringify(existingLogs));
        await env.CONFIG_KV.put("fifa_last_sync_detail", JSON.stringify(execRecord));
      } catch (e) {}

      return { updated, steps, status, elapsed, error, logs };
    }

    try {
      // ---- F1 legacy endpoints ----
      if (path === "/api/sync-standings") {
        const type = url.searchParams.get("type");
        let config = firestore ? await firestore.getConfig() : await db.getConfig();

        if (type === "liveconfig") {
          const liveMatches = await db.getMatches("live");
          const upcomingMatches = (await db.getMatches("notstarted"))
            .filter(m => m.kickoff && m.kickoff > (Date.now() - 2.5 * 60 * 60 * 1000));
          const finishedMatches = await db.getMatches("finished");
          const activeMatch = liveMatches[0] || upcomingMatches[0] || finishedMatches[finishedMatches.length - 1];
          const matchStreams = activeMatch ? await db.getStreams(activeMatch.id) : [];
          const matchCircuit = activeMatch?.venue || activeMatch?.stadium || 'Venue to be confirmed';
          const matchLocation = activeMatch?.city ? `${activeMatch.city}${activeMatch.country ? ', ' + activeMatch.country : ''}` : matchCircuit;
          const fifaConfig = {
            raceData: activeMatch ? {
              name: `${activeMatch.homeTeam} vs ${activeMatch.awayTeam}`,
              round: activeMatch.stage || "World Cup 2026",
              circuit: matchCircuit, location: matchLocation,
              date: formatIst(activeMatch.kickoff),
              homeScore: activeMatch.score?.split("-")[0]?.trim() || "0",
              awayScore: activeMatch.score?.split("-")[1]?.trim() || "0",
              isLive: activeMatch.status === "live",
              isFinished: activeMatch.status === "finished",
              matchTime: activeMatch.status === "live" ? (activeMatch.matchTime || "LIVE") : (activeMatch.status === "finished" ? "FT" : "0'")
            } : {},
            customTimer: {
              enabled: activeMatch && activeMatch.status === "notstarted",
              target: activeMatch ? new Date(activeMatch.kickoff).toISOString() : new Date().toISOString(),
              label: "KICKOFF COUNTDOWN"
            },
            streamLinks: matchStreams.map((s, index) => ({
              name: `${s.provider.toUpperCase()} EN ${s.quality === "1080P" ? "(HD)" : ""}`.trim(),
              id: `stream_${activeMatch.id}_${index}`, url: s.embedUrl
            }))
          };
          return jsonResponse({ ...config, fifa: fifaConfig });
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
          await syncF1LiveAndWeather(config, firestore || db).catch(() => {});
          return jsonResponse({ success: true });
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

      // ---- FIFA endpoints ----
      if (path === "/api/fifa/fixtures") {
        const results = await db.getMatches();
        const mapped = results.map(r => ({
          id: r.id, homeTeam: r.homeTeam, awayTeam: r.awayTeam,
          homeLogo: r.homeLogo, awayLogo: r.awayLogo,
          homeFlag: r.homeFlag, awayFlag: r.awayFlag,
          kickoffTs: r.kickoff, localDate: formatIst(r.kickoff),
          status: r.status,
          homeScore: parseInt(r.score?.split("-")[0]?.trim() || "0", 10),
          awayScore: parseInt(r.score?.split("-")[1]?.trim() || "0", 10),
          finished: r.status === "finished",
          stadium: r.venue || r.stadium || 'Venue to be confirmed',
          city: r.city || '', country: r.country || '',
          round: r.groupName || "Group Stage"
        }));
        return jsonResponse(mapped);
      }

      if (path === "/api/fifa/standings") {
        const results = await db.getStandings();
        const groups = {};
        results.forEach(r => {
          const groupName = r.groupName || "Group";
          if (groupName.includes("3rd") || groupName.toLowerCase().includes("third")) return;
          if (!groups[groupName]) groups[groupName] = [];
          groups[groupName].push({ name: r.team, mp: r.played, w: r.wins, d: r.draws, l: r.losses, gd: r.goalDifference, pts: r.points, flag: r.flag });
        });
        return jsonResponse(Object.keys(groups).map(g => ({ name: g, teams: groups[g] })));
      }

      if (path === "/api/fifa/details") {
        const matches = await db.getMatches("live");
        const upcomingMatches = (await db.getMatches("notstarted"))
          .filter(m => m.kickoff && m.kickoff > (Date.now() - 2.5 * 60 * 60 * 1000));
        const finishedMatches = await db.getMatches("finished");
        const match = matches[0] || upcomingMatches[0] || finishedMatches[finishedMatches.length - 1] || null;
        if (!match) return jsonResponse({ ok: true, raceData: {}, customTimer: {} });
        return jsonResponse({
          ok: true, source: 'Cloudflare D1 (populated by syncFotMobData)',
          raceData: {
            name: `${match.homeTeam} vs ${match.awayTeam}`, round: match.stage || "World Cup 2026",
            circuit: match.venue || match.stadium || 'Venue to be confirmed',
            location: match.city ? `${match.city}${match.country ? ', ' + match.country : ''}` : (match.venue || 'Venue to be confirmed'),
            date: formatIst(match.kickoff), homeScore: match.score?.split("-")[0]?.trim() || "0",
            awayScore: match.score?.split("-")[1]?.trim() || "0",
            isLive: match.status === "live", isFinished: match.status === "finished",
            matchTime: match.status === "live" ? "LIVE" : (match.status === "finished" ? "FT" : "0'")
          },
          customTimer: { enabled: match.status === "notstarted", target: new Date(match.kickoff).toISOString(), label: "KICKOFF COUNTDOWN" },
          lastDetailsSync: new Date().toISOString(), stadiumInfo: { name: match.venue || 'Venue to be confirmed', city: match.city || '', country: match.country || '' }
        });
      }

      if (path === "/api/fifa/streams") {
        const matchId = url.searchParams.get("matchId") || 'current';
        const streams = await db.getStreams(matchId);
        return jsonResponse({ ok: true, matchId, count: streams.length, streams });
      }

      // ---- FIFA Live Scores (Google Sports) ----
      if (path === "/api/fifa/live-scores") {
        const result = await fetchGoogleSportsMatches(env.CONFIG_KV);
        const fixtures = await db.getMatches();
        const merged = mergeGoogleScoresIntoFixtures(result.matches, fixtures);
        return jsonResponse({
          success: true,
          source: result.source,
          googleMatches: result.matches,
          merged: merged.map(m => ({
            id: m.id, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
            homeLogo: m.homeLogo, awayLogo: m.awayLogo,
            homeFlag: m.homeFlag, awayFlag: m.awayFlag,
            homeScore: m.googleHomeScore ?? parseInt(m.score?.split("-")[0]?.trim() || "0", 10),
            awayScore: m.googleAwayScore ?? parseInt(m.score?.split("-")[1]?.trim() || "0", 10),
            status: m.googleStatus || m.status,
            matchTime: m.googleMatchTime || m.matchTime || null,
            minute: m.googleMinute || null,
            venue: m.googleVenue || m.venue || 'Venue to be confirmed',
            city: m.googleVenueCity || m.city || '',
            country: m.googleVenueCountry || m.country || '',
            stadiumImage: m.googleStadiumImage || null,
            stadiumCapacity: m.googleStadiumCapacity || null,
            groupName: m.groupName || "Group Stage",
            stage: m.stage || "",
            localDate: formatIst(m.kickoff),
            kickoffTs: m.kickoff,
            round: m.groupName || "Group Stage"
          })),
          errors: result.errors,
          timestamp: new Date().toISOString()
        });
      }

      if (path === "/api/fifa/live-scores/sync") {
        if (method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);
        const result = await syncGoogleScoresToDb(db, env.CONFIG_KV);
        return jsonResponse({ success: true, ...result });
      }

      // ---- FIFA Stadiums ----
      if (path === "/api/fifa/stadiums") {
        const all = getAllStadiums();
        return jsonResponse({ success: true, count: all.length, stadiums: all });
      }

      if (path === "/api/fifa/stadiums/search") {
        const query = url.searchParams.get("q") || "";
        const results = searchStadiums(query);
        return jsonResponse({ success: true, count: results.length, stadiums: results });
      }

      if (path.startsWith("/api/fifa/stadiums/") && path !== "/api/fifa/stadiums/search") {
        const idOrName = decodeURIComponent(path.split("/").pop());
        const asNum = parseInt(idOrName, 10);
        const stadium = isNaN(asNum) ? findStadium(idOrName) : getAllStadiums().find(s => s.id === asNum);
        if (!stadium) return jsonResponse({ success: false, error: "Stadium not found" }, 404);
        return jsonResponse({ success: true, stadium });
      }

      // ---- FIFA Sync Endpoints (Admin) ----
      if (path === "/api/fifa/sync-all") {
        if (method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);
        const result = await runSyncPipeline();
        return jsonResponse({ success: true, message: `Sync complete: ${result.steps.join(", ")}`, ...result });
      }

      if (path === "/api/fifa/sync-scores") {
        if (method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);
        const result = await syncGoogleScoresToDb(db, env.CONFIG_KV);
        return jsonResponse({ success: true, message: `Synced ${result.synced} matches`, ...result });
      }

      if (path === "/api/fifa/sync-fixtures") {
        if (method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);
        await syncFotMobData(db);
        return jsonResponse({ success: true, message: "Fixtures synced" });
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
        const totalMatches = await db.d1.prepare("SELECT count(*) as c FROM matches").first("c") || 0;
        const liveMatches = await db.d1.prepare("SELECT count(*) as c FROM matches WHERE status = 'live'").first("c") || 0;
        const upcomingMatches = await db.d1.prepare("SELECT count(*) as c FROM matches WHERE status = 'notstarted'").first("c") || 0;
        const finishedMatches = await db.d1.prepare("SELECT count(*) as c FROM matches WHERE status = 'finished'").first("c") || 0;
        const streamsAvailable = await db.d1.prepare("SELECT count(*) as c FROM streams WHERE status = 1").first("c") || 0;
        const { results: missingCount } = await db.d1.prepare(`SELECT count(*) as c FROM matches WHERE status IN ('live', 'notstarted') AND id NOT IN (SELECT DISTINCT matchId FROM streams WHERE status = 1)`).all();
        const streamsMissing = missingCount && missingCount[0] ? missingCount[0].c : 0;
        const lastSync = await env.CONFIG_KV.get("fifa_last_sync_time").catch(() => null) || "Never";
        const syncStatus = await env.CONFIG_KV.get("fifa_last_sync_status").catch(() => null) || "Idle";

        // F1 status
        const f1StreamsCount = await env.CONFIG_KV.get("f1_streams_count").catch(() => null);
        const f1ScheduleRace = await env.CONFIG_KV.get("f1_schedule_race").catch(() => null);
        const f1ScheduleCount = await env.CONFIG_KV.get("f1_schedule_count").catch(() => null);
        const f1ScheduleLastSync = await env.CONFIG_KV.get("f1_schedule_last_sync").catch(() => null);
        const f1StreamsLastResult = await env.CONFIG_KV.get("f1_streams_last_result").catch(() => null);

        return jsonResponse({
          success: true,
          totalMatches, liveMatches, upcomingMatches, finishedMatches,
          streamsAvailable, streamsMissing, lastSync, syncStatus,
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
        const totalMatches = await db.d1.prepare("SELECT count(*) as c FROM matches").first("c") || 0;
        const liveMatches = await db.d1.prepare("SELECT count(*) as c FROM matches WHERE status = 'live'").first("c") || 0;
        const upcomingMatches = await db.d1.prepare("SELECT count(*) as c FROM matches WHERE status = 'notstarted'").first("c") || 0;
        const finishedMatches = await db.d1.prepare("SELECT count(*) as c FROM matches WHERE status = 'finished'").first("c") || 0;
        const streamsAvailable = await db.d1.prepare("SELECT count(*) as c FROM streams WHERE status = 1").first("c") || 0;
        const { results: missingCount } = await db.d1.prepare(`SELECT count(*) as c FROM matches WHERE status IN ('live', 'notstarted') AND id NOT IN (SELECT DISTINCT matchId FROM streams WHERE status = 1)`).all();
        const streamsMissing = missingCount && missingCount[0] ? missingCount[0].c : 0;
        const lastSync = await env.CONFIG_KV.get("fifa_last_sync_time").catch(() => null) || "Never";
        const syncStatus = await env.CONFIG_KV.get("fifa_last_sync_status").catch(() => null) || "Idle";
        const f1ScheduleRace = await env.CONFIG_KV.get("f1_schedule_race").catch(() => null);
        const lastLiveScoreSource = await env.CONFIG_KV.get("fifa_live_score_source").catch(() => null);
        const stadiumCount = await db.d1.prepare("SELECT count(DISTINCT venue) as c FROM matches WHERE venue IS NOT NULL AND venue != 'Venue to be confirmed'").first("c") || 0;
        const failedStadiums = await db.d1.prepare("SELECT count(*) as c FROM matches WHERE venue = 'Venue to be confirmed' AND status != 'notstarted'").first("c") || 0;
        const { results: venuesNull } = await db.d1.prepare(`SELECT homeTeam, awayTeam FROM matches WHERE (venue IS NULL OR venue = '' OR venue = 'Venue to be confirmed') AND status IN ('live', 'notstarted')`).all();
        return jsonResponse({ totalMatches, liveMatches, upcomingMatches, finishedMatches, streamsAvailable, streamsMissing, lastSync, syncStatus, f1ScheduleRace, lastLiveScoreSource, stadiumCount, failedStadiums, matchesWithoutVenue: venuesNull || [] });
      }

      if (path === "/api/admin/sync-now" || path === "/api/admin/sync") {
        if (method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);
        ctx.waitUntil((async () => {
          const result = await runSyncPipeline();
          await env.CONFIG_KV.put("fifa_last_sync_time", new Date().toISOString());
          await env.CONFIG_KV.put("fifa_last_sync_status", "OK");
          return result;
        })());
        return jsonResponse({ success: true, updated: 0, message: "Sync cycle started in background." });
      }

      if (path === "/admin/resync") {
        if (method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);
        const result = await runSyncPipeline();
        return jsonResponse({ success: true, updated: result.updated, message: `${result.updated} matches synced successfully.` });
      }

      if (path === "/api/admin/sync-status") {
        const lastSync = await env.CONFIG_KV.get("fifa_last_sync_time").catch(() => null);
        const lastStatus = await env.CONFIG_KV.get("fifa_last_sync_status").catch(() => null);
        const lastDetail = await env.CONFIG_KV.get("fifa_last_sync_detail").catch(() => null);
        return jsonResponse({
          success: true,
          lastSync,
          lastStatus,
          lastDetail: lastDetail ? JSON.parse(lastDetail) : null,
          workerTimestamp: new Date().toISOString()
        });
      }

      if (path === "/api/admin/logs") {
        const execLogs = await env.CONFIG_KV.get("fifa_sync_execution_logs").catch(() => null);
        const lastDetail = await env.CONFIG_KV.get("fifa_last_sync_detail").catch(() => null);
        return jsonResponse({
          success: true,
          logs: execLogs ? JSON.parse(execLogs) : [],
          lastDetail: lastDetail ? JSON.parse(lastDetail) : null,
          worker: "watchparty-backend",
          version: "b0bb9b11-3369-4f94-9ba3-30079d24520a",
          timestamp: new Date().toISOString()
        });
      }

      if (path === "/api/admin/review-queue") {
        return jsonResponse([]);
      }

      if (path.startsWith("/api/admin/approve/") && method === "POST") {
        return jsonResponse({ success: false, error: "Stream review queue not available. Streams are auto-assigned by cron." }, 501);
      }

      if (path.startsWith("/api/admin/ignore/") && method === "POST") {
        return jsonResponse({ success: false, error: "Stream review queue not available. Streams are auto-assigned by cron." }, 501);
      }

      if (path === "/api/admin/match/edit" && method === "POST") {
        const body = await getBody(request);
        if (!body.id) return jsonResponse({ success: false, error: "Missing match ID" }, 400);
        const success = await db.updateMatchDetails(body.id, {
          venue: body.venue, city: body.city || null, country: body.country || null,
          kickoff: body.kickoff ? new Date(body.kickoff).getTime() : Date.now(),
          groupName: body.groupName, stage: body.stage,
          referee: body.referee || null, attendance: body.attendance ? parseInt(body.attendance, 10) : null,
          weather: body.weather || null, broadcasters: body.broadcasters,
          description: body.description, thumbnail: body.thumbnail, banner: body.banner
        });
        return jsonResponse({ success });
      }

      if (path === "/api/admin/match/details-sync" && method === "POST") {
        const body = await getBody(request);
        if (!body.matchId) return jsonResponse({ success: false, error: "Missing matchId" }, 400);
        const match = await db.getMatch(body.matchId);
        if (!match) return jsonResponse({ success: false, error: "Match not found" }, 404);
        if (!match.fotmobPageUrl) return jsonResponse({ success: false, error: "No FotMob page URL for this match" }, 400);
        try {
          const html = await fetch(match.fotmobPageUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
          }).then(r => r.text());
          const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
          if (!nextDataMatch) return jsonResponse({ success: false, error: "Could not parse FotMob match page" }, 502);
          const data = JSON.parse(nextDataMatch[1]);
          const infoBox = data.props?.pageProps?.content?.matchFacts?.infoBox;
          if (!infoBox) return jsonResponse({ success: false, error: "No infoBox in match data" }, 502);
          const stadium = infoBox["Stadium"]; const referee = infoBox["Referee"]; const attendance = infoBox["Attendance"];
          await db.updateMatchDetails(match.id, {
            venue: stadium?.name || 'Venue to be confirmed', city: stadium?.city || null, country: stadium?.country || null,
            kickoff: match.kickoff, groupName: match.groupName, stage: match.stage,
            referee: referee?.text || null, attendance: typeof attendance === 'number' ? attendance : null,
            weather: null, broadcasters: match.broadcasters, description: match.description,
            thumbnail: match.thumbnail, banner: match.banner
          });
          return jsonResponse({ success: true, match: await db.getMatch(match.id) });
        } catch (err) {
          return jsonResponse({ success: false, error: err.message }, 500);
        }
      }

      if (path === "/api/admin/stream/add" && method === "POST") {
        const body = await getBody(request);
        if (!body.matchId || !body.embedUrl) return jsonResponse({ success: false, error: "Missing matchId or embedUrl" }, 400);
        const success = await db.adminSaveStream(body);
        const streams = await db.getAllStreams(body.matchId);
        return jsonResponse({ success, streams });
      }

      if (path === "/api/admin/stream/edit" && method === "POST") {
        const body = await getBody(request);
        if (!body.embedUrl) return jsonResponse({ success: false, error: "Missing embedUrl" }, 400);
        if (body.isPrimary && body.matchId) await db.setStreamPrimary(body.matchId, body.embedUrl);
        await db.d1.prepare("UPDATE streams SET quality = ?, language = ?, priority = ?, status = ? WHERE embedUrl = ?")
          .bind(body.quality || "720P", body.language || "EN", body.priority || 0, body.status !== undefined ? body.status : 1, body.embedUrl).run();
        return jsonResponse({ success: true });
      }

      if (path === "/api/admin/stream/delete" && method === "POST") {
        const body = await getBody(request);
        if (!body.embedUrl) return jsonResponse({ success: false, error: "Missing embedUrl" }, 400);
        const success = await db.deleteStream(body.embedUrl);
        return jsonResponse({ success });
      }

      if (path === "/api/admin/update-stream" && method === "POST") {
        const body = await getBody(request);
        if (!body.matchId || !body.embedUrl) return jsonResponse({ success: false, error: "Missing matchId or embedUrl" }, 400);
        const success = await db.adminSaveStream(body);
        return jsonResponse({ success });
      }

      // ---- Fallback stream management (KV) ----
      if (path === "/api/admin/stream/fallback" && method === "POST") {
        const body = await getBody(request);
        if (!body.matchId) return jsonResponse({ success: false, error: "Missing matchId" }, 400);
        const existing = JSON.parse((await env.CONFIG_KV.get(`stream_fallback_${body.matchId}`).catch(() => "[]")) || "[]");
        if (body.embedUrl) {
          existing.push({
            provider: body.provider || "default",
            quality: body.quality || "720P",
            embedUrl: body.embedUrl,
            language: body.language || "EN",
            mirror: existing.length,
            isPrimary: existing.length === 0 ? 1 : 0,
            priority: existing.length
          });
        }
        await env.CONFIG_KV.put(`stream_fallback_${body.matchId}`, JSON.stringify(existing));
        return jsonResponse({ success: true, streams: existing });
      }
      if (path === "/api/admin/stream/fallback" && method === "DELETE") {
        const body = await getBody(request);
        if (!body.matchId) return jsonResponse({ success: false, error: "Missing matchId" }, 400);
        if (body.embedUrl) {
          const existing = JSON.parse((await env.CONFIG_KV.get(`stream_fallback_${body.matchId}`).catch(() => "[]")) || "[]");
          const filtered = existing.filter(s => s.embedUrl !== body.embedUrl);
          await env.CONFIG_KV.put(`stream_fallback_${body.matchId}`, JSON.stringify(filtered));
          return jsonResponse({ success: true, streams: filtered });
        }
        await env.CONFIG_KV.delete(`stream_fallback_${body.matchId}`);
        return jsonResponse({ success: true });
      }

      if (path === "/api/debug/stream-sources") {
        const sources = await testStreamSources();
        return jsonResponse({ sources });
      }

      if (path === "/api/debug") {
        const matches = await db.getMatches();
        const streamsCount = await db.d1.prepare("SELECT count(*) as c FROM streams").first("c") || 0;
        return jsonResponse({
          sources: {
            fixtures: { url: 'D1 matches table (syncFotMobData cron)', cache: 'D1 persistent', count: matches.length },
            standings: { url: 'D1 standings table (syncFotMobData cron)', cache: 'D1 persistent' },
            streams: { api: '/api/streams/:matchId → D1 streams table', provider: 'pushembdz.store', matcher: 'streamed.st/api/matches/all' },
            stadium: { type: 'D1 matches.venue + city + country (FotMob sync)' },
            config: { firestore: 'app_data/live_config (Firebase)', kv: 'CONFIG_KV' }
          },
          matches: { total: matches.length, live: matches.filter(m => m.status === 'live').length, upcoming: matches.filter(m => m.status === 'notstarted').length, finished: matches.filter(m => m.status === 'finished').length },
          streams: { total: streamsCount }, timestamp: new Date().toISOString()
        });
      }

      if (path === "/health") {
        const matches = await db.getMatches();
        return jsonResponse({ status: "healthy", timestamp: new Date().toISOString(), matches: { total: matches.length, live: matches.filter(m => m.status === "live").length, upcoming: matches.filter(m => m.status === "notstarted").length } });
      }

      // ---- Chat ----
      if (path === "/api/chat/stream") {
        return jsonResponse({ type: "chatList", data: await db.getChatMessages(60) });
      }
      if (path === "/api/chat/send" && method === "POST") {
        const body = await getBody(request);
        if (!body.username || !body.text) return jsonResponse({ success: false, error: "Missing username or text" }, 400);
        return jsonResponse(await db.addChatMessage({ username: body.username, text: body.text, color: body.color, isAdmin: !!body.isAdmin }));
      }
      if (path === "/api/chat/delete" && method === "POST") {
        const body = await getBody(request);
        if (!body.id) return jsonResponse({ success: false, error: "Missing message id" }, 400);
        await db.deleteChatMessage(body.id);
        return jsonResponse({ success: true });
      }
      if (path === "/api/chat/clear" && method === "POST") {
        await db.clearChatMessages();
        return jsonResponse({ success: true });
      }

      // ---- Serve HTML pages directly from Worker ----
      if (path === "/" || path === "/fifa.html") {
        return new Response(fifaHtml, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "public, max-age=300" } });
      }
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

        // F1 streams auto-sync with F1-only filtering
        if (config.autoSyncStreams !== false) {
          await syncF1Streams(config, firestore || db, env.CONFIG_KV).catch(e => console.error("[cron] F1 streams:", e.message));
        }
      } catch (e) { console.error("[cron] F1 block:", e.message); }

      try {
        await syncFotMobData(db).catch(e => console.error("[cron] FotMob:", e.message));
        await syncMatchDetails(db).catch(e => console.error("[cron] details:", e.message));
        await syncFifaStreamsAndFeeds(db).catch(e => console.error("[cron] streams:", e.message));
        await syncGoogleScoresToDb(db, env.CONFIG_KV).catch(e => console.error("[cron] google-scores:", e.message));
        await env.CONFIG_KV.put("fifa_last_sync_time", new Date().toISOString()).catch(() => {});
        await env.CONFIG_KV.put("fifa_last_sync_status", "OK").catch(() => {});

        if (firestore) {
          const liveMatches = await db.getMatches("live");
          const upcomingMatches = (await db.getMatches("notstarted"))
            .filter(m => m.kickoff && m.kickoff > (Date.now() - 2.5 * 60 * 60 * 1000));
          const finishedMatches = await db.getMatches("finished");
          const activeMatch = liveMatches[0] || upcomingMatches[0] || finishedMatches[finishedMatches.length - 1];
          if (activeMatch) {
            const streamsList = await db.getStreams(activeMatch.id);
            await firestore.updateConfig({
              fifa: {
                raceData: {
                  name: `${activeMatch.homeTeam} vs ${activeMatch.awayTeam}`,
                  round: activeMatch.stage || "World Cup 2026",
                  circuit: activeMatch.venue || activeMatch.stadium || 'Venue to be confirmed',
                  location: activeMatch.city ? `${activeMatch.city}${activeMatch.country ? ', ' + activeMatch.country : ''}` : (activeMatch.venue || 'Venue to be confirmed'),
                  date: formatIst(activeMatch.kickoff),
                  homeScore: activeMatch.score?.split("-")[0]?.trim() || "0",
                  awayScore: activeMatch.score?.split("-")[1]?.trim() || "0",
                  isLive: activeMatch.status === "live",
                  isFinished: activeMatch.status === "finished",
                  matchTime: activeMatch.status === "live" ? (activeMatch.matchTime || "LIVE") : (activeMatch.status === "finished" ? "FT" : "0'")
                },
                customTimer: { enabled: activeMatch.status === "notstarted", target: new Date(activeMatch.kickoff).toISOString(), label: "KICKOFF COUNTDOWN" },
                streamLinks: streamsList.map((s, i) => ({
                  name: s.provider.toUpperCase(),
                  id: `stream_${activeMatch.id}_${i}`, url: s.embedUrl,
                  lang: s.language || "EN",
                  quality: s.quality || "720P"
                }))
              }
            });
          }
        }
      } catch (e) { console.error("[cron] FIFA block:", e.message); }

      console.log("[cron] Finished.");
    })());
  }
};
