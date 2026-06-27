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
      for (const groupTable of tables) {
        const groupName = groupTable.leagueName || "Group";
        if (groupTable.table && Array.isArray(groupTable.table.all)) {
          for (const row of groupTable.table.all) {
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
              flag: `https://images.fotmob.com/image_resources/logo/teamlogo/${row.id}.png`
            });
          }
        }
      }
      console.log(`[sync] Successfully updated standings for ${tables.length} groups`);
    }

    // 2. Process Matches
    if (pageProps.fixtures && Array.isArray(pageProps.fixtures.allFixtures)) {
      const fixtures = pageProps.fixtures.allFixtures;
      for (const f of fixtures) {
        let status = "notstarted";
        if (f.status?.finished) status = "finished";
        else if (f.status?.started) status = "live";

        await db.saveMatch({
          id: String(f.id),
          homeTeam: f.home.name,
          awayTeam: f.away.name,
          homeLogo: `https://images.fotmob.com/image_resources/logo/teamlogo/${f.home.id}.png`,
          awayLogo: `https://images.fotmob.com/image_resources/logo/teamlogo/${f.away.id}.png`,
          homeFlag: getFlagByCountry(f.home.name),
          awayFlag: getFlagByCountry(f.away.name),
          kickoff: new Date(f.status.utcTime).getTime(),
          status,
          score: f.status.scoreStr || "0 - 0",
          venue: f.status.reason?.short || "Stadium",
          groupName: f.roundName?.includes("Group") ? f.roundName : "Knockout",
          stage: f.roundName || "Group Stage",
          competition: "FIFA World Cup"
        });
      }
      console.log(`[sync] Successfully updated ${fixtures.length} matches in database`);
    }
  } catch (err) {
    console.error("[syncFotMobData] Error:", err.message);
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
              mirror: i
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
