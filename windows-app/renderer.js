const fs = require('fs');
const path = require('path');

// Constants
const FIRESTORE_URL = "https://firestore.googleapis.com/v1/projects/f1-stream-live/databases/(default)/documents/app_data/live_config";
const FIFA_FIXTURES_URL = "https://f1watchparty-web-seven.vercel.app/api/fifa/fixtures";
const FIFA_STANDINGS_URL = "https://f1watchparty-web-seven.vercel.app/api/fifa/standings";

// State
let liveConfig = null;
let fifaFixtures = [];
let fifaStandings = [];
let currentF1StreamUrl = "";
let currentFifaStreamUrl = "";
let activeF1Tab = "f1-streams-tab";
let activeFifaTab = "fifa-streams-tab";
let showUpcomingFixtures = true;
let isF1DriversStandings = true;
let f1TimerInterval = null;
let fifaTimerInterval = null;
let hlsInstance = null;

// DOM Cache
const views = {
  splash: document.getElementById('splash-view'),
  home: document.getElementById('home-view'),
  f1: document.getElementById('f1-view'),
  fifa: document.getElementById('fifa-view')
};

/* ==========================================================================
   Initialization & Navigation
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  // Setup view transition buttons
  document.querySelectorAll('.enter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.currentTarget.closest('.sport-card');
      if (card.id === 'card-f1') {
        switchView('f1');
      } else if (card.id === 'card-fifa') {
        switchView('fifa');
      }
    });
  });

  document.querySelectorAll('.btn-back').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Pause any video playback when returning home
      stopActivePlayer();
      switchView('home');
    });
  });

  // Setup tab switcher buttons
  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', (e) => {
      const clickedTab = e.currentTarget;
      const targetPanelId = clickedTab.getAttribute('data-tab');
      
      // Update tab selection UI
      const parentContainer = clickedTab.closest('.tab-control');
      parentContainer.querySelectorAll('.tab-item').forEach(item => item.classList.remove('active'));
      clickedTab.classList.add('active');

      // Update panel visibility
      const panelWrapper = parentContainer.nextElementSibling;
      panelWrapper.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
      const activePanel = document.getElementById(targetPanelId);
      if (activePanel) {
        activePanel.classList.add('active');
      }
    });
  });

  // Setup toggle buttons (Standings & Fixtures)
  document.getElementById('btn-toggle-drivers').addEventListener('click', () => {
    toggleF1Standings(true);
  });
  document.getElementById('btn-toggle-constructors').addEventListener('click', () => {
    toggleF1Standings(false);
  });
  document.getElementById('btn-toggle-upcoming').addEventListener('click', () => {
    toggleFifaFixtures(true);
  });
  document.getElementById('btn-toggle-finished').addEventListener('click', () => {
    toggleFifaFixtures(false);
  });

  // Start initialization progress loader
  setTimeout(() => {
    initializeData();
  }, 2200); // Wait for splash animation draw sequence
});

function switchView(viewName) {
  // Clear all views
  Object.values(views).forEach(v => v.classList.remove('active'));
  
  // Activate selected view
  const targetView = views[viewName];
  if (targetView) {
    targetView.classList.add('active');
    
    // Page specific setups
    if (viewName === 'f1') {
      renderF1Screen();
    } else if (viewName === 'fifa') {
      renderFifaScreen();
    } else if (viewName === 'home') {
      updateHomeDashboard();
    }
  }
}

/* ==========================================================================
   Data Fetching & Fallbacks
   ========================================================================== */
async function initializeData() {
  // 1. Load local fallback data instantly so the UI populates immediately!
  liveConfig = loadLiveConfigFallback();
  fifaFixtures = loadFifaFixturesFallback();
  fifaStandings = loadFifaStandingsFallback();
  updateHomeDashboard();

  // 2. Transition from splash to home screen immediately after loader finishes
  switchView('home');

  // 3. Kick off live remote requests in parallel in the background
  Promise.all([
    fetchRemoteData(FIRESTORE_URL).then(configData => {
      if (configData) {
        liveConfig = parseFirestoreJson(configData);
        updateHomeDashboard();
        // If F1 view is open, refresh it dynamically
        if (views.f1.classList.contains('active')) {
          renderF1Screen();
        }
      }
    }),
    fetchRemoteData(FIFA_FIXTURES_URL).then(fixturesData => {
      if (fixturesData) {
        fifaFixtures = fixturesData;
        updateHomeDashboard();
        // If FIFA view is open, refresh it dynamically
        if (views.fifa.classList.contains('active')) {
          renderFifaScreen();
        }
      }
    }),
    fetchRemoteData(FIFA_STANDINGS_URL).then(standingsData => {
      if (standingsData) {
        fifaStandings = standingsData;
        // If FIFA view is open, refresh it dynamically
        if (views.fifa.classList.contains('active')) {
          renderFifaScreen();
        }
      }
    })
  ]).catch(err => console.log("Background API fetch finished with errors:", err));
}

async function fetchRemoteData(url) {
  // Use AbortController to set a 2-second timeout so slow responses fall back quickly.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
  }
}

