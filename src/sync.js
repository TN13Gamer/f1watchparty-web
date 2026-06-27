/**
 * src/sync.js
 * Consolidated sync tasks for F1 and FIFA dashboards.
 * Automated FotMob and streamed.pk scraping.
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

// -------------------------------------------------------------
// F1 SYNC OPERATIONS (PRESERVED)
// -------------------------------------------------------------
export async function syncF1LiveAndWeather(config, database) {
  const weatherKey = "4fbba5f87b8d4bb9b52125102241706";
  const race = config.raceData || {};
  if (!race.location) return;

  try {
    const wData = await fetchJson(`https://api.weatherapi.com/v1/current.json?key=${weatherKey}&q=${encodeURIComponent(race.location)}`, 6000);
    if (wData && wData.current) {
      const weather = {
        temp: `${Math.round(wData.current.temp_c)}°C`,
        condition: wData.current.condition?.text || "",
        wind: `${Math.round(wData.current.wind_kph)} kph`,
        humidity: `${wData.current.humidity}%`,
        icon: wData.current.condition?.icon ? `https:${wData.current.condition.icon}` : ""
      };
      await database.updateConfig({ weather });
      console.log(`[sync] F1 weather updated for: ${race.location}`);
    }
  } catch (err) {
    console.error("[syncF1LiveAndWeather] Weather failed:", err.message);
  }
}

export async function fetchStandings() {
  try {
    const dl = await fetchJson("https://ergast.com/api/f1/current/driverStandings.json", 6000)
      .then(res => res.MRData.StandingsTable.StandingsLists[0].DriverStandings)
      .catch(() => null);

    const cl = await fetchJson("https://ergast.com/api/f1/current/constructorStandings.json", 6000)
      .then(res => res.MRData.StandingsTable.StandingsLists[0].ConstructorStandings)
      .catch(() => null);

    return { dl, cl, source: "ergast.com" };
  } catch (err) {
    // Fallback scraper
    const html = await fetchText("https://www.formula1.com/en/results.html/2026/drivers.html", 8000);
    const $ = cheerio.load(html);
    const dl = [];
    $("table.resultsarchive-table tbody tr").each((i, el) => {
      const pos = $(el).find("td:nth-child(2)").text().trim();
      const driverHref = $(el).find("td:nth-child(3) a").attr("href");
      const fullName = formatDriverNameFromHref(driverHref);
      const team = $(el).find("td:nth-child(5)").text().trim();
      const points = $(el).find("td:nth-child(6)").text().trim();
      if (fullName) {
        dl.push({
          position: pos,
          points,
          Driver: { fullName, familyName: fullName.split(" ").pop() },
          Constructor: { name: team }
        });
      }
    });
    return { dl, cl: [], source: "formula1.com" };
  }
}

export async function syncStreamsAutomatically(config, database) {
  if (config.autoSyncStreams === false) return;
  const res = await fetch(PUSH_EMB_API_URL);
  if (!res.ok) return;
  const data = await res.json();
  const { streams } = parseResponse(data);

  if (streams.length > 0) {
    const newLinks = streams.map((s, index) => ({
      name: s.label || s.title || `Stream ${index + 1}`,
      id: `src_${Date.now()}_${index}`,
      url: s.embedUrl
    }));

    await database.updateConfig({ streamLinks: newLinks });
    console.log(`[sync] F1 streams auto-sync updated: ${newLinks.length} links`);
  }
}

// -------------------------------------------------------------
// F1-SPECIFIC STREAM FETCHER
// -------------------------------------------------------------
const F1_KEYWORDS = ["f1", "f one", "fone", "formula 1", "formula1", "grand prix", "grandprix", " gp "];
const SESSION_KEYWORDS = ["practice 1", "practice 2", "practice 3", "fp1", "fp2", "fp3", "qualifying", "qualy", "sprint", "sprint shootout", "sprint qualifying", "race"];
const EXCLUDE_CATEGORIES = ["football", "cricket", "ufc", "mma", "boxing", "nba", "basketball", "moto gp", "moto", "nfl", "nhl", "tennis", "golf"];

function isF1Stream(stream) {
  if (!stream || !stream.title) return false;
  const titleLower = stream.title.toLowerCase();
  const categoryLower = (stream.category || "").toLowerCase();

  for (const excl of EXCLUDE_CATEGORIES) {
    if (categoryLower.includes(excl)) return false;
    if (titleLower.includes(excl)) return false;
  }

  // Check for F1 keywords
  for (const kw of F1_KEYWORDS) {
    if (titleLower.includes(kw)) return true;
  }

  // Check for "FOne" prefix (pushembdz uses "FOne" for F1 streams)
  if (titleLower.startsWith("fone") || titleLower.startsWith("f one")) return true;

  // If title contains any session keyword AND doesn't match other sports, assume F1
  // This catches variants like "FOne - Austria - FP3 - EN2"
  if (titleLower.includes("fp1") || titleLower.includes("fp2") || titleLower.includes("fp3")) {
    const nonF1Sports = ["moto", "nascar", "ncs", "rally", "wrc", "nba", "nfl", "ufc", "cricket", "football"];
    for (const s of nonF1Sports) {
      if (titleLower.includes(s)) return false;
    }
    return true;
  }

  return false;
}

function isSessionTitle(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  for (const sk of SESSION_KEYWORDS) {
    if (lower.includes(sk)) return true;
  }
  return false;
}

function groupStreamsBySession(streams) {
  const groups = {};
  for (const s of streams) {
    if (!s.title) continue;
    let baseKey = s.title;
    const parts = s.title.split(" - ").map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const lastPart = parts[parts.length - 1];
      if (lastPart.length <= 10) {
        baseKey = parts.slice(0, -1).join(" - ");
      }
      const last2 = parts[parts.length - 2];
      if (last2 && last2.length <= 10 && parts.length >= 3) {
        baseKey = parts.slice(0, -2).join(" - ");
      }
    }
    if (baseKey.length < 3) baseKey = s.title;
    if (!groups[baseKey]) groups[baseKey] = [];
    groups[baseKey].push(s);
  }
  return groups;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function syncF1Streams(config, database, envKV) {
  const log = [];
  const result = { detected: 0, accepted: 0, rejected: 0, groups: 0, error: null };

  const fetchWithRetry = async (url, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          }
        });
        clearTimeout(timeoutId);
        if (res.ok) return res;
        if (attempt < retries) await sleep(2000 * attempt);
      } catch (e) {
        if (attempt < retries) await sleep(2000 * attempt);
        else throw e;
      }
    }
    throw new Error(`Failed after ${retries} retries`);
  };

  try {
    log.push("[F1 Streams] Starting fetch from pushembdz...");
    const res = await fetchWithRetry(PUSH_EMB_API_URL);
    const data = await res.json();
    const { streams, warnings } = parseResponse(data);
    log.push(`[F1 Streams] API returned ${streams.length} total streams`);

    if (warnings.length) {
      log.push(`[F1 Streams] Warnings: ${warnings.join("; ")}`);
    }

    if (streams.length === 0) {
      log.push("[F1 Streams] No streams returned from API");
      await saveSyncResult(envKV, result, log);
      return { ...result, streams: [], logs: log };
    }

    const f1Streams = streams.filter(s => {
      const isF1 = isF1Stream(s);
      log.push(`[F1 Streams] ${isF1 ? "ACCEPT" : "REJECT"} "${s.title}" (category: ${s.category})`);
      return isF1;
    });

    result.detected = streams.length;
    result.accepted = f1Streams.length;
    result.rejected = streams.length - f1Streams.length;
    log.push(`[F1 Streams] Accepted ${f1Streams.length}, Rejected ${streams.length - f1Streams.length}`);

    if (f1Streams.length === 0) {
      log.push("[F1 Streams] No F1 streams found");
      await saveSyncResult(envKV, result, log);
      return { ...result, streams: [], logs: log };
    }

    const grouped = groupStreamsBySession(f1Streams);
    result.groups = Object.keys(grouped).length;
    log.push(`[F1 Streams] Grouped into ${result.groups} session groups`);

    for (const [baseTitle, groupStreams] of Object.entries(grouped)) {
      log.push(`[F1 Streams] Group "${baseTitle}": ${groupStreams.length} mirrors`);
    }

    const newLinks = [];
    let idx = 0;
    const seenUrls = new Set();

    for (const [baseTitle, groupStreams] of Object.entries(grouped)) {
      const primaryStream = groupStreams[0];
      const groupName = primaryStream.label || primaryStream.title || baseTitle;
      newLinks.push({
        name: groupName,
        id: `f1_stream_${Date.now()}_${idx}`,
        url: primaryStream.embedUrl
      });
      seenUrls.add(primaryStream.embedUrl);
      idx++;

      for (let mi = 1; mi < groupStreams.length; mi++) {
        const mirror = groupStreams[mi];
        if (seenUrls.has(mirror.embedUrl)) continue;
        seenUrls.add(mirror.embedUrl);
        newLinks.push({
          name: `${groupName} - Mirror ${mi}`,
          id: `f1_stream_${Date.now()}_${idx}`,
          url: mirror.embedUrl
        });
        idx++;
      }
    }

    log.push(`[F1 Streams] Built ${newLinks.length} stream links`);

    if (!config.autoSyncStreams) {
      log.push("[F1 Streams] autoSyncStreams is disabled, skipping Firestore save");
      await saveSyncResult(envKV, result, log);
      return { ...result, streams: newLinks, logs: log };
    }

    if (database && typeof database.updateConfig === "function") {
      await database.updateConfig({ streamLinks: newLinks, lastF1StreamsSync: new Date().toISOString() });
      log.push("[F1 Streams] Saved to Firestore/D1");
    }

    if (envKV) {
      await envKV.put("f1_streams_count", String(newLinks.length));
      await envKV.put("f1_streams_last_accepted", String(result.accepted));
      await envKV.put("f1_streams_last_rejected", String(result.rejected));
    }

    await saveSyncResult(envKV, { ...result, success: true }, log);
    return { ...result, streams: newLinks, logs: log };
  } catch (err) {
    result.error = err.message;
    log.push(`[F1 Streams] ERROR: ${err.message}`);
    console.error("[syncF1Streams]", err.message);
    await saveSyncResult(envKV, result, log);
    return { ...result, streams: [], logs: log };
  }
}

async function saveSyncResult(envKV, result, logs) {
  if (!envKV) return;
  try {
    await envKV.put("f1_streams_last_result", JSON.stringify({ ...result, timestamp: new Date().toISOString() }));
    await envKV.put("f1_streams_last_logs", JSON.stringify(logs.slice(-100)));
  } catch (e) {}
}

// -------------------------------------------------------------
// F1 SCHEDULE GENERATOR
// -------------------------------------------------------------
const F1_CALENDAR_2026 = [
  { round: 1, name: "Bahrain Grand Prix", circuit: "Bahrain International Circuit", location: "Sakhir, Bahrain", date: "2026-03-01T15:00:00", timezone: "Asia/Bahrain" },
  { round: 2, name: "Saudi Arabian Grand Prix", circuit: "Jeddah Corniche Circuit", location: "Jeddah, Saudi Arabia", date: "2026-03-08T17:00:00", timezone: "Asia/Riyadh" },
  { round: 3, name: "Australian Grand Prix", circuit: "Albert Park Circuit", location: "Melbourne, Australia", date: "2026-03-22T04:00:00", timezone: "Australia/Melbourne" },
  { round: 4, name: "Japanese Grand Prix", circuit: "Suzuka International Racing Course", location: "Suzuka, Japan", date: "2026-04-05T05:00:00", timezone: "Asia/Tokyo" },
  { round: 5, name: "Chinese Grand Prix", circuit: "Shanghai International Circuit", location: "Shanghai, China", date: "2026-04-19T07:00:00", timezone: "Asia/Shanghai" },
  { round: 6, name: "Miami Grand Prix", circuit: "Miami International Autodrome", location: "Miami, USA", date: "2026-05-03T20:00:00", timezone: "America/New_York" },
  { round: 7, name: "Emilia Romagna Grand Prix", circuit: "Autodromo Enzo e Dino Ferrari", location: "Imola, Italy", date: "2026-05-17T13:00:00", timezone: "Europe/Rome" },
  { round: 8, name: "Monaco Grand Prix", circuit: "Circuit de Monaco", location: "Monte Carlo, Monaco", date: "2026-05-24T13:00:00", timezone: "Europe/Monaco" },
  { round: 9, name: "Canadian Grand Prix", circuit: "Circuit Gilles-Villeneuve", location: "Montreal, Canada", date: "2026-06-07T18:00:00", timezone: "America/Toronto" },
  { round: 10, name: "Spanish Grand Prix", circuit: "Circuit de Barcelona-Catalunya", location: "Barcelona, Spain", date: "2026-06-21T13:00:00", timezone: "Europe/Madrid" },
  { round: 11, name: "Austrian Grand Prix", circuit: "Red Bull Ring", location: "Spielberg, Austria", date: "2026-06-28T13:00:00", timezone: "Europe/Vienna" },
  { round: 12, name: "British Grand Prix", circuit: "Silverstone Circuit", location: "Silverstone, UK", date: "2026-07-05T14:00:00", timezone: "Europe/London" },
  { round: 13, name: "Hungarian Grand Prix", circuit: "Hungaroring", location: "Budapest, Hungary", date: "2026-07-19T13:00:00", timezone: "Europe/Budapest" },
  { round: 14, name: "Belgian Grand Prix", circuit: "Circuit de Spa-Francorchamps", location: "Spa, Belgium", date: "2026-07-26T13:00:00", timezone: "Europe/Brussels" },
  { round: 15, name: "Dutch Grand Prix", circuit: "Circuit Zandvoort", location: "Zandvoort, Netherlands", date: "2026-08-23T13:00:00", timezone: "Europe/Amsterdam" },
  { round: 16, name: "Italian Grand Prix", circuit: "Autodromo Nazionale Monza", location: "Monza, Italy", date: "2026-08-30T13:00:00", timezone: "Europe/Rome" },
  { round: 17, name: "Azerbaijan Grand Prix", circuit: "Baku City Circuit", location: "Baku, Azerbaijan", date: "2026-09-13T11:00:00", timezone: "Asia/Baku" },
  { round: 18, name: "Singapore Grand Prix", circuit: "Marina Bay Street Circuit", location: "Singapore", date: "2026-09-20T12:00:00", timezone: "Asia/Singapore" },
  { round: 19, name: "United States Grand Prix", circuit: "Circuit of The Americas", location: "Austin, USA", date: "2026-10-18T19:00:00", timezone: "America/Chicago" },
  { round: 20, name: "Mexico City Grand Prix", circuit: "Autódromo Hermanos Rodríguez", location: "Mexico City, Mexico", date: "2026-10-25T20:00:00", timezone: "America/Mexico_City" },
  { round: 21, name: "São Paulo Grand Prix", circuit: "Autódromo José Carlos Pace", location: "São Paulo, Brazil", date: "2026-11-08T17:00:00", timezone: "America/Sao_Paulo" },
  { round: 22, name: "Las Vegas Grand Prix", circuit: "Las Vegas Strip Circuit", location: "Las Vegas, USA", date: "2026-11-21T06:00:00", timezone: "America/Los_Angeles" },
  { round: 23, name: "Qatar Grand Prix", circuit: "Lusail International Circuit", location: "Lusail, Qatar", date: "2026-11-29T17:00:00", timezone: "Asia/Qatar" },
  { round: 24, name: "Abu Dhabi Grand Prix", circuit: "Yas Marina Circuit", location: "Abu Dhabi, UAE", date: "2026-12-06T13:00:00", timezone: "Asia/Dubai" }
];

// Sprint weekends in 2026
const SPRINT_WEEKENDS = [3, 6, 17, 21];
function isSprintWeekend(round) { return SPRINT_WEEKENDS.includes(round); }

function getCurrentOrNextRace() {
  const now = new Date();
  for (const gp of F1_CALENDAR_2026) {
    const raceDate = new Date(gp.date);
    const weekendEnd = new Date(raceDate.getTime() + 3 * 24 * 60 * 60 * 1000);
    if (now <= weekendEnd) return gp;
  }
  return F1_CALENDAR_2026[F1_CALENDAR_2026.length - 1];
}

function buildFullSchedule(gp) {
  const day = new Date(gp.date);
  const dayMs = 24 * 60 * 60 * 1000;
  const sprint = isSprintWeekend(gp.round);

  function formatTime(d) {
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function formatDate(d) {
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    return d.getDate() + " " + months[d.getMonth()];
  }

  function formatDayName(d) {
    return ["SUN","MON","TUE","WED","THU","FRI","SAT","SUN"][d.getDay()];
  }

  function makeSession(name, offsetDays, hour, minute, durationHours = 2) {
    const start = new Date(day.getTime() + offsetDays * dayMs);
    start.setHours(hour, minute, 0, 0);
    const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
    return {
      name,
      day: formatDayName(start),
      date: formatDate(start),
      time: formatTime(start),
      endTime: formatTime(end),
      timer: start.toISOString().replace(/\.\d{3}Z$/, ""),
      startTime: start.toISOString()
    };
  }

  const schedule = [];

  if (sprint) {
    // Sprint weekend
    schedule.push(makeSession("Practice 1",    -2, 10, 30, 1));
    schedule.push(makeSession("Sprint Qualifying", -2, 14, 0, 1));
    schedule.push(makeSession("Practice 2",    -1, 10, 30, 1));
    schedule.push(makeSession("Sprint",        -1, 14, 0, 1));
    schedule.push(makeSession("Practice 3",    0, 10, 0, 1));
    schedule.push(makeSession("Qualifying",    0, 13, 0, 1));
    schedule.push(makeSession("Race",          1, 14, 0, 2));
  } else {
    // Normal weekend
    const raceHour = day.getHours();
    const raceMinute = day.getMinutes();

    schedule.push(makeSession("Practice 1",    -2, 10, 30, 1));
    schedule.push(makeSession("Practice 2",    -2, 14, 0, 1));
    schedule.push(makeSession("Practice 3",    -1, 10, 0, 1));
    schedule.push(makeSession("Qualifying",    -1, 13, 0, 1));
    schedule.push(makeSession("Race",          0, raceHour, raceMinute, 2));
  }

  return schedule;
}

export async function syncF1Schedule(envKV, database) {
  const logs = [];
  try {
    logs.push("[F1 Schedule] Starting schedule sync...");
    const gp = getCurrentOrNextRace();
    logs.push(`[F1 Schedule] Current race: ${gp.name} (Round ${gp.round})`);
    logs.push(`[F1 Schedule] Sprint weekend: ${isSprintWeekend(gp.round)}`);

    const schedule = buildFullSchedule(gp);
    logs.push(`[F1 Schedule] Generated ${schedule.length} sessions`);

    schedule.forEach(s => {
      logs.push(`[F1 Schedule]   ${s.name}: ${s.date} ${s.time} (${s.day})`);
    });

    const raceData = {
      round: gp.round,
      name: gp.name,
      circuit: gp.circuit,
      location: gp.location,
      date: formatDateFromISO(gp.date),
      schedule
    };

    if (database && typeof database.updateConfig === "function") {
      await database.updateConfig({ schedule, raceData, lastScheduleSync: new Date().toISOString() });
      logs.push("[F1 Schedule] Saved to Firestore/D1");
    }

    if (envKV) {
      await envKV.put("f1_schedule_count", String(schedule.length));
      await envKV.put("f1_schedule_race", gp.name);
      await envKV.put("f1_schedule_sprint", isSprintWeekend(gp.round) ? "yes" : "no");
      await envKV.put("f1_schedule_last_sync", new Date().toISOString());
    }

    logs.push("[F1 Schedule] Sync complete");
    return { success: true, race: gp.name, sessions: schedule.length, sprint: isSprintWeekend(gp.round), logs };
  } catch (err) {
    logs.push(`[F1 Schedule] ERROR: ${err.message}`);
    console.error("[syncF1Schedule]", err.message);
    return { success: false, error: err.message, logs };
  }
}

function formatDateFromISO(isoStr) {
  const d = new Date(isoStr);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

// -------------------------------------------------------------
// FUZZY MATCH LOGIC
// -------------------------------------------------------------
const NAME_MAP = {
  "usa": ["united states", "united states of america", "us"],
  "united states": ["usa", "united states of america", "us"],
  "korea republic": ["south korea", "korea", "korea rep"],
  "south korea": ["korea republic", "korea", "korea rep"],
  "czechia": ["czech republic", "czech"],
  "england": ["uk", "great britain"],
  "uae": ["united arab emirates"]
};

function normalizeTeamName(name) {
  if (!name) return "";
  return name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesFuzzy(teamA, teamB) {
  const normA = normalizeTeamName(teamA);
  const normB = normalizeTeamName(teamB);
  if (normA === normB) return true;
  
  if (NAME_MAP[normA] && NAME_MAP[normA].includes(normB)) return true;
  if (NAME_MAP[normB] && NAME_MAP[normB].includes(normA)) return true;

  const tokensA = normA.split(" ").filter(t => t.length > 2);
  const tokensB = normB.split(" ").filter(t => t.length > 2);
  if (tokensA.length > 0 && tokensB.length > 0) {
    const matchCount = tokensA.filter(t => tokensB.includes(t)).length;
    if (matchCount >= Math.min(tokensA.length, tokensB.length)) {
      return true;
    }
  }
  return false;
}

// -------------------------------------------------------------
// AUTOMATED FOTMOB SCRAPER (PRIMARY)
// -------------------------------------------------------------
export async function syncFotMobData(db) {
  try {
    console.log("[sync] Scraping FotMob World Cup Matches & Standings...");
    const html = await fetchText("https://www.fotmob.com/leagues/77/overview/world-cup", 12000);
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) {
      throw new Error("Could not find __NEXT_DATA__ JSON script block in FotMob HTML");
    }

    const payload = JSON.parse(match[1]);
    const pageProps = payload.props?.pageProps;
    if (!pageProps) {
      throw new Error("Missing pageProps inside __NEXT_DATA__");
    }

    // 1. Process Standings
    if (pageProps.table && pageProps.table[0] && pageProps.table[0].data && Array.isArray(pageProps.table[0].data.tables)) {
      const tables = pageProps.table[0].data.tables;
      let count = 0;
      for (const groupTable of tables) {
        const groupName = groupTable.leagueName || "Group";
        if (groupName.includes("3rd") || groupName.toLowerCase().includes("third")) {
          console.log(`[sync] Skipping 3rd placed standings table: ${groupName}`);
          continue;
        }

        if (groupTable.table && Array.isArray(groupTable.table.all)) {
          count++;
          for (const row of groupTable.table.all) {
            const logoUrl = `https://images.fotmob.com/image_resources/logo/teamlogo/${row.id}.png`;
            const flagEmoji = getFlagByCountry(row.name);
            
            // Save standings
            await db.saveStanding({
              team: row.name,
              played: row.played || 0,
              wins: row.wins || 0,
              draws: row.draws || 0,
              losses: row.losses || 0,
              goalsFor: parseInt(row.scoresStr?.split("-")[0] || 0, 10),
              goalsAgainst: parseInt(row.scoresStr?.split("-")[1] || 0, 10),
              goalDifference: row.goalConDiff || 0,
              points: row.pts || 0,
              groupName,
              flag: logoUrl
            });

            // Save team metadata
            try {
              await db.d1
                .prepare("INSERT OR REPLACE INTO teams (country, flag, fifaCode, groupName, logo) VALUES (?, ?, ?, ?, ?)")
                .bind(row.name, flagEmoji, row.name.slice(0, 3).toUpperCase(), groupName, logoUrl)
                .run();
            } catch (err) {
              console.error("[sync] Error saving team:", err.message);
            }
          }
        }
      }
      console.log(`[sync] Successfully updated standings for ${count} groups`);
    }

    // 2. Process Matches
    if (pageProps.fixtures && Array.isArray(pageProps.fixtures.allMatches)) {
      const fixtures = pageProps.fixtures.allMatches;
      for (const f of fixtures) {
        let status = "notstarted";
        if (f.status?.finished) status = "finished";
        else if (f.status?.started) status = "live";

        const homeFlag = getFlagByCountry(f.home.name);
        const awayFlag = getFlagByCountry(f.away.name);
        const homeLogo = `https://images.fotmob.com/image_resources/logo/teamlogo/${f.home.id}.png`;
        const awayLogo = `https://images.fotmob.com/image_resources/logo/teamlogo/${f.away.id}.png`;
        const fotmobPageUrl = f.pageUrl ? `https://www.fotmob.com${f.pageUrl}` : null;

        await db.saveMatch({
          id: String(f.id),
          homeTeam: f.home.name,
          awayTeam: f.away.name,
          homeLogo,
          awayLogo,
          homeFlag,
          awayFlag,
          kickoff: new Date(f.status.utcTime).getTime(),
          status,
          score: f.status.scoreStr || "0 - 0",
          venue: null, // Will be populated by syncMatchDetails
          groupName: f.group ? ("Group " + f.group) : "Knockout",
          stage: typeof f.roundName === "string" ? f.roundName : ("Round " + f.roundName),
          competition: "FIFA World Cup",
          matchday: f.group ? `Matchday ${f.round || "1"}` : (f.roundName || "Knockout"),
          broadcasters: "Official Broadcaster",
          description: `FIFA World Cup 2026 fixture between ${f.home.name} and ${f.away.name}.`,
          thumbnail: "",
          banner: "",
          fotmobPageUrl
        });

        // Ensure teams exist in team database
        try {
          await db.d1
            .prepare("INSERT OR IGNORE INTO teams (country, flag, logo, groupName) VALUES (?, ?, ?, ?)")
            .bind(f.home.name, homeFlag, homeLogo, f.group ? ("Group " + f.group) : "Knockout")
            .run();
          await db.d1
            .prepare("INSERT OR IGNORE INTO teams (country, flag, logo, groupName) VALUES (?, ?, ?, ?)")
            .bind(f.away.name, awayFlag, awayLogo, f.group ? ("Group " + f.group) : "Knockout")
            .run();
        } catch (err) {}
      }
      console.log(`[sync] Successfully updated ${fixtures.length} matches in database`);
    }

  } catch (err) {
    console.error("[syncFotMobData] Error:", err.message);
  }
}

/**
 * syncMatchDetails - Fetches detailed match facts (stadium, city, country, referee, attendance)
 * from FotMob match pages for upcoming and recently-finished matches.
 * Runs after syncFotMobData as a second pass.
 */
