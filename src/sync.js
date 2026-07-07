/**
 * src/sync.js
 * Consolidated sync tasks for F1 and FIFA dashboards.
 * Automated FotMob and streamed.pk scraping.
 */

import * as cheerio from "cheerio";
import { parseResponse, fixEmbedUrl, scoreStream, API_URL as PUSH_EMB_API_URL } from "../api/providers/pushembdz";



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
    // Do not catch individually inside the try block, so any failure triggers the catch fallback
    const dl = await fetchJson("https://ergast.com/api/f1/current/driverStandings.json", 6000)
      .then(res => res.MRData.StandingsTable.StandingsLists[0].DriverStandings);

    const cl = await fetchJson("https://ergast.com/api/f1/current/constructorStandings.json", 6000)
      .then(res => res.MRData.StandingsTable.StandingsLists[0].ConstructorStandings);

    return { dl, cl, source: "ergast.com" };
  } catch (err) {
    console.error("[sync] Ergast failed, using formula1.com fallback:", err.message);
    
    // Drivers scraper
    const dlHtml = await fetchText("https://www.formula1.com/en/results.html/2026/drivers.html", 8000);
    const $dl = cheerio.load(dlHtml);
    const dl = [];
    $dl("table tbody tr").each((i, el) => {
      const cells = $dl(el).find("td");
      if (cells.length >= 5) {
        const pos = $dl(cells.eq(0)).text().trim();
        const driverHref = $dl(cells.eq(1)).find("a").attr("href");
        const fullName = formatDriverNameFromHref(driverHref);
        
        let team = $dl(cells.eq(3)).text().trim();
        let points = $dl(cells.eq(4)).text().trim();
        
        if (cells.length >= 6) {
          team = $dl(cells.eq(4)).text().trim();
          points = $dl(cells.eq(5)).text().trim();
        }
        
        if (fullName) {
          dl.push({
            position: pos,
            points,
            Driver: { fullName, familyName: fullName.split(" ").pop() },
            Constructor: { name: team }
          });
        }
      }
    });

    // Constructors scraper
    const clHtml = await fetchText("https://www.formula1.com/en/results.html/2026/team.html", 8000);
    const $cl = cheerio.load(clHtml);
    const cl = [];
    $cl("table tbody tr").each((i, el) => {
      const cells = $cl(el).find("td");
      if (cells.length >= 3) {
        const pos = $cl(cells.eq(0)).text().trim();
        const teamName = $cl(cells.eq(1)).text().trim();
        
        let points = $cl(cells.eq(2)).text().trim();
        if (cells.length >= 4) {
          points = $cl(cells.eq(3)).text().trim();
        }
        
        cl.push({
          position: pos,
          points,
          Constructor: { name: teamName }
        });
      }
    });

    return { dl, cl, source: "formula1.com" };
  }
}

export async function syncF1Standings(config, database) {
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
      
      await database.updateConfig(updatePayload);
      console.log(`[sync] F1 standings updated successfully from ${result.source}`);
      return updatePayload;
    }
  } catch (err) {
    console.error("[syncF1Standings] Failed to sync standings:", err.message);
  }
  return null;
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
    logs.push("[F1 Schedule] Checking user lock setting...");
    const config = database && typeof database.getConfig === "function" ? await database.getConfig().catch(() => ({})) : {};
    if (config && config.lockF1Schedule) {
      logs.push("[F1 Schedule] Auto-sync is locked by user (lockF1Schedule = true). Skipping schedule overwrite.");
      return { success: true, logs };
    }
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