// Fallback Readers (using filesystem access via nodeIntegration)
function loadLiveConfigFallback() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'assets', 'fallback_live_config.json'), 'utf8');
    return parseFirestoreJson(JSON.parse(raw));
  } catch (err) {
    console.error("Failed to read fallback_live_config.json:", err);
    return null;
  }
}

function loadFifaFixturesFallback() {
  try {
    const rawTeams = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'fallback_teams.json'), 'utf8'));
    const rawGames = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'fallback_games.json'), 'utf8'));
    
    const teamsById = {};
    const teamsByName = {};
    (rawTeams.teams || []).forEach(t => {
      if (t.id) teamsById[t.id] = t;
      if (t.name_en) teamsByName[t.name_en.toLowerCase()] = t;
    });

    return (rawGames.games || []).map(g => {
      const homeName = g.home_team_name_en || g.home_team_label || "TBD";
      const awayName = g.away_team_name_en || g.away_team_label || "TBD";
      
      const homeTeam = teamsById[g.home_team_id] || teamsByName[homeName.toLowerCase()];
      const awayTeam = teamsById[g.away_team_id] || teamsByName[awayName.toLowerCase()];
      const homeFlag = homeTeam ? homeTeam.flag : "";
      const awayFlag = awayTeam ? awayTeam.flag : "";

      const homeScore = parseInt(g.home_score || "0", 10) || 0;
      const awayScore = parseInt(g.away_score || "0", 10) || 0;
      
      const timeElapsed = (g.time_elapsed || "").toLowerCase().trim();
      const finished = (g.finished || "").toUpperCase() === "TRUE" || timeElapsed === "finished" || timeElapsed === "ft";
      const status = (timeElapsed === "live" || timeElapsed === "ht") ? "live" : (finished ? "finished" : "notstarted");

      const kickoffTs = parseFifaDateToMs(g.local_date, g.stadium_id || "4");
      
      return {
        matchId: g.id || "",
        homeTeam: homeName,
        awayTeam: awayName,
        homeFlag: homeFlag,
        awayFlag: awayFlag,
        status: status,
        homeScore: homeScore,
        awayScore: awayScore,
        kickoffTs: kickoffTs
      };
    });
  } catch (err) {
    console.error("Failed to read FIFA fallbacks:", err);
    return [];
  }
}

function loadFifaStandingsFallback() {
  try {
    const rawTeams = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'fallback_teams.json'), 'utf8'));
    const rawGroups = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'fallback_groups.json'), 'utf8'));
    
    const teamsById = {};
    (rawTeams.teams || []).forEach(t => {
      if (t.id) teamsById[t.id] = t;
    });

    return (rawGroups.groups || []).map(g => {
      const groupName = `Group ${g.name}`;
      const teams = (g.teams || []).map((t, idx) => {
        const teamInfo = teamsById[t.team_id];
        return {
          position: idx + 1,
          name: teamInfo ? teamInfo.name_en : `Team ${t.team_id}`,
          flag: teamInfo ? teamInfo.flag : "",
          played: t.mp || 0,
          points: t.pts || 0,
          gd: t.gd || 0
        };
      });
      return { name: groupName, teams: teams };
    });
  } catch (err) {
    console.error("Failed to load standings fallbacks:", err);
    return [];
  }
}

/* ==========================================================================
   Home Dashboard Logic
   ========================================================================== */
function updateHomeDashboard() {
  if (!liveConfig) return;

  const isF1Live = liveConfig.isLiveRaceActive && liveConfig.streamLinks.length > 0;
  const isFifaLive = liveConfig.isFifaLive && liveConfig.fifaStreamLinks.length > 0;

  // Render F1 Card Badge
  const f1Badge = document.getElementById('badge-f1');
  if (isF1Live) {
    f1Badge.className = "badge live";
    f1Badge.innerText = "LIVE NOW";
  } else {
    f1Badge.className = "badge upcoming";
    
    // Find next F1 race schedule session
    const nextSession = findNextF1Session();
    if (nextSession) {
      f1Badge.innerText = `UPCOMING: ${formatUtcToIst(nextSession.time, "d MMM HH:mm 'IST'")}`;
    } else if (liveConfig.nextRace && liveConfig.nextRace.date) {
      f1Badge.innerText = `UPCOMING: ${liveConfig.nextRace.date}`;
    } else {
      f1Badge.innerText = "UPCOMING";
    }
  }

  // Render FIFA Card Badge
  const fifaBadge = document.getElementById('badge-fifa');
  if (isFifaLive) {
    fifaBadge.className = "badge live";
    fifaBadge.innerText = "LIVE NOW";
  } else {
    fifaBadge.className = "badge upcoming";
    
    // Find next FIFA match kickoff
    const upcomingMatches = fifaFixtures.filter(f => f.status === "notstarted" && f.kickoffTs > Date.now());
    if (upcomingMatches.length > 0) {
      upcomingMatches.sort((a, b) => a.kickoffTs - b.kickoffTs);
      fifaBadge.innerText = `UPCOMING: ${formatUtcToIst(upcomingMatches[0].kickoffTs, "d MMM HH:mm 'IST'")}`;
    } else {
      fifaBadge.innerText = "UPCOMING";
    }
  }
}

