/**
 * src/sync.js
 * Consolidated sync tasks for F1 and FIFA dashboards.
 * Ported to native Workers fetch API and cheerio HTML parsing.
 */

import * as cheerio from "cheerio";
import { parseResponse, fixEmbedUrl, scoreStream, API_URL as PUSH_EMB_API_URL } from "../api/providers/pushembdz";

const STADIUM_MAP = {
  "1":  { name: "Estadio Azteca", city: "Mexico City", country: "Mexico" },
  "2":  { name: "Estadio Akron", city: "Guadalajara", country: "Mexico" },
  "3":  { name: "Estadio BBVA", city: "Monterrey", country: "Mexico" },
  "4":  { name: "AT&T Stadium", city: "Dallas", country: "United States" },
  "5":  { name: "NRG Stadium", city: "Houston", country: "United States" },
  "6":  { name: "GEHA Field at Arrowhead Stadium", city: "Kansas City", country: "United States" },
  "7":  { name: "Mercedes-Benz Stadium", city: "Atlanta", country: "United States" },
  "8":  { name: "Hard Rock Stadium", city: "Miami", country: "United States" },
  "9":  { name: "Gillette Stadium", city: "Boston", country: "United States" },
  "10": { name: "Lincoln Financial Field", city: "Philadelphia", country: "United States" },
  "11": { name: "MetLife Stadium", city: "New York/New Jersey", country: "United States" },
  "12": { name: "BMO Field", city: "Toronto", country: "Canada" },
  "13": { name: "BC Place", city: "Vancouver", country: "Canada" },
  "14": { name: "Lumen Field", city: "Seattle", country: "United States" },
  "15": { name: "Levi's Stadium", city: "San Francisco Bay Area", country: "United States" },
  "16": { name: "SoFi Stadium", city: "Los Angeles", country: "United States" }
};

const STADIUM_OFFSETS = {
  "1": -6, "2": -6, "3": -6, "4": -5, "5": -5, "6": -5, "7": -4, "8": -4,
  "9": -4, "10": -4, "11": -4, "12": -4, "13": -7, "14": -7, "15": -7, "16": -7
};

const TEAM_ALIASES = {
  "Red Bull Racing": ["red bull", "redbull"],
  "Mercedes": ["mercedes"],
  "Ferrari": ["ferrari"],
  "McLaren": ["mclaren"],
  "Aston Martin": ["aston martin", "aston"],
  "Alpine": ["alpine"],
  "Williams": ["williams"],
  "VCARB": ["vcarb", "rb", "racing bulls", "alpha tauri", "alphatauri"],
  "Kick Sauber": ["kick sauber", "sauber", "alfa romeo", "stake"],
  "Haas F1 Team": ["haas"]
};