export async function syncMatchDetails(db) {
  try {
    const allMatches = await db.getMatches();
    const now = Date.now();
    // Prioritize: live matches, then upcoming within 48h, then recently finished without details yet
    const needsDetails = allMatches.filter(m => {
      if (!m.fotmobPageUrl) return false;
      if (m.detailsFetched === 1) return false; // Skip already fetched
      const hoursFromNow = (m.kickoff - now) / (60 * 60 * 1000);
      const hoursSinceKickoff = (now - m.kickoff) / (60 * 60 * 1000);
      return m.status === 'live' || hoursFromNow < 48 || (hoursSinceKickoff < 6 && m.status === 'finished');
    });

    console.log(`[syncMatchDetails] Fetching details for ${needsDetails.length} matches...`);
    for (const match of needsDetails) {
      try {
        const html = await fetchText(match.fotmobPageUrl, 10000);
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
        if (!nextDataMatch) continue;

        const data = JSON.parse(nextDataMatch[1]);
        const infoBox = data.props?.pageProps?.content?.matchFacts?.infoBox;
        if (!infoBox) continue;

        const stadium = infoBox["Stadium"];
        const referee = infoBox["Referee"];
        const attendance = infoBox["Attendance"];

        await db.updateMatchDetails(match.id, {
          venue: stadium?.name || 'Venue to be confirmed',
          city: stadium?.city || null,
          country: stadium?.country || null,
          kickoff: match.kickoff,
          groupName: match.groupName,
          stage: match.stage,
          referee: referee?.text || null,
          attendance: typeof attendance === 'number' ? attendance : null,
          weather: null, // FotMob doesn't provide weather in this endpoint
          broadcasters: match.broadcasters,
          description: match.description,
          thumbnail: match.thumbnail,
          banner: match.banner
        });
        console.log(`[syncMatchDetails] Updated details for: ${match.homeTeam} vs ${match.awayTeam} | Venue: ${stadium?.name}`);
      } catch (err) {
        console.warn(`[syncMatchDetails] Failed for match ${match.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[syncMatchDetails] Error:", err.message);
  }
}

function getFlagByCountry(name) {
  if (!name) return "⚽";
  const lower = name.toLowerCase();
  if (lower.includes("germany")) return "🇩🇪";
  if (lower.includes("france")) return "🇫🇷";
  if (lower.includes("spain")) return "🇪🇸";
  if (lower.includes("italy")) return "🇮🇹";
  if (lower.includes("england")) return "🇬🇧";
  if (lower.includes("argentina")) return "🇦🇷";
  if (lower.includes("brazil")) return "🇧🇷";
  if (lower.includes("portugal")) return "🇵🇹";
  if (lower.includes("netherlands") || lower.includes("dutch")) return "🇳🇱";
  if (lower.includes("belgium")) return "🇧🇪";
  if (lower.includes("croatia")) return "🇭🇷";
  if (lower.includes("uruguay")) return "🇺🇾";
  if (lower.includes("mexico")) return "🇲🇽";
  if (lower.includes("usa") || lower.includes("united states")) return "🇺🇸";
  if (lower.includes("canada")) return "🇨🇦";
  if (lower.includes("morocco")) return "🇲🇦";
  if (lower.includes("japan")) return "🇯🇵";
  if (lower.includes("korea")) return "🇰🇷";
  if (lower.includes("denmark")) return "🇩🇰";
  if (lower.includes("switzerland")) return "🇨🇭";
  if (lower.includes("turkey")) return "🇹🇷";
  if (lower.includes("austria")) return "🇦🇹";
  return "⚽";
}

// -------------------------------------------------------------
// AUTOMATED STREAMED.PK SCRAPER
// -------------------------------------------------------------
async function fetchStreamedPkMatches() {
  try {
    const res = await fetch("https://streamed.pk/api/matches/all", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return data;
    }
  } catch (err) {
    console.warn("[sync] streamed.pk API failed, trying HTML parse:", err.message);
  }

  // Fallback: HTML parse
  try {
    const res = await fetch("https://streamed.pk/category/football", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      }
    });
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);
      const list = [];
      $('a[href^="/watch/"]').each((i, el) => {
        const href = $(el).attr("href");
        const title = $(el).text().trim() || $(el).find("h3, span, p").text().trim();
        if (href && title) {
          const id = href.replace("/watch/", "");
          list.push({
            title,
            category: "football",
            sources: [{ source: "streamed", id }]
          });
        }
      });
      return list;
    }
  } catch (err) {
    console.error("[sync] streamed.pk HTML scraper failed:", err.message);
  }
  return [];
}

async function resolveStreamedPkLinks(match) {
  const resolved = [];
  if (!match || !match.sources) return resolved;

  for (const src of match.sources) {
    try {
      const res = await fetch(`https://streamed.pk/api/stream/${src.source}/${src.id}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          data.forEach(stream => {
            if (stream.embedUrl) {
              resolved.push({
                provider: src.source,
                quality: stream.hd ? "1080P" : "720P",
                embedUrl: stream.embedUrl,
                mirror: stream.mirror || 0
              });
            }
          });
          if (resolved.length > 0) return resolved;
        }
      }
    } catch (err) {
      // Fallback watch page HTML parse
      try {
        const htmlRes = await fetch(`https://streamed.pk/watch/${src.id}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
          }
        });
        if (htmlRes.ok) {
          const html = await htmlRes.text();
          const $ = cheerio.load(html);
          const iframeSrc = $("iframe").attr("src");
          if (iframeSrc) {
            resolved.push({
              provider: src.source,
              quality: "720P",
              embedUrl: iframeSrc,
              mirror: 0
            });
          }
        }
      } catch (e) {}
    }
  }
  return resolved;
}

export async function syncFifaStreamsAndFeeds(db) {
  try {
    const dbMatches = await db.getMatches();
    const liveOrToday = dbMatches.filter(m => m.status === "live" || (Date.now() - m.kickoff) < 12 * 60 * 60 * 1000);
    if (liveOrToday.length === 0) return;

    console.log(`[sync] Checking streamed.pk feeds for ${liveOrToday.length} today matches...`);
    const streamMatches = await fetchStreamedPkMatches();
    if (streamMatches.length === 0) return;

    for (const match of liveOrToday) {
      // Find matching streamed.pk match by fuzzy name
      const candidate = streamMatches.find(sm => {
        if (!sm.title) return false;
        const parts = sm.title.split(/\s+vs\s+/i);
        const homeCandidate = parts[0] || "";
        const awayCandidate = parts[1] || "";
        return (
          (matchesFuzzy(match.homeTeam, homeCandidate) && matchesFuzzy(match.awayTeam, awayCandidate)) ||
          (matchesFuzzy(match.homeTeam, awayCandidate) && matchesFuzzy(match.awayTeam, homeCandidate))
        );
      });

      if (candidate) {
        const links = await resolveStreamedPkLinks(candidate);
        if (links.length > 0) {
          // Clear current streams to update priority
          await db.clearStreamsForMatch(match.id);
          // Sort links: 1080P/HD first
          links.sort((a, b) => b.quality.localeCompare(a.quality));
          for (let i = 0; i < links.length; i++) {
            await db.saveStream({
              matchId: match.id,
              provider: links[i].provider,
              quality: links[i].quality,
              embedUrl: links[i].embedUrl,
              mirror: i,
              isPrimary: i === 0 ? 1 : 0,
              priority: i,
              language: links[i].language || "EN"
            });
          }
          console.log(`[sync] Synced ${links.length} streams for: ${match.homeTeam} vs ${match.awayTeam}`);
        }
      }
    }
    
    // Cleanup expired streams
    await db.cleanExpiredMatchesAndStreams();
  } catch (err) {
    console.error("[syncFifaStreamsAndFeeds] Error:", err.message);
  }
}