/* ==========================================================================
   F1 Arena Logic
   ========================================================================== */
function renderF1Screen() {
  if (!liveConfig) return;

  // Load streams list
  const streamContainer = document.getElementById('f1-streams-list');
  streamContainer.innerHTML = '';
  
  if (liveConfig.streamLinks.length === 0) {
    streamContainer.innerHTML = '<div class="player-placeholder">No streams configured in admin panel.</div>';
  } else {
    liveConfig.streamLinks.forEach((stream, index) => {
      const card = document.createElement('div');
      card.className = `stream-card ${currentF1StreamUrl === stream.url ? 'selected' : ''}`;
      card.innerHTML = `
        <i class="fa-solid fa-play"></i>
        <div class="stream-info">
          <div class="stream-name">${stream.name}</div>
          <div class="stream-status">${currentF1StreamUrl === stream.url ? 'Active Player' : 'Tap to watch stream'}</div>
        </div>
      `;
      card.addEventListener('click', () => {
        selectF1Stream(stream.url, stream.name);
      });
      streamContainer.appendChild(card);
    });

    // Auto-select first stream if none selected
    if (!currentF1StreamUrl && liveConfig.streamLinks.length > 0) {
      selectF1Stream(liveConfig.streamLinks[0].url, liveConfig.streamLinks[0].name);
    }
  }

  // Load Schedule list
  const scheduleContainer = document.getElementById('f1-schedule-list');
  scheduleContainer.innerHTML = '';

  if (liveConfig.schedule.length === 0) {
    scheduleContainer.innerHTML = '<div class="player-placeholder">No schedule sessions configured.</div>';
  } else {
    liveConfig.schedule.forEach(session => {
      const parsedDate = parseResilientDate(session.timer);
      let status = "upcoming";
      let displayTime = session.time;
      let displayDate = session.date;

      if (parsedDate) {
        const startMs = parsedDate.getTime();
        let endMs = startMs + 2 * 60 * 60 * 1000; // 2 hour default session duration
        
        if (session.endTime && session.endTime.includes(":")) {
          try {
            const parts = session.endTime.split(":");
            const endCal = new Date(parsedDate.getTime());
            endCal.setHours(parseInt(parts[0], 10));
            endCal.setMinutes(parseInt(parts[1], 10));
            endCal.setSeconds(0);
            let endCalculated = endCal.getTime();
            if (endCalculated < startMs) {
              endCalculated += 24 * 60 * 60 * 1000;
            }
            endMs = endCalculated;
          } catch(e) {}
        }
        
        const now = Date.now();
        if (now < startMs) {
          status = "upcoming";
        } else if (now >= startMs && now < endMs) {
          status = "live";
        } else {
          status = "ended";
        }

        displayTime = `${formatUtcToIst(startMs, "HH:mm")} - ${formatUtcToIst(endMs, "HH:mm")} IST`;
        displayDate = formatUtcToIst(startMs, "EEEE, d MMMM");
      }

      const card = document.createElement('div');
      card.className = 'schedule-card';
      card.innerHTML = `
        <div class="schedule-top">
          <span class="schedule-date">${displayDate}</span>
          <span class="status-badge ${status}">${status}</span>
        </div>
        <div class="schedule-name">${session.name}</div>
        <div class="schedule-bottom ${status === 'live' ? 'live' : ''}">
          <i class="fa-solid fa-clock"></i> <span>${displayTime}</span>
        </div>
      `;
      scheduleContainer.appendChild(card);
    });
  }

  // Load standings tables
  renderF1Standings();
}

async function selectF1Stream(url, name) {
  currentF1StreamUrl = url;
  document.getElementById('f1-playing-title').innerText = `Playing: ${name}`;
  
  // Highlight active stream card
  document.querySelectorAll('#f1-streams-list .stream-card').forEach((card, index) => {
    const isSelected = liveConfig.streamLinks[index] && liveConfig.streamLinks[index].url === url;
    card.className = `stream-card ${isSelected ? 'selected' : ''}`;
    card.querySelector('.stream-status').innerText = isSelected ? 'Active Player' : 'Tap to watch stream';
  });

  // Resolve and render player
  await renderStreamPlayer('f1-player-container', 'f1-player-controls', url);
}

function renderF1Standings() {
  const driversList = document.getElementById('f1-drivers-list');
  driversList.innerHTML = '';
  if (liveConfig.standings.length === 0) {
    driversList.innerHTML = '<tr><td colspan="3" style="text-align: center">No driver data available.</td></tr>';
  } else {
    liveConfig.standings.forEach(d => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="pos-col">${d.position}</td>
        <td>
          <div class="driver-profile">
            ${d.image ? `<img class="driver-img" src="${d.image}">` : `<div class="driver-img"></div>`}
            <div class="driver-details">
              <span class="driver-name">${d.name}</span>
              <span class="driver-team">${d.team}</span>
            </div>
          </div>
        </td>
        <td class="pts-col">${d.points}</td>
      `;
      driversList.appendChild(row);
    });
  }

  const constructorsList = document.getElementById('f1-constructors-list');
  constructorsList.innerHTML = '';
  if (liveConfig.constructors.length === 0) {
    constructorsList.innerHTML = '<tr><td colspan="3" style="text-align: center">No constructor data available.</td></tr>';
  } else {
    liveConfig.constructors.forEach(c => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="pos-col">${c.position}</td>
        <td style="font-weight: 600; color: #fff">${c.name}</td>
        <td class="pts-col">${c.points}</td>
      `;
      constructorsList.appendChild(row);
    });
  }
}