// Helper: fetch JSON with timeout
async function fetchJson(url, timeoutMs = 8000, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...(options.headers || {})
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// Helper: fetch text (HTML) with timeout
async function fetchText(url, timeoutMs = 8000, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...(options.headers || {})
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

// Format F1 driver name
function formatDriverNameFromHref(href) {
  if (!href) return "Driver";
  const parts = href.split("/");
  const lastPart = parts[parts.length - 1].replace(".html", "");
  return lastPart
    .split("-")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Format date to IST "13 Jun 23:30"
function formatFixtureIst(ms) {
  if (!ms || !isFinite(ms)) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(ms + 5.5 * 60 * 60 * 1000); // IST offset
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// Parse FIFA match date
function parseGameDate(localDate, stadiumId) {
  if (!localDate) return null;
  const [datePart, timePart] = localDate.split(" ");
  const [month, day, year] = datePart.split("/");
  const [hour, minute] = timePart.split(":");
  const offset = STADIUM_OFFSETS[String(stadiumId)] || -4;
  return Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), parseInt(hour, 10) - offset, parseInt(minute, 10));
}

// Get FIFA game status
function getFifaGameStatus(game) {
  const raw = String(game.time_elapsed || "").trim().toLowerCase();
  const isFinished = String(game.finished || "").toUpperCase() === "TRUE" || raw === "finished" || raw === "ft";
  const isLive = raw === "live" || raw === "ht" || (/^\d+$/.test(raw) && parseInt(raw, 10) >= 0);
  let status = "notstarted";
  if (isFinished) status = "finished";
  else if (isLive) status = "live";
  return { status, isLive, isFinished };
}

// Tokenize FIFA match title
function tokenizeMatchTitle(name) {
  if (!name) return [];
  const stopWords = new Set(["vs", "fc", "the", "a", "and", "or", "de", "la", "st"]);
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(t => t.length > 1 && !stopWords.has(t));
}

function enrichTokens(tokens) {
  const enriched = new Set(tokens);
  if (tokens.includes("united") && tokens.includes("states")) enriched.add("usa");
  if (tokens.includes("usa")) { enriched.add("united"); enriched.add("states"); }
  if (tokens.includes("korea")) { enriched.add("south"); enriched.add("rep"); enriched.add("republic"); }
  return Array.from(enriched);
}

function scoreStreamedMatch(match, tokens) {
  if (!match || !match.title) return 0;
  const title = match.title.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  return tokens.reduce((n, t) => n + (title.includes(t) ? 1 : 0), 0);
}

// Pick match from streamed.st
function pickStreamedFootballMatch(matches, matchName) {
  const footballMatches = matches.filter(m => m.category === "football");
  if (footballMatches.length === 0) return null;

  const tokens = enrichTokens(tokenizeMatchTitle(matchName));
  const ranked = footballMatches
    .map(m => ({ match: m, score: scoreStreamedMatch(m, tokens) }))
    .filter(x => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.match.sources || []).length - (a.match.sources || []).length;
    });

  if (ranked[0]) return ranked[0].match;
  return tokens.length === 0 ? footballMatches[0] : null;
}

