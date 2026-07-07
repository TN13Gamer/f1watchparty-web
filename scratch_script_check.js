
(function () {
  'use strict';

  /* ── Config ── */
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const API     = isLocal ? 'http://localhost:3000' : '';

  /* ── App State ── */
  const S = {
    streams:      [],
    sourceIdx:    0,
    raceData:     null,
    fixtures:     [],
    standings:    {},
    activeTab:    'live',
    activeGroup:  null,
    prevHS:       null,
    prevAS:       null,
    loaderDone:   false,
  };

  /* ══════════════════════════
     LOADER
  ══════════════════════════ */
  const loaderEl = document.getElementById('loader');

  function hideLoader() {
    if (S.loaderDone) return;
    S.loaderDone = true;
    loaderEl.style.transition = 'opacity 0.5s ease, visibility 0.5s';
    loaderEl.style.opacity = '0';
    loaderEl.style.visibility = 'hidden';
    loaderEl.style.pointerEvents = 'none';
  }

  // Always fire after 2s max — set BEFORE lottie so it always registers
  setTimeout(hideLoader, 2000);

  // Lottie is optional — if CDN fails we still show the page
  try {
    if (typeof lottie !== 'undefined') {
      lottie.loadAnimation({
        container:  document.getElementById('lottie-wrap'),
        renderer:   'svg',
        loop:       true,
        autoplay:   true,
        path:       'scene.json'
      });
    }
  } catch (e) {
    console.warn('[lottie]', e.message);
  }

  /* ══════════════════════════
     PLAYER CONTROLS
  ══════════════════════════ */
  const playerFrame  = document.getElementById('player-frame');
  const streamIframe = document.getElementById('stream-iframe');
  const miniIframe   = document.getElementById('mini-iframe');

  /* Theater mode */
  document.getElementById('ctrl-theater').addEventListener('click', () => {
    playerFrame.classList.toggle('theater');
    const icon = document.querySelector('#ctrl-theater i');
    icon.className = playerFrame.classList.contains('theater')
      ? 'fa-solid fa-compress-wide'
      : 'fa-solid fa-rectangle-wide';
  });

  /* Fullscreen */
  document.getElementById('ctrl-fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      playerFrame.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  });

  document.addEventListener('fullscreenchange', () => {
    const icon = document.querySelector('#ctrl-fullscreen i');
    icon.className = document.fullscreenElement ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
  });

  /* Auto-failover */
  document.getElementById('btn-failover').addEventListener('click', () => {
    if (S.streams.length > 1) {
      S.sourceIdx = (S.sourceIdx + 1) % S.streams.length;
      activateSource(S.sourceIdx);
    }
  });

  /* ══════════════════════════
     SOURCES
  ══════════════════════════ */
  const QUALITY_HINTS = ['HD', '', 'Backup', 'Alt', 'Ultra', '', '', ''];

  function activateSource(idx) {
    const link = S.streams[idx];
    if (!link?.url) return;
    S.sourceIdx = idx;

    streamIframe.src = link.url;
    miniIframe.src   = link.url;

    document.querySelectorAll('.src-btn').forEach((btn, i) => {
      btn.classList.toggle('active', i === idx);
    });
  }

  function renderSources() {
    const container = document.getElementById('source-list');
    if (!S.streams.length) {
      container.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted);">No feeds available</span>';
      return;
    }
    container.innerHTML = S.streams.map((_, i) => {
      const hint = QUALITY_HINTS[i] || '';
      return `<button class="src-btn${i === S.sourceIdx ? ' active' : ''}" data-i="${i}">
        Source ${i + 1}${hint ? `<span class="qtag">${hint}</span>` : ''}
      </button>`;
    }).join('');

    container.querySelectorAll('.src-btn').forEach(btn => {
      btn.addEventListener('click', () => activateSource(+btn.dataset.i));
    });
  }

  /* ══════════════════════════
     MATCH CARD
  ══════════════════════════ */
  function updateMatchCard(data) {
    if (!data) return;
    S.raceData = data;

    const homeName = (data.name || '').split(' vs ')[0]?.trim() || 'Home';
    const awayName = (data.name || '').split(' vs ')[1]?.trim() || 'Away';
    const hs = data.homeScore ?? '—';
    const as = data.awayScore ?? '—';

    document.getElementById('mc-comp').textContent   = data.round || 'FIFA World Cup 2026';
    document.getElementById('mc-home-name').textContent = homeName;
    document.getElementById('mc-away-name').textContent = awayName;
    document.getElementById('mc-stadium').textContent = data.circuit || data.location || '—';
    document.getElementById('mc-date').textContent    = data.date || '—';

    const hsEl = document.getElementById('mc-hs');
    const asEl = document.getElementById('mc-as');

    /* Flash on score change */
    if (S.prevHS !== null && S.prevHS !== hs) flashEl(hsEl);
    if (S.prevAS !== null && S.prevAS !== as) flashEl(asEl);
    S.prevHS = hs; S.prevAS = as;

    hsEl.textContent = hs;
    asEl.textContent = as;

    const statusEl  = document.getElementById('mc-status');
    const badgeLive = document.getElementById('badge-live');
    const timeLbl   = document.getElementById('mc-time-lbl');

    if (data.isLive) {
      statusEl.textContent  = data.matchTime ? `${data.matchTime}'` : 'LIVE';
      statusEl.className    = 'status-tag live';
      timeLbl.textContent   = data.matchTime ? `${data.matchTime}'` : 'LIVE';
      badgeLive.style.display = 'inline-flex';
    } else if (data.isFinished) {
      statusEl.textContent  = 'FT';
      statusEl.className    = 'status-tag finished';
      timeLbl.textContent   = 'Full Time';
      badgeLive.style.display = 'none';
    } else {
      statusEl.textContent  = 'Upcoming';
      statusEl.className    = 'status-tag upcoming';
      timeLbl.textContent   = data.date || 'Scheduled';
      badgeLive.style.display = 'none';
    }

    /* Mini player info */
    document.getElementById('mini-name').textContent  = data.name || 'Live Match';
    document.getElementById('mini-score').textContent = (data.isLive || data.isFinished)
      ? `${hs} — ${as}`
      : 'Upcoming';
  }

  function flashEl(el) {
    el.classList.remove('flashed');
    void el.offsetWidth; // reflow
    el.classList.add('flashed');
  }

  /* ══════════════════════════
     FETCH: LIVE CONFIG
  ══════════════════════════ */
  async function fetchConfig() {
    try {
      const r   = await fetch(`${API}/api/live-config`);
      if (!r.ok) throw new Error(r.status);
      const cfg = await r.json();

      if (cfg.fifa) {
        const { raceData, streamLinks } = cfg.fifa;
        if (raceData) updateMatchCard(raceData);

        if (Array.isArray(streamLinks) && streamLinks.length) {
          S.streams = streamLinks;
          renderSources();
          activateSource(0);
        } else {
          // No pre-saved streams — fetch live from streamed.st
          fetchStreams();
        }
      } else {
        fetchStreams();
      }
    } catch (e) {
      console.warn('[config]', e.message);
      // Fallback: fetch streams directly
      fetchStreams();
    } finally {
      hideLoader();
    }
  }

  async function fetchStreams() {
    try {
      const matchName = S.raceData?.name || '';
      const matchParam = matchName ? `?match=${encodeURIComponent(matchName)}` : '';
      const r = await fetch(`${API}/api/fifa/streams${matchParam}`);
      if (!r.ok) return;
      const d = await r.json();
      if (d.streamLinks?.length) {
        S.streams = d.streamLinks;
        renderSources();
        if (!streamIframe.src || streamIframe.src === location.href) activateSource(0);
      }
    } catch (e) {
      console.warn('[streams]', e.message);
    }
  }

  /* ══════════════════════════
     FETCH: FIXTURES
  ══════════════════════════ */
  async function fetchFixtures() {
    try {
      const r = await fetch(`${API}/api/fifa/fixtures`);
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d)) {
        S.fixtures = d;
        renderFixtures();
        updateNextCard();
      }
    } catch (e) { console.warn('[fixtures]', e.message); }
  }

  function updateNextCard() {
    const upcoming = S.fixtures
      .filter(f => f.status === 'notstarted' && !f.finished)
      .sort((a, b) => (a.kickoffTs || 0) - (b.kickoffTs || 0));

    const card = document.getElementById('next-card');
    if (upcoming.length) {
      const nx = upcoming[0];
      document.getElementById('next-name').textContent = `${nx.homeTeam} vs ${nx.awayTeam}`;
      document.getElementById('next-time').textContent = nx.localDate || '—';
      card.style.display = 'block';
    } else {
      card.style.display = 'none';
    }
  }

  /* Fixture Tabs */
  document.getElementById('fx-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('#fx-tabs .tab').forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    S.activeTab = btn.dataset.tab;
    renderFixtures();
  });

  function renderFixtures() {
    const track = document.getElementById('fx-track');

    const filtered = S.fixtures.filter(f => {
      if (S.activeTab === 'live')     return f.status === 'inprogress' || f.status === 'live';
      if (S.activeTab === 'upcoming') return f.status === 'notstarted' && !f.finished;
      return f.finished || f.status === 'finished';
    });

    if (!filtered.length) {
      track.innerHTML = `<div class="fx-empty">No ${S.activeTab} matches</div>`;
      return;
    }

    const currentName = S.raceData?.name || '';

    track.innerHTML = filtered.map(f => {
      const isLive  = f.status === 'inprogress' || f.status === 'live';
      const hasScore = isLive || f.finished;
      const isCurrent = currentName && `${f.homeTeam} vs ${f.awayTeam}` === currentName;

      const timeDisplay = isLive
        ? (f.matchTime ? `${f.matchTime}'` : 'LIVE')
        : (f.finished ? 'FT' : (f.localDate || '—'));

      return `<div class="fx-card${isLive ? ' is-live' : ''}${isCurrent ? ' is-current' : ''}" data-id="${f.id}" role="listitem">
        <div class="fx-top">
          <span class="fx-round">${f.round || 'Group Stage'}</span>
          ${isLive
            ? `<span class="fx-live-tag">● ${f.matchTime ? f.matchTime + "'" : 'LIVE'}</span>`
            : `<span class="fx-time">${timeDisplay}</span>`}
        </div>
        <div class="fx-teams">
          <div class="fx-team-row">
            <span class="fx-team-name">${escHtml(f.homeTeam || '—')}</span>
            ${hasScore ? `<span class="fx-score">${f.homeScore ?? '0'}</span>` : ''}
          </div>
          <div class="fx-divider"></div>
          <div class="fx-team-row">
            <span class="fx-team-name">${escHtml(f.awayTeam || '—')}</span>
            ${hasScore ? `<span class="fx-score">${f.awayScore ?? '0'}</span>` : ''}
          </div>
        </div>
        <div class="fx-foot">
          <i class="fa-solid fa-location-dot"></i>
          ${escHtml(f.stadium || 'FIFA Venue')}
        </div>
      </div>`;
    }).join('');
  }

  /* ══════════════════════════
     FETCH: STANDINGS
  ══════════════════════════ */
  async function fetchStandings() {
    try {
      const r = await fetch(`${API}/api/fifa/standings`);
      if (!r.ok) return;
      const d = await r.json();
      
      // Normalize: server may return array [{name, teams}] or object {groups: {}} 
      let groups = {};
      if (d?.groups && typeof d.groups === 'object' && !Array.isArray(d.groups)) {
        groups = d.groups;
      } else if (Array.isArray(d) && d.length) {
        // Main server returns [{name: 'Group A', teams: [...]}, ...]
        d.forEach(g => { if (g.name && Array.isArray(g.teams)) groups[g.name] = g.teams; });
      } else if (Array.isArray(d?.groups)) {
        d.groups.forEach(g => { if (g.name && Array.isArray(g.teams)) groups[g.name] = g.teams; });
      }
      
      if (Object.keys(groups).length) {
        S.standings = groups;
        renderGroupPills();
        const firstKey = Object.keys(groups)[0];
        S.activeGroup = firstKey;
        renderStandingsTable(groups[firstKey]);
      }
    } catch (e) { console.warn('[standings]', e.message); }
  }

  function renderGroupPills() {
    const container = document.getElementById('group-pills');
    const keys = Object.keys(S.standings);
    container.innerHTML = keys.map((g, i) =>
      `<button class="grp-pill${i === 0 ? ' active' : ''}" data-g="${g}">${g}</button>`
    ).join('');
    container.querySelectorAll('.grp-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.grp-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        S.activeGroup = btn.dataset.g;
        renderStandingsTable(S.standings[S.activeGroup]);
      });
    });
  }

  function renderStandingsTable(teams) {
    const tbody = document.getElementById('st-rows');
    if (!teams?.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:14px;font-size:0.78rem;">No data</td></tr>`;
      return;
    }
    tbody.innerHTML = teams.map((t, i) => {
      const bar = i < 2
        ? `<span class="q-bar up"></span>`
        : (i >= teams.length - 1 ? `<span class="q-bar dn"></span>` : '');
      const name = t.name || t.team || '—';
      const mp   = t.mp   ?? t.played ?? '—';
      const w    = t.w    ?? t.won    ?? '—';
      const d    = t.d    ?? t.drawn  ?? '—';
      const l    = t.l    ?? t.lost   ?? '—';
      const gd   = (t.gd   ?? ((t.gf || 0) - (t.ga || 0))) || '—';
      const pts  = t.pts  ?? t.points ?? '—';
      return `<tr>
        <td class="td-pos">${i + 1}</td>
        <td class="td-team">${bar}${escHtml(name)}</td>
        <td>${mp}</td><td>${w}</td><td>${d}</td><td>${l}</td>
        <td>${gd}</td>
        <td class="td-pts">${pts}</td>
      </tr>`;
    }).join('');
  }

  /* Standings toggle */
  const standingsWrap = document.getElementById('standings-wrap');
  document.getElementById('standings-toggle').addEventListener('click', () => {
    standingsWrap.classList.toggle('open');
    document.getElementById('standings-toggle')
      .setAttribute('aria-expanded', standingsWrap.classList.contains('open'));
  });
  document.getElementById('standings-toggle').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); standingsWrap.classList.toggle('open'); }
  });

  /* ══════════════════════════
     MOBILE MINI PLAYER
  ══════════════════════════ */
  const miniPlayer = document.getElementById('mini-player');

  if ('IntersectionObserver' in window) {
    const obs = new IntersectionObserver(entries => {
      const { isIntersecting } = entries[0];
      miniPlayer.classList.toggle('show', !isIntersecting);
    }, { threshold: 0.15 });
    obs.observe(playerFrame);
  }

  document.getElementById('mini-back').addEventListener('click', () => {
    playerFrame.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ══════════════════════════
     SOCKET CONNECTION
  ══════════════════════════ */
  let socket = null;
  try {
    if (typeof io !== 'undefined') {
      socket = io(API);
      console.log('[Socket] Initializing connection to', API);
      
      socket.on('connect', () => {
        console.log('[Socket] Connected successfully.');
      });

      socket.on('match:update', (data) => {
        console.log('[Socket] Match update received:', data);
        updateMatchCard(data);
      });

      socket.on('stream:update', (data) => {
        console.log('[Socket] Stream update received:', data);
        if (data.streams) {
          S.streams = data.streams;
          renderSources();
          if (!streamIframe.src || streamIframe.src === location.href) {
            activateSource(0);
          }
        }
      });
      
      socket.on('health:alert', (data) => {
        console.warn(`[Socket] Stream source reported dead for match ${data.matchId}: ${data.deadSource}`);
      });
    }
  } catch (e) {
    console.warn('[Socket] Failed to initialize:', e.message);
  }

  /* ══════════════════════════
     POLLING (FALLBACK)
  ══════════════════════════ */
  /* Score refresh every 5s */
  setInterval(async () => {
    if (socket && socket.connected) return; // Skip polling if socket is connected
    try {
      const r = await fetch(`${API}/api/live-config`);
      if (!r.ok) return;
      const cfg = await r.json();
      if (cfg.fifa?.raceData) updateMatchCard(cfg.fifa.raceData);
    } catch (_) {}
  }, 5000);

  /* Fixtures + standings refresh every 30s */
  setInterval(() => {
    if (socket && socket.connected) return; // Skip polling if socket is connected
    fetchFixtures();
    fetchStandings();
  }, 30000);

  /* ══════════════════════════
     UTILITIES
  ══════════════════════════ */
  function escHtml(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ══════════════════════════
     INIT
  ══════════════════════════ */
  /* Collapse standings on mobile by default */
  if (window.innerWidth < 768) {
    standingsWrap.classList.remove('open');
    document.getElementById('standings-toggle').setAttribute('aria-expanded', 'false');
  }

  fetchConfig();
  fetchFixtures();
  fetchStandings();

})();