function toggleF1Standings(showDrivers) {
  isF1DriversStandings = showDrivers;
  
  const driversBtn = document.getElementById('btn-toggle-drivers');
  const constructorsBtn = document.getElementById('btn-toggle-constructors');
  const driversTable = document.getElementById('f1-drivers-table-wrapper');
  const constructorsTable = document.getElementById('f1-constructors-table-wrapper');

  if (showDrivers) {
    driversBtn.classList.add('active');
    constructorsBtn.classList.remove('active');
    driversTable.classList.add('active');
    constructorsTable.classList.remove('active');
  } else {
    driversBtn.classList.remove('active');
    constructorsBtn.classList.add('active');
    driversTable.classList.remove('active');
    constructorsTable.classList.add('active');
  }
}

/* ==========================================================================
   FIFA Arena Logic
   ========================================================================== */
function renderFifaScreen() {
  if (!liveConfig) return;

  // Load streams list
  const streamContainer = document.getElementById('fifa-streams-list');
  streamContainer.innerHTML = '';
  
  if (liveConfig.fifaStreamLinks.length === 0) {
    streamContainer.innerHTML = '<div class="player-placeholder">No FIFA streams configured.</div>';
  } else {
    liveConfig.fifaStreamLinks.forEach((stream, index) => {
      const card = document.createElement('div');
      card.className = `stream-card ${currentFifaStreamUrl === stream.url ? 'selected' : ''}`;
      card.innerHTML = `
        <i class="fa-solid fa-play"></i>
        <div class="stream-info">
          <div class="stream-name">${stream.name}</div>
          <div class="stream-status">${currentFifaStreamUrl === stream.url ? 'Active Player' : 'Tap to watch stream'}</div>
        </div>
      `;
      card.addEventListener('click', () => {
        selectFifaStream(stream.url, stream.name);
      });
      streamContainer.appendChild(card);
    });

    // Auto-select first stream if none selected
    if (!currentFifaStreamUrl && liveConfig.fifaStreamLinks.length > 0) {
      selectFifaStream(liveConfig.fifaStreamLinks[0].url, liveConfig.fifaStreamLinks[0].name);
    }
  }

  // Load Fixtures
  renderFifaFixtures();

  // Load Standings Tables
  renderFifaStandings();
}

async function selectFifaStream(url, name) {
  currentFifaStreamUrl = url;
  document.getElementById('fifa-playing-title').innerText = `Playing: ${name}`;
  
  // Highlight active stream card
  document.querySelectorAll('#fifa-streams-list .stream-card').forEach((card, index) => {
    const isSelected = liveConfig.fifaStreamLinks[index] && liveConfig.fifaStreamLinks[index].url === url;
    card.className = `stream-card ${isSelected ? 'selected' : ''}`;
    card.querySelector('.stream-status').innerText = isSelected ? 'Active Player' : 'Tap to watch stream';
  });

  // Resolve and render player
  await renderStreamPlayer('fifa-player-container', 'fifa-player-controls', url);
}