// Fetch Google FIFA match time
async function fetchGoogleFifaMatchTime(matchName) {
  try {
    const query = matchName ? `fifa ${matchName}` : "fifa live";
    const html = await fetchText(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=IN`, 10000, {
      headers: {
        "Accept-Language": "en-IN,en;q=0.9"
      }
    });

    const $ = cheerio.load(html || "");
    const text = $("body").text().replace(/\s+/g, " ").trim();
    if (!text) return "";

    const teamTokens = tokenizeMatchTitle(matchName).filter(t => t.length > 2);
    const googleText = text.toLowerCase();
    const matchingTeams = teamTokens.filter(token => googleText.includes(token)).length;
    if (teamTokens.length > 0 && matchingTeams < Math.min(2, teamTokens.length)) return "";

    const patterns = [
      /\b(?:HT|FT|Full-time|Half-time)\b/i,
      /\b(?:\d{1,2}|90)(?:\+\d{1,2})?['’]/,
      /\b(?:\d{1,2}|90)(?:\+\d{1,2})?\s*min\b/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[0]) {
        const value = match[0].replace(/Full-time/i, "FT").replace(/Half-time/i, "HT").replace(/\s*min/i, "'");
        return value.replace("’", "'");
      }
    }
    return "";
  } catch (err) {
    console.error("[fetchGoogleFifaMatchTime] Google fetch failed:", err.message);
    return "";
  }
}

// Fetch Weather via wttr.in
async function fetchWeather(location) {
  const weather = { air: 0, track: 0, condition: "sunny" };
  try {
    const data = await fetchJson(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, 8000);
    if (data && data.current_condition && data.current_condition[0]) {
      const temp = parseInt(data.current_condition[0].temp_C || 0, 10);
      const desc = (data.current_condition[0].weatherDesc?.[0]?.value || "").toLowerCase();

      weather.air = temp;
      weather.track = temp + Math.floor(Math.random() * 8) + 4;

      if (desc.includes("rain") || desc.includes("drizzle") || desc.includes("shower")) weather.condition = "rain";
      else if (desc.includes("cloud") || desc.includes("overcast")) weather.condition = "cloudy";
      else if (desc.includes("storm") || desc.includes("thunder")) weather.condition = "storm";
      else weather.condition = "sunny";
    }
  } catch (e) {
    console.error("[fetchWeather] Error:", e.message);
  }
  return weather;
}

// Fetch streamed.st matches
async function fetchStreamedFootballMatches(matchName, preferLiveOnly = false) {
  const endpoints = preferLiveOnly
    ? ["https://streamed.st/api/matches/live"]
    : [
        "https://streamed.st/api/matches/live",
        "https://streamed.st/api/matches/all-today",
        "https://streamed.st/api/matches/all"
      ];

  for (const endpoint of endpoints) {
    try {
      const matches = await fetchJson(endpoint, 8000);
      if (!Array.isArray(matches)) continue;

      const selected = pickStreamedFootballMatch(matches, matchName);
      if (selected) {
        return { matches, selected, endpoint };
      }
    } catch (err) {
      console.error(`[fetchStreamedFootballMatches] Failed ${endpoint}:`, err.message);
    }
  }
  return { matches: [], selected: null, endpoint: null };
}

// Resolve streamed.st links
async function resolveStreamedLinks(match) {
  if (!match || !Array.isArray(match.sources) || match.sources.length === 0) return [];

  const streamLinks = [];
  const streamPromises = match.sources.map(async (src) => {
    try {
      if (!src || !src.source || !src.id) return;
      if (["golf", "tennis", "nba", "nhl", "nfl", "mlb", "ufc", "boxing", "cricket", "rugby", "f1", "motogp", "motorsport"].includes(src.source.toLowerCase())) {
        return;
      }

      const streams = await fetchJson(`https://streamed.st/api/stream/${src.source}/${src.id}`, 8000);
      if (Array.isArray(streams)) {
        streams.forEach((stream) => {
          if (stream.embedUrl) {
            const name = `${src.source.toUpperCase()} ${stream.language || "EN"} ${stream.hd ? "(HD)" : ""}`.trim();
            streamLinks.push({
              name,
              id: `src_fifa_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              url: stream.embedUrl
            });
          }
        });
      }
    } catch (err) {
      console.error(`[resolveStreamedLinks] Failed source ${src.source}:`, err.message);
    }
  });

  await Promise.all(streamPromises);
  return streamLinks;
}

// -------------------------------------------------------------
// MAIN EXPORTS
// -------------------------------------------------------------

export async function syncF1LiveAndWeather(config, firestoreClient) {
  console.log("[sync] F1 Live weather sync starting...");
  const data = await fetchJson("https://api.openf1.org/v1/sessions?session_key=latest", 8000);
  if (data && data.length > 0) {
    const s = data[0];
    const activeSession = {
      name: s.session_name,
      key: s.session_key,
      location: s.location,
      circuit: s.circuit_short_name || s.location,
      date: s.date_start,
      status: s.status
    };

    let weatherObj = { air: 0, track: 0, condition: "sunny" };
    if (activeSession.location) {
      weatherObj = await fetchWeather(activeSession.location);
    }

    let scheduleIsLive = false;
    if (Array.isArray(config.schedule)) {
      const nowMs = Date.now();
      config.schedule.forEach(sess => {
        if (sess.timer) {
          const start = new Date(sess.timer).getTime();
          if (!isNaN(start)) {
            let end = start + (2 * 60 * 60 * 1000);
            if (sess.endTime && sess.endTime.includes(":")) {
              const parts = sess.endTime.split(":");
              const d = new Date(sess.timer);
              d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0);
              end = d.getTime();
              if (end < start) end += 86400000;
            }
            if (nowMs >= start && nowMs < end) {
              scheduleIsLive = true;
            }
          }
        }
      });
    }

    const isLiveRaceActive = (s.status === "active") || scheduleIsLive;

    await firestoreClient.updateConfig({
      weather: weatherObj,
      isLiveRaceActive: isLiveRaceActive,
      lastF1LiveSync: new Date().toISOString()
    });
    console.log("[sync] F1 Live/Weather update complete.");
  }
}

export async function fetchStandings() {
  const year = new Date().getFullYear();
  try {
    const [driverHtml, teamHtml] = await Promise.all([
      fetchText(`https://www.formula1.com/en/results.html/${year}/drivers.html`, 10000),
      fetchText(`https://www.formula1.com/en/results.html/${year}/team.html`, 10000)
    ]);

    const $d = cheerio.load(driverHtml);
    const dl = [];
    $d("table tbody tr").each((i, row) => {
      const cells = $d(row).find("td");
      if (cells.length >= 5) {
        const driverLinkEl = $d(cells[1]).find("a");
        const href = driverLinkEl.attr("href") || "";
        const name = formatDriverNameFromHref(href);
        const image = driverLinkEl.find("img").attr("src") || "";
        const highResImage = image.replace("/c_lfill,w_64/", "/c_fill,w_80,h_80,g_north/");
        const team = $d(cells[3]).text().trim();
        const points = parseInt($d(cells[4]).text().trim() || 0, 10);

        dl.push({
          Driver: {
            familyName: name.split(" ").pop() || "",
            givenName: name.split(" ")[0] || "",
            fullName: name
          },
          Constructor: { name: team },
          points,
          image: highResImage || image
        });
      }
    });

    const $t = cheerio.load(teamHtml);
    const cl = [];
    $t("table tbody tr").each((i, row) => {
      const cells = $t(row).find("td");
      if (cells.length >= 3) {
        const teamName = $t(cells[1]).text().trim();
        const points = parseInt($t(cells[2]).text().trim() || 0, 10);
        cl.push({
          Constructor: { name: teamName },
          points
        });
      }
    });

    if (dl.length > 0) {
      return { dl, cl, source: "formula1.com" };
    }
  } catch (err) {
    console.warn("[sync] formula1.com scrape failed, trying Jolpica:", err.message);
  }

  // Fallback: Jolpica
  try {
    const [d, c] = await Promise.all([
      fetchJson(`https://api.jolpi.ca/ergast/f1/${year}/driverStandings.json`, 10000),
      fetchJson(`https://api.jolpi.ca/ergast/f1/${year}/constructorStandings.json`, 10000)
    ]);
    return {
      dl: d?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [],
      cl: c?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings || [],
      source: "jolpica"
    };
  } catch (e) {
    console.error("[sync] Jolpica fallback failed:", e.message);
  }

  return { dl: [], cl: [], source: "none" };
}

export async function syncStreamsAutomatically(config, firestoreClient) {
  if (!config.autoSyncStreams) return;

  let searchTokens = [];
  if (config.streamKeyword) {
    searchTokens = config.streamKeyword.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length > 0);
  } else {
    let rawLocation = config.raceData?.location || "";
    if (!rawLocation && config.raceData?.name) {
      rawLocation = config.raceData.name;
    }

    let location = "";
    if (rawLocation) {
      const parts = rawLocation.split(",");
      const lastPart = parts[parts.length - 1].trim();
      location = lastPart.replace(/[0-9]/g, "").trim();
    }

    if (!location) return;

    let sessionAbbr = "FP1";
    if (config.schedule && config.schedule.length > 0) {
      const now = Date.now();
      let closestFutureTime = Infinity;
      let activeSess = null;

      config.schedule.forEach(s => {
        if (!s.timer) return;
        const start = new Date(s.timer).getTime();
        if (isNaN(start)) return;

        let end = start + (2 * 60 * 60 * 1000);
        if (s.endTime && s.endTime.includes(":")) {
          const parts = s.endTime.split(":");
          const d = new Date(s.timer);
          d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0);
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
        const nameLower = activeSess.name.toLowerCase();
        if (nameLower.includes("practice 1") || nameLower.includes("fp1")) sessionAbbr = "FP1";
        else if (nameLower.includes("practice 2") || nameLower.includes("fp2")) sessionAbbr = "FP2";
        else if (nameLower.includes("practice 3") || nameLower.includes("fp3")) sessionAbbr = "FP3";
        else if (nameLower.includes("qualifying") || nameLower.includes("qualy") || nameLower.includes("qual")) sessionAbbr = "Qualifying";
        else if (nameLower.includes("sprint")) sessionAbbr = "Sprint";
        else if (nameLower.includes("race") || nameLower.includes("grand prix")) sessionAbbr = "Race";
      }
    }

    searchTokens = ["f1", location.toLowerCase(), sessionAbbr.toLowerCase()];
  }

  if (searchTokens.length === 0) return;

  const targetUrl = config.streamProxyUrl || PUSH_EMB_API_URL;
  let rawData = null;
  let fetchError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      rawData = await fetchJson(targetUrl, 10000);
      break;
    } catch (err) {
      fetchError = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (!rawData) {
    throw new Error(`Failed to fetch stream list: ${fetchError?.message}`);
  }

  const { streams: allStreams } = parseResponse(rawData);
  let matched = allStreams.filter(s => scoreStream(s, searchTokens) === 100);

  if (matched.length === 0) {
    const coreTokens = searchTokens.filter(t =>
      !["fp1", "fp2", "fp3", "practice", "qualifying", "qualy", "qual", "sprint", "race"].includes(t)
    );
    if (coreTokens.length > 0) {
      matched = allStreams.filter(s => scoreStream(s, coreTokens) === 100);
    }
  }

  if (matched.length > 0) {
    const newLinks = matched.map((s, index) => ({
      name: s.label,
      id: `src_${Date.now()}_${index}`,
      url: s.embedUrl
    }));

    await firestoreClient.updateConfig({ streamLinks: newLinks });
    console.log(`[sync] F1 streams auto-sync updated: ${newLinks.length} links`);
  }
}

export async function syncFifaLiveFromStreamed(config, firestoreClient, options = {}) {
  const fifa = config.fifa || {};
  const currentRaceData = fifa.raceData || {};

  try {
    const { selected: selectedMatch } = await fetchStreamedFootballMatches(currentRaceData.name, true);
    if (!selectedMatch) return null;

    const streamLinks = await resolveStreamedLinks(selectedMatch);
    const teams = selectedMatch.teams || {};
    const homeName = teams.home?.name || String(selectedMatch.title || "").split(/\s+vs\s+/i)[0] || "TBD";
    const awayName = teams.away?.name || String(selectedMatch.title || "").split(/\s+vs\s+/i)[1] || "TBD";
    const matchName = selectedMatch.title || `${homeName} vs ${awayName}`;
    const kickoffDate = selectedMatch.date ? new Date(selectedMatch.date) : null;
    const googleMatchTime = await fetchGoogleFifaMatchTime(matchName);

    const updatedFifa = {
      ...fifa,
      raceData: {
        ...currentRaceData,
        name: matchName,
        round: currentRaceData.round || "Live Football",
        circuit: currentRaceData.circuit || "streamed.st",
        location: currentRaceData.location || "Live",
        date: kickoffDate && !isNaN(kickoffDate.getTime()) ? formatFixtureIst(kickoffDate.getTime()) : (currentRaceData.date || ""),
        isLive: true,
        isFinished: false,
        matchTime: googleMatchTime || currentRaceData.matchTime || "LIVE"
      },
      customTimer: (fifa.customTimer && fifa.customTimer.isManual)
        ? fifa.customTimer
        : {
            ...(fifa.customTimer || {}),
            enabled: true,
            target: kickoffDate && !isNaN(kickoffDate.getTime()) ? kickoffDate.toISOString() : new Date().toISOString(),
            label: "LIVE NOW"
          },
      streamLinks
    };

    await firestoreClient.updateConfig({ fifa: updatedFifa });
    return updatedFifa;
  } catch (err) {
    console.error("[sync-fifa-live] Error:", err.message);
    if (options.throwOnError) throw err;
    return null;
  }
}

export async function syncFifaMatchDetails(config, firestoreClient, fallbackGamesList) {
  const fifa = config.fifa || {};
  let games = null;
  try {
    const responseData = await fetchJson("https://worldcup26.ir/get/games", 12000);
    games = responseData && responseData.games;
  } catch (err) {
    console.warn("[sync-fifa-details] worldcup26.ir fetch failed, using fallback list:", err.message);
    games = fallbackGamesList?.games || [];
  }

  if (!Array.isArray(games) || games.length === 0) return null;

  try {
    const now = Date.now();
    const THREE_QUARTER_HOURS_MS = 3.25 * 60 * 60 * 1000;
    let chosen = null;
    const liveGame = games.find(g => getFifaGameStatus(g).isLive);
    if (liveGame) {
      const liveKickoffMs = parseGameDate(liveGame.local_date, liveGame.stadium_id);
      if (liveKickoffMs && (now - liveKickoffMs) < THREE_QUARTER_HOURS_MS) {
        chosen = liveGame;
      }
    }

    if (!chosen) {
      const upcoming = games
        .filter(g => getFifaGameStatus(g).status === "notstarted")
        .map(g => ({ ...g, _kickoffMs: parseGameDate(g.local_date, g.stadium_id) }))
        .filter(g => g._kickoffMs && g._kickoffMs > (now - 2.5 * 60 * 60 * 1000))
        .sort((a, b) => a._kickoffMs - b._kickoffMs);
      chosen = upcoming[0] || null;
    }

    if (!chosen) return null;

    const isKnockout = !chosen.home_team_name_en;
    const matchName = isKnockout
      ? `${chosen.home_team_label || "TBD"} vs ${chosen.away_team_label || "TBD"}`
      : `${chosen.home_team_name_en} vs ${chosen.away_team_name_en}`;

    const roundMap = { group: `Group ${chosen.group}`, r32: "Round of 32", r16: "Round of 16", qf: "Quarter-Final", sf: "Semi-Final", third: "3rd Place Play-off", final: "Final" };
    const round = roundMap[chosen.type] || chosen.group || "World Cup 2026";
    const stadium = STADIUM_MAP[chosen.stadium_id] || { name: "Stadium", city: "", country: "" };
    const location = `${stadium.city}, ${stadium.country}`;

    const kickoffMs = (fifa.customTimer && fifa.customTimer.isManual && fifa.customTimer.target)
      ? new Date(fifa.customTimer.target).getTime()
      : parseGameDate(chosen.local_date, chosen.stadium_id);
    const isoTarget = new Date(kickoffMs).toISOString();
    const friendlyDate = formatFixtureIst(kickoffMs);

    const chosenStatus = getFifaGameStatus(chosen);
    const isLive = chosenStatus.isLive;
    const isFinished = chosenStatus.isFinished;
    const homeScore = chosen.home_score || "0";
    const awayScore = chosen.away_score || "0";

    let matchTime = "";
    if (isLive && kickoffMs) {
      const rawElapsed = String(chosen.time_elapsed || "").trim();
      const elapsedMins = /^\d+$/.test(rawElapsed)
        ? parseInt(rawElapsed, 10)
        : Math.floor((Date.now() - kickoffMs) / 60000);
      if (rawElapsed.toLowerCase() === "ht") matchTime = "HT";
      else if (elapsedMins < 0) matchTime = "0'";
      else if (elapsedMins < 45) matchTime = `${elapsedMins}'`;
      else if (elapsedMins < 60) matchTime = "HT";
      else if (elapsedMins < 105) matchTime = `${elapsedMins - 15}'`;
      else matchTime = "90+'";
    } else if (isFinished) {
      matchTime = "FT";
    }

    if (isLive) {
      const googleMatchTime = await fetchGoogleFifaMatchTime(matchName);
      if (googleMatchTime) matchTime = googleMatchTime;
    }

    const currentFifa = config.fifa || {};
    const currentRaceData = currentFifa.raceData || {};
    const updatedFifa = {
      ...currentFifa,
      raceData: {
        ...currentRaceData,
        name: matchName,
        round,
        circuit: stadium.name,
        location,
        date: friendlyDate,
        homeScore,
        awayScore,
        isLive,
        isFinished,
        matchTime
      },
      customTimer: (currentFifa.customTimer && currentFifa.customTimer.isManual)
        ? currentFifa.customTimer
        : {
            ...(currentFifa.customTimer || {}),
            enabled: true,
            target: isoTarget,
            label: isLive ? "LIVE NOW" : "MATCH KICKS OFF"
          }
    };

    await firestoreClient.updateConfig({ fifa: updatedFifa });
    return updatedFifa;
  } catch (err) {
    console.error("[syncFifaMatchDetails] Error:", err.message);
    return null;
  }
}

export async function syncFifaStreams(config, firestoreClient, options = {}) {
  const fifa = config.fifa || {};
  const isManual = !!options.manual;

  if (fifa.autoSyncStreams === false && !isManual) return;

  const matchName = fifa.raceData?.name;
  if (!matchName) return;

  const customTimerTarget = fifa.customTimer?.target;
  if (customTimerTarget) {
    const kickoffMs = new Date(customTimerTarget).getTime();
    const nowMs = Date.now();
    const isLive = fifa.raceData?.isLive;
    if (!isManual && !isLive && (kickoffMs - nowMs) > 10 * 60 * 1000) {
      // Clear links if match is >10 min away and not live
      const updatedFifa = { ...fifa, streamLinks: [] };
      await firestoreClient.updateConfig({ fifa: updatedFifa });
      return;
    }
  }

  const tokens = enrichTokens(tokenizeMatchTitle(matchName));
  if (tokens.length === 0) return;

  let matches = await fetchJson("https://streamed.st/api/matches/live", 8000).catch(() => null);
  if (!Array.isArray(matches)) {
    matches = await fetchJson("https://streamed.st/api/matches/all", 8000).catch(() => null);
  }
  if (!Array.isArray(matches)) return;

  const footballMatches = matches.filter(m => m.category === "football");
  let candidates = [];
  footballMatches.forEach(m => {
    if (!m.title) return;
    const titleLower = m.title.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    let matchCount = 0;
    tokens.forEach(t => {
      if (titleLower.includes(t)) matchCount++;
    });
    if (matchCount > 0) {
      candidates.push({ match: m, count: matchCount });
    }
  });

  if (candidates.length === 0) {
    const fallbackEndpoints = [
      "https://streamed.st/api/matches/all-today",
      "https://streamed.st/api/matches/all"
    ];

    for (const endpoint of fallbackEndpoints) {
      try {
        const fbMatches = await fetchJson(endpoint, 8000);
        if (!Array.isArray(fbMatches)) continue;

        candidates = fbMatches
          .filter(m => m.category === "football" && m.title)
          .map(match => ({ match, count: scoreStreamedMatch(match, tokens) }))
          .filter(item => item.count > 0);

        if (candidates.length > 0) break;
      } catch (err) {
        console.error(`[syncFifaStreams] Fallback endpoint failed: ${endpoint}`, err.message);
      }
    }
  }

  if (candidates.length === 0) return;

  candidates.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (b.match.sources || []).length - (a.match.sources || []).length;
  });

  let selectedMatch = null;
  let resolvedStreamLinks = [];

  for (const cand of candidates) {
    const bestMatch = cand.match;
    if (bestMatch.sources && bestMatch.sources.length > 0) {
      const streamLinks = [];
      const streamPromises = bestMatch.sources.map(async (src) => {
        try {
          if (["golf", "tennis", "nba", "nhl", "nfl", "mlb", "ufc", "boxing", "cricket", "rugby", "f1", "motogp", "motorsport"].includes(src.source.toLowerCase())) {
            return;
          }
          const streams = await fetchJson(`https://streamed.st/api/stream/${src.source}/${src.id}`, 8000);
          if (Array.isArray(streams)) {
            streams.forEach((stream) => {
              if (stream.embedUrl) {
                const name = `${src.source.toUpperCase()} ${stream.language || "EN"} ${stream.hd ? "(HD)" : ""}`.trim();
                streamLinks.push({
                  name,
                  id: `src_fifa_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                  url: stream.embedUrl
                });
              }
            });
          }
        } catch (err) {
          console.error(`[syncFifaStreams] Failed source ${src.source}:`, err.message);
        }
      });

      await Promise.all(streamPromises);

      if (streamLinks.length > 0) {
        selectedMatch = bestMatch;
        resolvedStreamLinks = streamLinks;
        break;
      }
    }
  }

  if (!selectedMatch || resolvedStreamLinks.length === 0) {
    const fallbackEndpoints = ["https://streamed.st/api/matches/all-today", "https://streamed.st/api/matches/all"];
    for (const endpoint of fallbackEndpoints) {
      try {
        const fbMatches = await fetchJson(endpoint, 8000);
        if (!Array.isArray(fbMatches)) continue;

        const fbCandidates = fbMatches
          .filter(m => m.category === "football" && m.title)
          .map(match => ({ match, count: scoreStreamedMatch(match, tokens) }))
          .filter(item => item.count > 0)
          .sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return (b.match.sources || []).length - (a.match.sources || []).length;
          });

        for (const candidate of fbCandidates) {
          const links = await resolveStreamedLinks(candidate.match);
          if (links.length > 0) {
            selectedMatch = candidate.match;
            resolvedStreamLinks = links;
            break;
          }
        }
        if (selectedMatch) break;
      } catch (err) {
        console.error(`[syncFifaStreams] Failed fallback ${endpoint}:`, err.message);
      }
    }
  }

  if (selectedMatch && resolvedStreamLinks.length > 0) {
    const updatedFifa = {
      ...fifa,
      streamLinks: resolvedStreamLinks
    };
    await firestoreClient.updateConfig({ fifa: updatedFifa });
  }
}