function renderFifaFixtures() {
  const upcomingList = document.getElementById('fifa-fixtures-upcoming-list');
  const finishedList = document.getElementById('fifa-fixtures-finished-list');
  
  upcomingList.innerHTML = '';
  finishedList.innerHTML = '';

  const upcomingData = fifaFixtures.filter(f => f.status === "live" || f.status === "notstarted");
  const finishedData = fifaFixtures.filter(f => f.status !== "live" && f.status !== "notstarted");

  // Render Upcoming
  if (upcomingData.length === 0) {
    upcomingList.innerHTML = '<div class="player-placeholder">No upcoming fixtures.</div>';
  } else {
    // Sort upcoming by closest date
    upcomingData.sort((a, b) => a.kickoffTs - b.kickoffTs);
    
    upcomingData.forEach(fixture => {
      const isLive = fixture.status === "live";
      const card = document.createElement('div');
      card.className = 'fixture-card';
      card.setAttribute('data-ts', fixture.kickoffTs);
      card.setAttribute('data-status', fixture.status);
      card.innerHTML = `
        <div class="fixture-top">
          <span class="fixture-date">${formatUtcToIst(fixture.kickoffTs, "EEEE, d MMMM")}</span>
          <span class="fifa-badge-pulse ${isLive ? 'live' : 'countdown'}" id="fixture-badge-${fixture.matchId}">
            ${isLive ? 'LIVE' : formatCountdownString(fixture.kickoffTs)}
          </span>
        </div>
        <div class="match-layout">
          <div class="team-block home">
            <span class="team-name">${fixture.homeTeam}</span>
            <span class="flag-emoji">${getFlagEmoji(fixture.homeFlag)}</span>
          </div>
          <div class="score-capsule ${isLive ? 'live' : 'vs'}" id="fixture-score-${fixture.matchId}">
            ${isLive ? `${fixture.homeScore} - ${fixture.awayScore}` : 'VS'}
          </div>
          <div class="team-block away">
            <span class="flag-emoji">${getFlagEmoji(fixture.awayFlag)}</span>
            <span class="team-name">${fixture.awayTeam}</span>
          </div>
        </div>
      `;
      upcomingList.appendChild(card);
    });
  }

  // Render Finished
  if (finishedData.length === 0) {
    finishedList.innerHTML = '<div class="player-placeholder">No finished fixtures.</div>';
  } else {
    // Sort finished by newest first
    finishedData.sort((a, b) => b.kickoffTs - a.kickoffTs);
    
    finishedData.forEach(fixture => {
      const card = document.createElement('div');
      card.className = 'fixture-card';
      card.innerHTML = `
        <div class="fixture-top">
          <span class="fixture-date">${formatUtcToIst(fixture.kickoffTs, "EEEE, d MMMM")}</span>
          <span class="fifa-badge-pulse finished">FINISHED</span>
        </div>
        <div class="match-layout">
          <div class="team-block home">
            <span class="team-name">${fixture.homeTeam}</span>
            <span class="flag-emoji">${getFlagEmoji(fixture.homeFlag)}</span>
          </div>
          <div class="score-capsule finished">
            ${fixture.homeScore} - ${fixture.awayScore}
          </div>
          <div class="team-block away">
            <span class="flag-emoji">${getFlagEmoji(fixture.awayFlag)}</span>
            <span class="team-name">${fixture.awayTeam}</span>
          </div>
        </div>
      `;
      finishedList.appendChild(card);
    });
  }

  // Start real-time countdown updates
  startFifaCountdownLoop();
}

function toggleFifaFixtures(showUpcoming) {
  showUpcomingFixtures = showUpcoming;
  
  const upcomingBtn = document.getElementById('btn-toggle-upcoming');
  const finishedBtn = document.getElementById('btn-toggle-finished');
  const upcomingList = document.getElementById('fifa-fixtures-upcoming-list');
  const finishedList = document.getElementById('fifa-fixtures-finished-list');

  if (showUpcoming) {
    upcomingBtn.classList.add('active');
    finishedBtn.classList.remove('active');
    upcomingList.classList.add('active');
    finishedList.classList.remove('active');
  } else {
    upcomingBtn.classList.remove('active');
    finishedBtn.classList.add('active');
    upcomingList.classList.remove('active');
    finishedList.classList.add('active');
  }
}

function startFifaCountdownLoop() {
  if (fifaTimerInterval) clearInterval(fifaTimerInterval);
  
  fifaTimerInterval = setInterval(() => {
    fifaFixtures.forEach(fixture => {
      const badge = document.getElementById(`fixture-badge-${fixture.matchId}`);
      if (badge && fixture.status === "notstarted") {
        badge.innerText = formatCountdownString(fixture.kickoffTs);
      }
    });
  }, 1000);
}

function renderFifaStandings() {
  const container = document.getElementById('fifa-groups-list');
  container.innerHTML = '';

  if (fifaStandings.length === 0) {
    container.innerHTML = '<div class="player-placeholder">No standings data available.</div>';
  } else {
    fifaStandings.forEach(group => {
      const section = document.createElement('div');
      section.className = 'group-section';
      
      let rowsHTML = '';
      group.teams.forEach(t => {
        rowsHTML += `
          <tr>
            <td class="pos-col">${t.position}</td>
            <td>
              <div class="fifa-team-cell">
                <span class="flag-emoji">${getFlagEmoji(t.flag)}</span>
                <span style="font-weight: 600; color: #fff">${t.name}</span>
              </div>
            </td>
            <td style="text-align: center; color: var(--text-silver)">${t.played}</td>
            <td class="gd-col">${t.gd >= 0 ? `+${t.gd}` : t.gd}</td>
            <td class="pts-col">${t.points}</td>
          </tr>
        `;
      });

      section.innerHTML = `
        <div class="group-title">${group.name}</div>
        <table class="standings-table">
          <thead>
            <tr>
              <th style="width: 8%">Pos</th>
              <th style="width: 60%">Team</th>
              <th style="width: 10%; text-align: center">PL</th>
              <th style="width: 12%; text-align: center">GD</th>
              <th style="width: 10%; text-align: right">PTS</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHTML}
          </tbody>
        </table>
      `;
      container.appendChild(section);
    });
  }
}

/* ==========================================================================
   Smart Video Player & Stream URL Resolution
   ========================================================================== */
async function renderStreamPlayer(containerId, controlsId, embedUrl) {
  const container = document.getElementById(containerId);
  const controls = document.getElementById(controlsId);
  
  // Clear any existing players & HLS instances
  stopActivePlayer();
  container.innerHTML = '<div class="player-placeholder">Loading player...</div>';
  controls.style.opacity = '0';
  controls.style.pointerEvents = 'none';

  if (!embedUrl) {
    container.innerHTML = '<div class="player-placeholder">No stream is currently broadcasting.</div>';
    return;
  }

  // Resolve stream target
  const resolved = await resolveStreamUrl(embedUrl);

  if (resolved.playerType === 'HLS') {
    // Restore default HLS controls
    const playBtn = controls.querySelector('.play-btn');
    if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    const brControls = controls.querySelector('.bottom-right-controls');
    if (brControls) brControls.style.display = 'flex';
    controls.onclick = null;
    controls.style.background = 'transparent';

    // 1. Render HTML5 video with hls.js
    const video = document.createElement('video');
    video.id = `video-${containerId}`;
    video.autoplay = true;
    video.setAttribute('playsinline', 'true');
    container.innerHTML = '';
    container.appendChild(video);

    if (Hls.isSupported()) {
      hlsInstance = new Hls({
        xhrSetup: function (xhr, url) {
          xhr.setRequestHeader('User-Agent', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
          if (resolved.referer) {
            xhr.setRequestHeader('Referer', resolved.referer);
          }
        }
      });
      hlsInstance.loadSource(resolved.url);
      hlsInstance.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = resolved.url;
    }

    // Attach custom UI controls
    setupPlayerControls(video, controlsId);
  } else {
    // 2. Fallback: Render secure Iframe wrapper
    const escapedUrl = resolved.url.replace(/"/g, '&quot;');
    container.innerHTML = `
      <iframe 
        src="${escapedUrl}" 
        allowfullscreen 
        allow="autoplay; fullscreen; encrypted-media" 
        scrolling="no" 
        frameborder="0">
      </iframe>`;
    
    // Show a simplified play overlay for the iframe fallback
    const playBtn = controls.querySelector('.play-btn');
    if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    
    const brControls = controls.querySelector('.bottom-right-controls');
    if (brControls) brControls.style.display = 'none';

    controls.style.opacity = '1';
    controls.style.pointerEvents = 'none';
    controls.style.background = 'rgba(0, 0, 0, 0.5)';
    controls.onclick = null;
  }
}

async function resolveStreamUrl(embedUrl) {
  const pushEmbdzRegex = /pushembdz\.store\/embed\/([\w\-]+)/;
  const match = embedUrl.match(pushEmbdzRegex);
  if (match) {
    const slug = match[1];
    try {
      const apiUrl = `https://api.pushembdz.store/v1/stream/${slug}`;
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': 'application/json',
          'Origin': 'https://pushembdz.store',
          'Referer': 'https://pushembdz.store/'
        }
      });
      if (response.ok) {
        const json = await response.json();
        if (json.success && json.stream && json.stream.link) {
          const link = json.stream.link;
          const method = json.stream.method || '';
          if (link.includes('.m3u8') || method === 'hls' || method === 'player' || method === 'jwp' || method === 'jwp2p') {
            return {
              url: link,
              playerType: 'HLS',
              referer: 'https://pushembdz.store/'
            };
          }
          return { url: link, playerType: 'iframe' };
        }
      }
    } catch (e) {
      console.error("Failed to resolve stream slug via pushembdz api:", e);
    }
  }
  
  // Default fallback to iframe embed
  return { url: embedUrl, playerType: 'iframe' };
}

function setupPlayerControls(video, controlsId) {
  const controls = document.getElementById(controlsId);
  const playBtn = controls.querySelector('.play-btn');
  const muteBtn = controls.querySelector('.mute-btn');
  const fullscreenBtn = controls.querySelector('.fullscreen-btn');

  // Restore defaults
  const brControls = controls.querySelector('.bottom-right-controls');
  if (brControls) brControls.style.display = 'flex';
  controls.onclick = null;
  controls.style.background = 'transparent';

  // Initially show controls if video is paused (not playing yet)
  controls.style.opacity = video.paused ? '1' : '0';
  controls.style.pointerEvents = 'all';

  // Toggle Controls Visiblity on Video Container hover
  let fadeTimeout = null;
  const resetFadeTimer = () => {
    controls.style.opacity = '1';
    if (fadeTimeout) clearTimeout(fadeTimeout);
    fadeTimeout = setTimeout(() => {
      if (!video.paused) {
        controls.style.opacity = '0';
      }
    }, 2500);
  };

  const parent = controls.parentElement;
  parent.addEventListener('mousemove', resetFadeTimer);
  parent.addEventListener('mouseleave', () => {
    if (!video.paused) controls.style.opacity = '0';
  });

  // Play / Pause Button logic
  playBtn.onclick = (e) => {
    e.stopPropagation();
    if (video.paused) {
      video.play();
      playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    } else {
      video.pause();
      playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
      controls.style.opacity = '1'; // keep visible when paused
    }
  };

  // Mute / Unmute Button logic
  muteBtn.onclick = (e) => {
    e.stopPropagation();
    video.muted = !video.muted;
    if (video.muted) {
      muteBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
    } else {
      muteBtn.innerHTML = '<i class="fa-solid fa-volume-up"></i>';
    }
  };

  // Fullscreen Button logic
  fullscreenBtn.onclick = (e) => {
    e.stopPropagation();
    if (!document.fullscreenElement) {
      parent.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
      fullscreenBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
    } else {
      document.exitFullscreen();
      fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    }
  };

  // Sync state if video events occur outside overlay
  video.onplay = () => {
    playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    resetFadeTimer();
  };
  video.onpause = () => {
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    controls.style.opacity = '1';
  };
}

function stopActivePlayer() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  // Clear players
  document.getElementById('f1-player-container').innerHTML = '<div class="player-placeholder">No stream is currently broadcasting.</div>';
  document.getElementById('fifa-player-container').innerHTML = '<div class="player-placeholder">No match stream selected.</div>';
  
  // Clear stream state
  currentF1StreamUrl = "";
  currentFifaStreamUrl = "";

  // Clear timers
  if (fifaTimerInterval) clearInterval(fifaTimerInterval);
}

/* ==========================================================================
   Utilities & Time Parsers
   ========================================================================== */
function parseFirestoreJson(json) {
  const fields = json.fields || {};
  
  const getVal = (f, def = "") => {
    if (!f) return def;
    if (f.stringValue !== undefined) return f.stringValue;
    if (f.integerValue !== undefined) return f.integerValue;
    return def;
  };

  // 1. streamLinks
  const streamLinks = [];
  const slArr = fields.streamLinks && fields.streamLinks.arrayValue && fields.streamLinks.arrayValue.values;
  if (slArr) {
    slArr.forEach(v => {
      const f = v.mapValue && v.mapValue.fields;
      if (f) {
        streamLinks.push({
          name: getVal(f.name),
          url: getVal(f.url)
        });
      }
    });
  }

  // 2. nextRace
  const nrMap = fields.nextRace && fields.nextRace.mapValue && fields.nextRace.mapValue.fields;
  const nextRace = {
    name: nrMap ? getVal(nrMap.name) : "",
    circuit: nrMap ? getVal(nrMap.circuit) : "",
    location: nrMap ? getVal(nrMap.location) : "",
    date: nrMap ? getVal(nrMap.date) : "",
    dateObj: nrMap ? getVal(nrMap.dateObj) : ""
  };

  // 3. standings
  const standings = [];
  const stArr = fields.standings && fields.standings.arrayValue && fields.standings.arrayValue.values;
  if (stArr) {
    stArr.forEach((v, idx) => {
      const f = v.mapValue && v.mapValue.fields;
      if (f) {
        standings.push({
          position: idx + 1,
          name: getVal(f.name),
          team: getVal(f.team),
          points: parseInt(getVal(f.points, "0"), 10) || 0,
          image: getVal(f.image)
        });
      }
    });
  }

  // 4. constructors
  const constructors = [];
  const coArr = fields.constructors && fields.constructors.arrayValue && fields.constructors.arrayValue.values;
  if (coArr) {
    coArr.forEach((v, idx) => {
      const f = v.mapValue && v.mapValue.fields;
      if (f) {
        constructors.push({
          position: idx + 1,
          name: getVal(f.name),
          points: parseInt(getVal(f.points, "0"), 10) || 0
        });
      }
    });
  }

  // 5. FIFA config map
  const fifaMap = fields.fifa && fields.fifa.mapValue && fields.fifa.mapValue.fields;
  const fifaStreamLinks = [];
  let fifaTwitchChannel = "watchf1olive";
  if (fifaMap) {
    fifaTwitchChannel = getVal(fifaMap.twitchChannel, "watchf1olive");
    const fslArr = fifaMap.streamLinks && fifaMap.streamLinks.arrayValue && fifaMap.streamLinks.arrayValue.values;
    if (fslArr) {
      fslArr.forEach(v => {
        const f = v.mapValue && v.mapValue.fields;
        if (f) {
          fifaStreamLinks.push({
            name: getVal(f.name),
            url: getVal(f.url)
          });
        }
      });
    }
  }

  // 6. schedule
  const schedule = [];
  const schArr = fields.schedule && fields.schedule.arrayValue && fields.schedule.arrayValue.values;
  if (schArr) {
    schArr.forEach(v => {
      const f = v.mapValue && v.mapValue.fields;
      if (f) {
        schedule.push({
          timer: getVal(f.timer),
          date: getVal(f.date),
          name: getVal(f.name),
          endTime: getVal(f.endTime),
          time: getVal(f.time),
          day: getVal(f.day)
        });
      }
    });
  }

  const isLiveRaceActive = fields.isLiveRaceActive ? !!fields.isLiveRaceActive.booleanValue : false;
  
  const fifaRaceData = fifaMap && fifaMap.raceData && fifaMap.raceData.mapValue && fifaMap.raceData.mapValue.fields;
  const isFifaLive = fifaRaceData && fifaRaceData.isLive ? !!fifaRaceData.isLive.booleanValue : false;

  return {
    twitchChannel: getVal(fields.twitchChannel, "watchf1olive"),
    streamLinks,
    nextRace,
    standings,
    constructors,
    fifaTwitchChannel,
    fifaStreamLinks,
    schedule,
    isLiveRaceActive,
    isFifaLive
  };
}

function findNextF1Session() {
  if (!liveConfig || liveConfig.schedule.length === 0) return null;
  const now = Date.now();
  const upcoming = [];
  liveConfig.schedule.forEach(s => {
    const parsed = parseResilientDate(s.timer);
    if (parsed && parsed.getTime() > now) {
      upcoming.push({ session: s, time: parsed.getTime() });
    }
  });
  if (upcoming.length > 0) {
    upcoming.sort((a, b) => a.time - b.time);
    return upcoming[0].session;
  }
  // Fallback to Race session timer
  return liveConfig.schedule.find(s => s.name.toLowerCase() === 'race') || null;
}

function parseResilientDate(dateStr) {
  if (!dateStr) return null;
  const clean = dateStr.trim();
  // Match YYYY-MM-DD[T]HH:mm[:ss] and parse in user local timezone to avoid UTC shift
  const m = clean.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  }
  
  // Fallbacks
  let d = new Date(clean);
  if (!isNaN(d.getTime())) return d;
  
  const cleanT = clean.replace(' ', 'T');
  d = new Date(cleanT);
  if (!isNaN(d.getTime())) return d;
  
  return null;
}

function parseFifaDateToMs(rawDate, stadiumId) {
  try {
    if (!rawDate) return 0;
    const parts = rawDate.trim().split(/\s+/);
    if (parts.length < 2) return 0;
    
    const dateParts = parts[0].split('/').map(n => parseInt(n, 10));
    const timeParts = parts[1].split(':').map(n => parseInt(n, 10));
    if (dateParts.length < 3 || timeParts.length < 2) return 0;

    const month = dateParts[0] - 1;
    const day = dateParts[1];
    const year = dateParts[2];
    const hour = timeParts[0];
    const minute = timeParts[1];

    const offsets = {
      "1": -6, "2": -6, "3": -6, "4": -5, "5": -5, "6": -5,
      "7": -4, "8": -4, "9": -4, "10": -4, "11": -4, "12": -4,
      "13": -7, "14": -7, "15": -7, "16": -7
    };
    const offset = offsets[stadiumId] !== undefined ? offsets[stadiumId] : -4;
    
    // Create Date using UTC then adjust for stadium offset
    const date = new Date(Date.UTC(year, month, day, hour - offset, minute, 0));
    return date.getTime();
  } catch(e) {
    return 0;
  }
}

function formatUtcToIst(timestampMs, pattern) {
  if (!timestampMs) return "";
  const date = new Date(timestampMs);
  
  // Format to Asia/Kolkata
  const options = { timeZone: 'Asia/Kolkata' };
  
  if (pattern.includes("d MMMM") || pattern.includes("d MMM")) {
    const formatted = date.toLocaleDateString('en-US', {
      timeZone: 'Asia/Kolkata',
      weekday: pattern.includes("EEEE") ? 'long' : undefined,
      day: 'numeric',
      month: pattern.includes("MMMM") ? 'long' : 'short'
    });
    return formatted;
  }
  
  if (pattern.includes("HH:mm")) {
    return date.toLocaleTimeString('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  // Fallback default format
  return date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
}

function formatCountdownString(targetTs) {
  const diff = targetTs - Date.now();
  if (diff <= 0) return "LIVE NOW";

  const totalSecs = Math.floor(diff / 1000);
  const secs = totalSecs % 60;
  const totalMins = Math.floor(totalSecs / 60);
  const mins = totalMins % 60;
  const totalHours = Math.floor(totalMins / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m ${secs}s`;
  }
  return `${mins}m ${secs}s`;
}

function getFlagEmoji(countryCode) {
  if (!countryCode) return '';
  const code = countryCode.trim().toUpperCase();
  if (code.length === 2) {
    // Convert 2-letter ISO country code to flag emoji
    const codePoints = code.split('').map(char => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
  }
  
  // Fallbacks for common names if the code is a name
  const nameMapping = {
    'spain': '🇪🇸', 'saudi arabia': '🇸🇦', 'usa': '🇺🇸', 'germany': '🇩🇪',
    'france': '🇫🇷', 'italy': '🇮🇹', 'brazil': '🇧🇷', 'argentina': '🇦🇷',
    'mexico': '🇲🇽', 'canada': '🇨🇦', 'portugal': '🇵🇹', 'morocco': '🇲🇦',
    'japan': '🇯🇵', 'south korea': '🇰🇷', 'croatia': '🇭🇷', 'england': '🏴 England'
  };
  return nameMapping[countryCode.toLowerCase()] || '🏳️';
}

// Global window blur listener to hide play overlay controls when user clicks inside iframe stream web elements
window.addEventListener('blur', () => {
  if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
    const f1Controls = document.getElementById('f1-player-controls');
    const fifaControls = document.getElementById('fifa-player-controls');
    if (f1Controls) {
      f1Controls.style.opacity = '0';
      f1Controls.style.pointerEvents = 'none';
    }
    if (fifaControls) {
      fifaControls.style.opacity = '0';
      fifaControls.style.pointerEvents = 'none';
    }
  }
});
