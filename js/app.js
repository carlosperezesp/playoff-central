const MLB_API = 'https://statsapi.mlb.com/api/v1';
const CURRENT_YEAR = new Date().getFullYear();

// Whitelist of boxscore keys read by the Top Games "yesterday" renderer
// (_aSelectStars / _aGameTagsHTML and their helpers). Cuts each boxscore
// payload ~75% (≈184KB → 47KB). Verified to preserve the players map and
// every consumed stat — keep in sync if those helpers read new fields.
const TG_BOXSCORE_FIELDS = 'teams,away,home,team,id,abbreviation,players,person,fullName,allPositions,position,stats,batting,pitching,atBats,hits,doubles,triples,homeRuns,baseOnBalls,hitByPitch,sacFlies,rbi,runs,stolenBases,caughtStealing,strikeOuts,inningsPitched,earnedRuns,gamesStarted,battersFaced,pitchers,teamStats';

const COUNTRY_FLAG = {
  'USA': '🇺🇸', 'Dominican Republic': '🇩🇴', 'Venezuela': '🇻🇪',
  'Cuba': '🇨🇺', 'Panama': '🇵🇦', 'Puerto Rico': '🇵🇷',
  'Mexico': '🇲🇽', 'Japan': '🇯🇵', 'South Korea': '🇰🇷',
  'Korea, South': '🇰🇷', 'Republic of Korea': '🇰🇷', 'Korea': '🇰🇷',
  'Canada': '🇨🇦', 'Colombia': '🇨🇴', 'Nicaragua': '🇳🇮',
  'Brazil': '🇧🇷', 'Australia': '🇦🇺', 'Curacao': '🇨🇼',
  'Netherlands': '🇳🇱', 'Germany': '🇩🇪', 'Taiwan': '🇹🇼',
  'Bahamas': '🇧🇸', 'Aruba': '🇦🇼', 'Honduras': '🇭🇳',
  'Jamaica': '🇯🇲', 'Peru': '🇵🇪', 'Guatemala': '🇬🇹',
  'Dominican Rep.': '🇩🇴', 'U.S.A.': '🇺🇸', 'Italy': '🇮🇹',
};
// Flag follows nationality, which isn't always birthCountry (born abroad to a
// national family, etc.). Per-player overrides by MLB id correct those cases.
const FLAG_OVERRIDES = {
  695505: 'USA', // Chase Burns: born in Naples, Italy, but American.
};
function countryFlag(country, pid) {
  if (pid && FLAG_OVERRIDES[pid]) country = FLAG_OVERRIDES[pid];
  if (!country) return '';
  return COUNTRY_FLAG[country] || '';
}

// ── CACHE SYSTEM ─────────────────────────────────────────────────────────────
// Cache refreshes after the estimated final game window, with 10:00 Amsterdam as fallback.
// Tracker history is additive — past snapshots are never deleted.
const SMART_CACHE_EXPIRY_KEY = 'mlb_smart_cache_expiry';
const ESTIMATED_GAME_DURATION_MS = 3.5 * 60 * 60 * 1000;
const POST_LAST_GAME_REFRESH_DELAY_MS = 4 * 60 * 60 * 1000;

function isPacificDST(date) {
  // US DST: 2nd Sunday of March (2am PST→PDT) through 1st Sunday of November (2am PDT→PST)
  const y = date.getUTCFullYear();
  const marchFirst = new Date(Date.UTC(y, 2, 1));
  const dstStart = new Date(Date.UTC(y, 2, (7 - marchFirst.getUTCDay()) % 7 + 8, 10)); // 2am PST = 10:00 UTC
  const novFirst = new Date(Date.UTC(y, 10, 1));
  const dstEnd   = new Date(Date.UTC(y, 10, (7 - novFirst.getUTCDay()) % 7 + 1,   9)); // 2am PDT = 09:00 UTC
  return date >= dstStart && date < dstEnd;
}

function getAmsterdamFallbackCacheExpiry() {
  // 1:00 AM PT = 08:00 UTC in summer (PDT, UTC-7) / 09:00 UTC in winter (PST, UTC-8)
  // This is 10:00 in Amsterdam for the MLB season and remains the public fallback time.
  const now = new Date();
  const utcHour = isPacificDST(now) ? 8 : 9;
  const expiry = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0));
  if (now >= expiry) expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry.getTime();
}

function dateKeyInTimeZone(date = new Date(), timeZone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getStoredSmartCacheExpiry() {
  try {
    const raw = localStorage.getItem(SMART_CACHE_EXPIRY_KEY);
    if (!raw) return null;
    const smart = JSON.parse(raw);
    const todayKey = dateKeyInTimeZone();
    if (smart.dateKey !== todayKey || !smart.expiry || Date.now() >= smart.expiry) return null;
    return smart.expiry;
  } catch(e) {
    return null;
  }
}

function getCacheExpiry() {
  return getStoredSmartCacheExpiry() || getAmsterdamFallbackCacheExpiry();
}

function applyCacheExpiryToDailyKeys(expiry) {
  try {
    const dailyKeys = [
      'mlb_standings',
      `mvp_cache_${CURRENT_YEAR}`,
      `mvp_cache_${CURRENT_YEAR}_v2`,
      ...Object.keys(localStorage).filter(k => k.startsWith('mlb_tracker_today_')),
    ];
    const todayKey = dateKeyInTimeZone();
    dailyKeys.forEach(key => {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !('data' in obj)) return;
      // Only extend entries stored today — older data must expire and refresh,
      // otherwise stale data gets its expiry pushed forward indefinitely.
      if (obj.expiry && Date.now() > obj.expiry) return;
      if (!obj.storedAt || dateKeyInTimeZone(new Date(obj.storedAt)) !== todayKey) return;
      localStorage.setItem(key, JSON.stringify({ ...obj, expiry }));
    });
  } catch(e) {}
}

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj.expiry && Date.now() > obj.expiry) { localStorage.removeItem(key); return null; }
    return obj.data ?? obj; // support both {expiry,data} and raw objects
  } catch(e) { return null; }
}

function cacheSet(key, data, useExpiry = true) {
  try {
    const payload = useExpiry ? { expiry: getCacheExpiry(), storedAt: Date.now(), data } : { data };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch(e) {
    // Quota exceeded — clear old tracker history and team caches, retry once
    try {
      localStorage.removeItem('mlb_tracker_history');
      Object.keys(localStorage).filter(k => k.startsWith('mlb_team_impact_')).forEach(k => localStorage.removeItem(k));
      localStorage.setItem(key, JSON.stringify({ expiry: getCacheExpiry(), storedAt: Date.now(), data }));
    } catch(e2) {}
  }
}

// Tracker history: additive, no expiry — past dates never change
function trackerHistoryGet() {
  try {
    const raw = localStorage.getItem('mlb_tracker_history');
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}

function trackerHistorySet(history) {
  try {
    localStorage.setItem('mlb_tracker_history', JSON.stringify(history));
  } catch(e) {}
}


const TEAM_META = {
  108: { name: 'Angels',      abbr: 'LAA', color: '#BA0021', logo: 'https://www.mlbstatic.com/team-logos/108.svg' },
  109: { name: 'Diamondbacks',abbr: 'ARI', color: '#A71930', logo: 'https://www.mlbstatic.com/team-logos/109.svg' },
  110: { name: 'Orioles',     abbr: 'BAL', color: '#DF4601', logo: 'https://www.mlbstatic.com/team-logos/110.svg' },
  111: { name: 'Red Sox',     abbr: 'BOS', color: '#BD3039', logo: 'https://www.mlbstatic.com/team-logos/111.svg' },
  112: { name: 'Cubs',        abbr: 'CHC', color: '#0E3386', logo: 'https://www.mlbstatic.com/team-logos/112.svg' },
  113: { name: 'Reds',        abbr: 'CIN', color: '#C6011F', logo: 'https://www.mlbstatic.com/team-logos/113.svg' },
  114: { name: 'Guardians',   abbr: 'CLE', color: '#00385D', logo: 'https://www.mlbstatic.com/team-logos/114.svg' },
  115: { name: 'Rockies',     abbr: 'COL', color: '#33006F', logo: 'https://www.mlbstatic.com/team-logos/115.svg' },
  116: { name: 'Tigers',      abbr: 'DET', color: '#0C2340', logo: 'https://www.mlbstatic.com/team-logos/116.svg' },
  117: { name: 'Astros',      abbr: 'HOU', color: '#002D62', logo: 'https://www.mlbstatic.com/team-logos/117.svg' },
  118: { name: 'Royals',      abbr: 'KC',  color: '#004687', logo: 'https://www.mlbstatic.com/team-logos/118.svg' },
  119: { name: 'Dodgers',     abbr: 'LAD', color: '#005A9C', logo: 'https://www.mlbstatic.com/team-logos/119.svg' },
  120: { name: 'Nationals',   abbr: 'WSH', color: '#AB0003', logo: 'https://www.mlbstatic.com/team-logos/120.svg' },
  121: { name: 'Mets',        abbr: 'NYM', color: '#002D72', logo: 'https://www.mlbstatic.com/team-logos/121.svg' },
  133: { name: 'Athletics',   abbr: 'ATH', color: '#003831', logo: 'https://www.mlbstatic.com/team-logos/133.svg' },
  134: { name: 'Pirates',     abbr: 'PIT', color: '#FDB827', logo: 'https://www.mlbstatic.com/team-logos/134.svg' },
  135: { name: 'Padres',      abbr: 'SD',  color: '#2F241D', logo: 'https://www.mlbstatic.com/team-logos/135.svg' },
  136: { name: 'Mariners',    abbr: 'SEA', color: '#0C2C56', logo: 'https://www.mlbstatic.com/team-logos/136.svg' },
  137: { name: 'Giants',      abbr: 'SF',  color: '#FD5A1E', logo: 'https://www.mlbstatic.com/team-logos/137.svg' },
  138: { name: 'Cardinals',   abbr: 'STL', color: '#C41E3A', logo: 'https://www.mlbstatic.com/team-logos/138.svg' },
  139: { name: 'Rays',        abbr: 'TB',  color: '#092C5C', logo: 'https://www.mlbstatic.com/team-logos/139.svg' },
  140: { name: 'Rangers',     abbr: 'TEX', color: '#003278', logo: 'https://www.mlbstatic.com/team-logos/140.svg' },
  141: { name: 'Blue Jays',   abbr: 'TOR', color: '#134A8E', logo: 'https://www.mlbstatic.com/team-logos/141.svg' },
  142: { name: 'Twins',       abbr: 'MIN', color: '#002B5C', logo: 'https://www.mlbstatic.com/team-logos/142.svg' },
  143: { name: 'Phillies',    abbr: 'PHI', color: '#E81828', logo: 'https://www.mlbstatic.com/team-logos/143.svg' },
  144: { name: 'Braves',      abbr: 'ATL', color: '#CE1141', logo: 'https://www.mlbstatic.com/team-logos/144.svg' },
  145: { name: 'White Sox',   abbr: 'CWS', color: '#27251F', logo: 'https://www.mlbstatic.com/team-logos/145.svg' },
  146: { name: 'Marlins',     abbr: 'MIA', color: '#00A3E0', logo: 'https://www.mlbstatic.com/team-logos/146.svg' },
  147: { name: 'Yankees',     abbr: 'NYY', color: '#003087', logo: 'https://www.mlbstatic.com/team-logos/147.svg' },
  158: { name: 'Brewers',     abbr: 'MIL', color: '#12284B', logo: 'https://www.mlbstatic.com/team-logos/158.svg' },
};

// Team-colored backdrop for transparent player cutouts (MLB "silo" headshots).
function shadeHex(hex, ratio) {            // ratio 0..1 toward black
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.round(((n >> 16) & 255) * (1 - ratio));
  const g = Math.round(((n >> 8) & 255) * (1 - ratio));
  const b = Math.round((n & 255) * (1 - ratio));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function siloHeadshot(pid) {
  return `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/${pid}/headshot/silo/current`;
}
function teamPhotoBg(team) {
  let c = '#26324a';
  if (typeof team === 'number') c = (TEAM_META[team] && TEAM_META[team].color) || c;
  else if (typeof team === 'string' && team) c = team;
  else if (team && team.color) c = team.color;
  return `linear-gradient(145deg, ${c} 0%, ${shadeHex(c, 0.45)} 100%)`;
}

// ── HISTORICAL RESULTS 2021–2025 ──────────────────────────────────────────
// Index: 0=2021, 1=2022, 2=2023, 3=2024, 4=2025
// ws=WS champ(amarillo) div=div champ(verde) wc=wild card(azul)
// out=no playoffs(gris)  bad=último/mal récord(rojo)
const TEAM_HISTORY = {
  // ── NL East ──────────────────────────────────────────────────
  144: ['ws', 'div','div','wc', 'out'], // ATL
  143: ['out','wc', 'wc', 'div','div'], // PHI
  121: ['out','wc', 'out','wc', 'out'], // NYM
  146: ['out','out','wc', 'bad','out'], // MIA
  120: ['bad','bad','bad','out','bad'], // WSN
  // ── NL Central ───────────────────────────────────────────────
  158: ['div','out','div','div','div'], // MIL
  112: ['out','out','out','out','wc' ], // CHC
  138: ['wc', 'div','bad','out','out'], // STL
  113: ['out','bad','out','out','wc' ], // CIN
  134: ['bad','bad','out','bad','bad'], // PIT
  // ── NL West ──────────────────────────────────────────────────
  119: ['wc', 'div','div','ws', 'ws' ], // LAD
  135: ['out','wc', 'out','wc', 'wc' ], // SD
  137: ['div','out','out','out','out'], // SF
  109: ['bad','out','wc', 'out','out'], // ARI
  115: ['out','bad','bad','bad','bad'], // COL
  // ── AL East ──────────────────────────────────────────────────
  147: ['wc', 'div','out','div','wc' ], // NYY
  141: ['out','wc', 'wc', 'bad','div'], // TOR
  111: ['wc', 'bad','bad','out','wc' ], // BOS
  110: ['bad','out','div','wc', 'bad'], // BAL
  139: ['div','wc', 'wc', 'out','out'], // TB
  // ── AL Central ───────────────────────────────────────────────
  114: ['out','div','out','div','div'], // CLE
  142: ['bad','out','div','out','out'], // MIN
  145: ['div','out','out','bad','bad'], // CWS
  116: ['out','out','out','wc', 'wc' ], // DET
  118: ['out','bad','bad','wc', 'out'], // KCR
  // ── AL West ──────────────────────────────────────────────────
  117: ['div','ws', 'div','div','out'], // HOU
  133: ['out','bad','bad','out','out'], // OAK/ATH
  108: ['out','out','out','bad','bad'], // LAA
  136: ['out','wc', 'out','out','div'], // SEA
  140: ['bad','out','ws', 'out','out'], // TEX
};
const HIST_YEARS = [2021,2022,2023,2024,2025];
const HIST_LABELS = { ws:'WS Champion', div:'Division Champ', wc:'Wild Card', out:'Missed playoffs', bad:'Last in division' };
function histDotsHTML(teamId) {
  const hist = TEAM_HISTORY[teamId];
  if (!hist) return '';
  return '<div class="hist-dots">' +
    hist.map((r,i) => `<span class="hist-dot ${r}" title="${HIST_YEARS[i]}: ${HIST_LABELS[r]}" data-label="${HIST_YEARS[i]}: ${HIST_LABELS[r]}" onclick="showHistTip(this)"></span>`).join('') +
  '</div>';
}

function showHistTip(el) {
  // Remove any existing tip
  document.querySelectorAll('.hist-tip').forEach(t => t.remove());
  const tip = document.createElement('div');
  tip.className = 'hist-tip';
  tip.textContent = el.dataset.label;
  el.parentElement.appendChild(tip);
  setTimeout(() => tip.remove(), 2000);
}

let allData = { standings: null, playoffs: null, schedule: null };
let playoffTeamIds = new Set();
let isPlayoffSeason = false;
let standingsNextGameCache = null;
const STANDINGS_LIVE_REFRESH_MS = 15 * 60 * 1000;
const STANDINGS_AFTER_START_CHECK_DELAY_MS = 3 * 60 * 60 * 1000;
const STANDINGS_MIN_REFRESH_DELAY_MS = 5 * 60 * 1000;
let standingsRefreshTimer = null;
let standingsRefreshState = {
  dateKey: null,
  lastFinalCount: null,
  allFinished: false,
  hasLiveGames: false,
  nextGameStart: null,
  inFlight: false,
};

function fetchWithTimeout(url, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Consistent, friendly error state for any tab/panel. `retryCall` is a JS
// snippet run on the RETRY button (omit to hide it). Detects offline.
function errorStateHTML(retryCall, opts = {}) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const title = offline ? "You're offline" : (opts.title || "Couldn't load this");
  const sub = offline
    ? 'Check your connection and try again.'
    : (opts.sub || 'The MLB data service may be busy. Give it a moment.');
  const retry = retryCall
    ? `<button class="retry-btn" onclick="${retryCall}">RETRY</button>`
    : '';
  return `<div class="error-box" style="padding:24px;text-align:center">
    <strong style="font-size:15px">${title}</strong>
    <div style="color:var(--muted);font-size:13px;margin-top:6px">${sub}</div>
    ${retry}
  </div>`;
}

async function refreshSmartCacheExpiry() {
  try {
    const dateKey = dateKeyInTimeZone();
    const existing = getStoredSmartCacheExpiry();
    if (existing) return existing;

    const res = await fetchWithTimeout(`${MLB_API}/schedule?sportId=1&date=${dateKey}`);
    if (!res.ok) throw new Error(`MLB API returned ${res.status}`);
    const data = await res.json();
    const games = data.dates?.[0]?.games || [];
    const starts = games
      .map(g => g.gameDate ? new Date(g.gameDate).getTime() : NaN)
      .filter(Number.isFinite);

    if (!starts.length) {
      localStorage.removeItem(SMART_CACHE_EXPIRY_KEY);
      return getAmsterdamFallbackCacheExpiry();
    }

    const expiry = Math.max(...starts) + ESTIMATED_GAME_DURATION_MS + POST_LAST_GAME_REFRESH_DELAY_MS;
    if (expiry > Date.now()) {
      localStorage.setItem(SMART_CACHE_EXPIRY_KEY, JSON.stringify({
        dateKey,
        expiry,
        generatedAt: Date.now(),
      }));
      applyCacheExpiryToDailyKeys(expiry);
      return expiry;
    }

    localStorage.removeItem(SMART_CACHE_EXPIRY_KEY);
    return getAmsterdamFallbackCacheExpiry();
  } catch(e) {
    console.warn('Smart cache expiry skipped:', e);
    return getAmsterdamFallbackCacheExpiry();
  }
}

function clearAllCache() {
  ['mlb_standings', 'mlb_tracker_history', `mvp_cache_${CURRENT_YEAR}`, `mvp_cache_${CURRENT_YEAR}_v2`].forEach(k => localStorage.removeItem(k));
  // Also clear any tracker today keys
  Object.keys(localStorage).filter(k => k.startsWith('mlb_tracker_today_')).forEach(k => localStorage.removeItem(k));
}

async function init() {
  const el = document.getElementById('standingsContent');
  el.innerHTML = `<div class="loading"><div class="spinner"></div><div class="loading-text">LOADING STANDINGS...</div></div>`;
  try {
    await Promise.all([loadStandings(), detectPlayoffs()]);
    if (!allData.standings || allData.standings.length === 0) {
      throw new Error('No standings data received');
    }
    renderStandings();
    startStandingsAutoRefresh(true);
    warmAppData();
  } catch(e) {
    console.error(e);
    // If we have cached data that might be corrupt, clear it and offer retry
    clearAllCache();
    el.innerHTML = errorStateHTML('init()', {
      sub: e.name === 'AbortError'
        ? 'The request timed out. The MLB data service may be slow right now.'
        : undefined,
    });
  }
}

async function detectPlayoffs() {
  try {
    const res = await fetchWithTimeout(`${MLB_API}/schedule/postseason/series?season=${CURRENT_YEAR}&sportId=1`);
    const data = await res.json();
    if (data.series && data.series.length > 0) {
      isPlayoffSeason = true;
      allData.playoffs = data;
      data.series.forEach(s => {
        if (s.series && s.series.teams) {
          s.series.teams.forEach(t => {
            if (t && t.team) playoffTeamIds.add(t.team.id);
          });
        }
      });
      document.getElementById('seasonBadge').textContent = `${CURRENT_YEAR} PLAYOFFS`;
    }
  } catch(e) {}
}

async function loadStandings() {
  return loadStandingsWithOptions();
}

async function loadStandingsWithOptions(options = {}) {
  const { force = false } = options;
  try {
    const cached = force ? null : cacheGet('mlb_standings');
    if (!force && cached && Array.isArray(cached) && cached.length > 0) {
      allData.standings = cached;
      return;
    }
  } catch(e) {
    localStorage.removeItem('mlb_standings');
  }
  const res = await fetchWithTimeout(`${MLB_API}/standings?leagueId=103,104&season=${CURRENT_YEAR}&standingsTypes=regularSeason&hydrate=team,division`);
  if (!res.ok) throw new Error(`MLB API returned ${res.status}`);
  const data = await res.json();
  allData.standings = data.records || [];
  if (allData.standings.length > 0) {
    cacheSet('mlb_standings', allData.standings);
  }
}

function standingsTodayKey() {
  return dateKeyInTimeZone();
}

function isStandingsTabActive() {
  return !!document.getElementById('tab-standings')?.classList.contains('active');
}

async function fetchTodayScheduleStatus() {
  const today = standingsTodayKey();
  const res = await fetchWithTimeout(`${MLB_API}/schedule?sportId=1&date=${today}&gameType=R&hydrate=linescore`);
  if (!res.ok) throw new Error(`MLB API returned ${res.status}`);
  const data = await res.json();
  const games = data.dates?.[0]?.games || [];
  const finals = games.filter(g => g.status?.abstractGameState === 'Final').length;
  const live = games.filter(g => g.status?.abstractGameState === 'Live').length;
  const upcomingStarts = games
    .filter(g => g.status?.abstractGameState === 'Preview' && g.gameDate)
    .map(g => new Date(g.gameDate).getTime())
    .filter(t => Number.isFinite(t) && t > Date.now());
  return {
    dateKey: today,
    totalGames: games.length,
    finalCount: finals,
    allFinished: games.length > 0 && finals === games.length,
    hasLiveGames: live > 0,
    nextGameStart: upcomingStarts.length ? Math.min(...upcomingStarts) : null,
  };
}

function stopStandingsAutoRefresh() {
  if (standingsRefreshTimer) clearTimeout(standingsRefreshTimer);
  standingsRefreshTimer = null;
}

function scheduleNextStandingsRefresh() {
  stopStandingsAutoRefresh();
  if (!isStandingsTabActive() || standingsRefreshState.allFinished) return;

  let delay = STANDINGS_LIVE_REFRESH_MS;
  if (standingsRefreshState.dateKey && !standingsRefreshState.hasLiveGames) {
    if (!standingsRefreshState.nextGameStart) return;
    delay = standingsRefreshState.nextGameStart - Date.now() + STANDINGS_AFTER_START_CHECK_DELAY_MS;
    delay = Math.max(delay, STANDINGS_MIN_REFRESH_DELAY_MS);
  }

  standingsRefreshTimer = setTimeout(checkStandingsAutoRefresh, delay);
}

function startStandingsAutoRefresh(reset = false) {
  const todayKey = standingsTodayKey();
  if (reset) {
    standingsRefreshState = {
      dateKey: null,
      lastFinalCount: null,
      allFinished: false,
      hasLiveGames: false,
      nextGameStart: null,
      inFlight: false,
    };
  } else if (standingsRefreshState.dateKey && standingsRefreshState.dateKey !== todayKey) {
    standingsRefreshState = {
      dateKey: null,
      lastFinalCount: null,
      allFinished: false,
      hasLiveGames: false,
      nextGameStart: null,
      inFlight: false,
    };
  }
  if (!isStandingsTabActive()) {
    stopStandingsAutoRefresh();
    return;
  }
  if (standingsRefreshState.inFlight) return;
  if (!standingsRefreshState.dateKey) {
    checkStandingsAutoRefresh();
    return;
  }
  scheduleNextStandingsRefresh();
}

async function checkStandingsAutoRefresh() {
  if (!isStandingsTabActive() || standingsRefreshState.inFlight) return;
  standingsRefreshState.inFlight = true;
  try {
    const status = await fetchTodayScheduleStatus();
    if (standingsRefreshState.dateKey !== status.dateKey) {
      standingsRefreshState.dateKey = status.dateKey;
      standingsRefreshState.lastFinalCount = null;
      standingsRefreshState.allFinished = false;
    }

    const firstObservation = standingsRefreshState.lastFinalCount === null;
    const finalsIncreased = !firstObservation && status.finalCount > standingsRefreshState.lastFinalCount;
    const dayJustFinished = status.allFinished && !standingsRefreshState.allFinished;

    standingsRefreshState.lastFinalCount = status.finalCount;
    standingsRefreshState.allFinished = status.allFinished;
    standingsRefreshState.hasLiveGames = status.hasLiveGames;
    standingsRefreshState.nextGameStart = status.nextGameStart;

    if (finalsIncreased || dayJustFinished) {
      await loadStandingsWithOptions({ force: true });
      if (isStandingsTabActive()) renderStandings();
    }
  } catch (e) {
    console.warn('Standings auto-refresh skipped:', e);
  } finally {
    standingsRefreshState.inFlight = false;
    scheduleNextStandingsRefresh();
  }
}

async function loadGamesRemaining(teamIds) {
  const today = new Date().toISOString().split('T')[0];
  const seasonEnd = `${CURRENT_YEAR}-10-01`;
  try {
    const res = await fetchWithTimeout(`${MLB_API}/schedule?sportId=1&startDate=${today}&endDate=${seasonEnd}&gameType=R`);
    const data = await res.json();
    const counts = {};
    teamIds.forEach(id => counts[id] = 0);
    (data.dates || []).forEach(d => {
      (d.games || []).forEach(g => {
        const a = g.teams.away.team.id, h = g.teams.home.team.id;
        if (counts[a] !== undefined) counts[a]++;
        if (counts[h] !== undefined) counts[h]++;
      });
    });
    return counts;
  } catch(e) { return {}; }
}

async function ensureStandingsNextGames(teamIds) {
  const needed = teamIds.filter(id => !(standingsNextGameCache && standingsNextGameCache[id]));
  if (!needed.length && standingsNextGameCache) return standingsNextGameCache;

  const today = new Date();
  const future = new Date(today);
  future.setDate(today.getDate() + 7);
  const fmt = d => d.toISOString().split('T')[0];
  try {
    const res = await fetchWithTimeout(`${MLB_API}/schedule?sportId=1&startDate=${fmt(today)}&endDate=${fmt(future)}&gameType=R&hydrate=team`);
    const data = await res.json();
    standingsNextGameCache = standingsNextGameCache || {};
    (data.dates || []).forEach(dateObj => {
      (dateObj.games || []).forEach(game => {
        const gameTime = game.gameDate ? new Date(game.gameDate) : null;
        const timeStr = gameTime
          ? gameTime.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })
          : null;
        const away = game.teams?.away;
        const home = game.teams?.home;
        if (!away?.team?.id || !home?.team?.id) return;
        const homeMeta = TEAM_META[home.team.id] || { abbr: home.team.abbreviation || '?', logo: `https://www.mlbstatic.com/team-logos/${home.team.id}.svg` };
        const awayMeta = TEAM_META[away.team.id] || { abbr: away.team.abbreviation || '?', logo: `https://www.mlbstatic.com/team-logos/${away.team.id}.svg` };
        if (!standingsNextGameCache[home.team.id]) {
          standingsNextGameCache[home.team.id] = {
            gamePk: game.gamePk,
            date: dateObj.date,
            opponent: awayMeta.abbr,
            opponentId: away.team.id,
            opponentLogo: awayMeta.logo,
            homeAway: 'vs',
            time: timeStr,
          };
        }
        if (!standingsNextGameCache[away.team.id]) {
          standingsNextGameCache[away.team.id] = {
            gamePk: game.gamePk,
            date: dateObj.date,
            opponent: homeMeta.abbr,
            opponentId: home.team.id,
            opponentLogo: homeMeta.logo,
            homeAway: '@',
            time: timeStr,
          };
        }
      });
    });
  } catch(e) {
    standingsNextGameCache = standingsNextGameCache || {};
  }
  return standingsNextGameCache;
}

function standingsNextGameLabel(game) {
  if (!game) return 'No next game confirmed.';
  const todayStr = new Date().toISOString().split('T')[0];
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  let dateLabel;
  if (game.date === todayStr) dateLabel = 'Today';
  else if (game.date === tomorrowStr) dateLabel = 'Tomorrow';
  else {
    const d = new Date(game.date + 'T12:00:00');
    dateLabel = d.toLocaleDateString('en-US', { weekday:'short', day:'numeric', month:'short' });
  }
  const timeLabel = game.time ? ` · ${game.time}` : '';
  return `${dateLabel}${timeLabel}`;
}

function isGameInTopGamesWindow(dateStr) {
  const todayStr = new Date().toISOString().split('T')[0];
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  return dateStr === todayStr || dateStr === tomorrowStr;
}

function findStandingsTeamRecord(teamId) {
  if (!allData.standings?.length) return null;
  for (const div of allData.standings) {
    const rec = (div.teamRecords || []).find(tr => tr.team?.id === teamId);
    if (rec) return rec;
  }
  return null;
}

function compareStandingsMetric(ownVal, oppVal, betterWhenHigher = true) {
  if (ownVal === oppVal) return 'standings-equal';
  const oppBetter = betterWhenHigher ? oppVal > ownVal : oppVal < ownVal;
  return oppBetter ? 'standings-better' : 'standings-worse';
}

function standingsCompareItem(label, ownVal, oppVal, displayVal, betterWhenHigher = true) {
  const cls = compareStandingsMetric(ownVal, oppVal, betterWhenHigher);
  return `<span class="standings-next-comp"><span class="standings-next-comp-label">${label}</span><span class="standings-next-comp-val ${cls}">${displayVal}</span></span>`;
}

function standingsL10Wins(tr) {
  const l10 = tr.records?.splitRecords?.find(s => s.type === 'lastTen');
  return l10 ? parseInt(l10.wins, 10) || 0 : 0;
}

function standingsStreakValue(tr) {
  const code = tr.streak?.streakCode || '';
  const num = parseInt(code.slice(1), 10) || 0;
  if (code.startsWith('W')) return num;
  if (code.startsWith('L')) return -num;
  return 0;
}

function standingsOpponentComparisonHTML(own, opp) {
  const ownPct = parseFloat(own.winningPercentage || 0);
  const oppPct = parseFloat(opp.winningPercentage || 0);
  const cls = compareStandingsMetric(ownPct, oppPct, true);
  return `<span class="standings-next-record ${cls}">${opp.wins}-${opp.losses}</span>`;
}

function focusTopGameTarget() {
  const tryOpen = () => {
    const targetInfo = window._topGamesTarget;
    if (!targetInfo) return;
    const target = document.querySelector(`.tg-game-row[data-gamepk="${targetInfo.gamePk}"]`);
    if (target) {
      const block = target.closest('.tg-day-block');
      const body = target.closest('.tg-day-body');
      const header = block?.querySelector('.tg-day-header');
      const chev = block?.querySelector('.tg-day-chevron');
      if (body && !body.classList.contains('open')) {
        body.classList.add('open');
        header?.classList.add('open');
        chev?.classList.add('open');
      }
      const gameId = target.id.replace(/^tgr-/, '');
      const detail = document.getElementById(`tgd-${gameId}`);
      if (detail && !detail.classList.contains('open')) tgToggleGame(gameId);
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window._topGamesTarget = null;
    } else {
      setTimeout(tryOpen, 150);
    }
  };
  setTimeout(tryOpen, 120);
}

function goToTopGame(gamePk, dateStr, source = 'standings') {
  window._fromStandingsTopGames = source === 'standings';
  window._fromMvpTopGames = source === 'mvp';
  window._topGamesTarget = { gamePk: String(gamePk), date: dateStr };
  switchTab('topgames');
  focusTopGameTarget();
}

function goToTopGameFromStandings(gamePk, dateStr) {
  goToTopGame(gamePk, dateStr, 'standings');
}

function renderStandingsNextGames(teamIds) {
  teamIds.forEach(teamId => {
    const wrap = document.getElementById(`stnext-content-${teamId}`);
    if (!wrap) return;
    const game = standingsNextGameCache?.[teamId];
    if (!game) {
      wrap.innerHTML = `<div class="standings-next-wrap"><span class="standings-next-label">NEXT GAME</span><span class="standings-next-meta">No next game confirmed.</span></div>`;
      return;
    }
    const own = findStandingsTeamRecord(teamId);
    const opp = findStandingsTeamRecord(game.opponentId);
    const comparisonHtml = own && opp ? standingsOpponentComparisonHTML(own, opp) : '';
    const isTopGamesTarget = isGameInTopGamesWindow(game.date);
    const timeMeta = standingsNextGameLabel(game);
    wrap.innerHTML = `<div class="standings-next-wrap${isTopGamesTarget ? ' standings-next-link' : ''}" ${isTopGamesTarget ? `onclick="goToTopGameFromStandings('${game.gamePk}','${game.date}')"` : ''}>
      <span class="standings-next-label">NEXT GAME</span>
      <span class="standings-next-matchup">
        <span>${game.homeAway === 'vs' ? 'VS' : '@'}</span>
        <img class="standings-next-logo" src="${game.opponentLogo}" onerror="this.style.display='none'" alt="">
        <span>${game.opponent}</span>
      </span>
      ${comparisonHtml || `<span class="standings-next-record standings-equal">—</span>`}
      <span class="standings-next-meta">${timeMeta}</span>
    </div>`;
  });
}

function renderWildcardNextGames(teamIds) {
  teamIds.forEach(teamId => {
    const wrap = document.getElementById(`wcnext-content-${teamId}`);
    if (!wrap) return;
    const game = standingsNextGameCache?.[teamId];
    if (!game) {
      wrap.innerHTML = `<div class="standings-next-wrap"><span class="standings-next-label">NEXT GAME</span><span class="standings-next-meta">No next game confirmed.</span></div>`;
      return;
    }
    const own = findStandingsTeamRecord(teamId);
    const opp = findStandingsTeamRecord(game.opponentId);
    const comparisonHtml = own && opp ? standingsOpponentComparisonHTML(own, opp) : '';
    const isTopGamesTarget = isGameInTopGamesWindow(game.date);
    const timeMeta = standingsNextGameLabel(game);
    wrap.innerHTML = `<div class="standings-next-wrap${isTopGamesTarget ? ' standings-next-link' : ''}" ${isTopGamesTarget ? `onclick="goToTopGameFromStandings('${game.gamePk}','${game.date}')"` : ''}>
      <span class="standings-next-label">NEXT GAME</span>
      <span class="standings-next-matchup">
        <span>${game.homeAway === 'vs' ? 'VS' : '@'}</span>
        <img class="standings-next-logo" src="${game.opponentLogo}" onerror="this.style.display='none'" alt="">
        <span>${game.opponent}</span>
      </span>
      ${comparisonHtml || `<span class="standings-next-record standings-equal">—</span>`}
      <span class="standings-next-meta">${timeMeta}</span>
    </div>`;
  });
}

async function renderStandings() {
  const el = document.getElementById('standingsContent');
  if (!allData.standings?.length) {
    el.innerHTML = `<div class="error-box" style="padding:24px">
      <strong>No standings data yet for ${CURRENT_YEAR}</strong><br><br>
      The MLB API hasn't published standings for this season yet, or there are no games played.
      <br><br><button onclick="init()" style="margin-top:8px;padding:6px 16px;background:var(--accent);color:#fff;border:none;cursor:pointer;font-family:'Barlow Condensed';font-size:14px;letter-spacing:1px">RETRY</button>
    </div>`;
    return;
  }

  // Render immediately with empty gamesRem, then load in background
  const allTeamIds = [];
  allData.standings.forEach(div => div.teamRecords.forEach(tr => allTeamIds.push(tr.team.id)));
  const gamesRem = {}; // render first with empty, then refresh
  loadGamesRemaining(allTeamIds).then(rem => {
    const maxGR = Math.max(0, ...Object.values(rem));
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { day:'numeric', month:'short' }).toUpperCase();
    const dateInfo = document.getElementById('standingsDateInfo');
    const wcDateInfo = document.getElementById('standingsDateInfoWildcard');
    const trackerGR = document.getElementById('trackerMaxGR');
    if (dateInfo && maxGR > 0) dateInfo.textContent = `${dateStr} · ${maxGR} Games Until Playoff`;
    if (wcDateInfo && maxGR > 0) wcDateInfo.textContent = `${dateStr} · ${maxGR} Games Until Playoff`;
    if (trackerGR && maxGR > 0) trackerGR.textContent = `· ${maxGR} GR`;
  }).catch(()=>{});

  const leagueWCIds = {};
  [103, 104].forEach(leagueId => {
    const leagueRecs = allData.standings.filter(r => r.league?.id === leagueId);
    let allT = []; const dlIds = new Set();
    leagueRecs.forEach(div => {
      const sorted = [...div.teamRecords].sort((a,b) => b.wins - a.wins);
      if (sorted[0]) dlIds.add(sorted[0].team.id);
      div.teamRecords.forEach(tr => allT.push(tr));
    });
    allT.sort((a,b) => parseFloat(b.winningPercentage) - parseFloat(a.winningPercentage));
    const divWIds = new Set(allT.filter(t => dlIds.has(t.team.id)).slice(0,3).map(t => t.team.id));
    const wc = allT.filter(t => !divWIds.has(t.team.id)).slice(0,3).map(t => t.team.id);
    leagueWCIds[leagueId] = new Set(wc);
  });

  const divMeta = {
    200: { name: 'AL West',    league: 103 },
    201: { name: 'AL East',    league: 103 },
    202: { name: 'AL Central', league: 103 },
    203: { name: 'NL West',    league: 104 },
    204: { name: 'NL East',    league: 104 },
    205: { name: 'NL Central', league: 104 },
  };

  // Count teams per status for hero card
  let heroLeaders = 0, heroWC = 0, heroTotal = 0;
  allData.standings.forEach(div => div.teamRecords.forEach(tr => {
    heroTotal++;
    if (tr.divisionRank === '1') heroLeaders++;
  }));

  let html = `

    <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap">
      <div class="standings-toggle">
        <button class="standings-toggle-btn active division-btn" id="btn-division" onclick="setStandingsView('division')">DIVISION STANDINGS</button>
        <button class="standings-toggle-btn wildcard-btn" id="btn-wildcard" onclick="setStandingsView('wildcard')">WILD CARD RACE</button>
      </div>
    </div>
    <div id="view-division">
      <div class="standings-meta">
        <span id="standingsDateInfo" class="standings-date-info"></span>
      </div>
      <div class="legend" style="margin-bottom:16px">
        <div class="legend-item"><div class="legend-dot div"></div> Division leader</div>
        <div class="legend-item"><div class="legend-dot wc"></div> Wild Card</div>
        <div class="legend-item"><div class="legend-dot out"></div> Eliminated</div>
      </div>
    </div>
    <div id="view-wildcard" style="display:none">
      <div class="standings-meta">
        <span id="standingsDateInfoWildcard" class="standings-date-info"></span>
      </div>
      <div class="legend" style="margin-bottom:20px">
        <div class="legend-item"><div class="legend-dot div"></div> Division leader</div>
        <div class="legend-item"><div class="legend-dot wc"></div> Wild Card</div>
        <div class="legend-item"><div class="legend-dot out"></div> Eliminated</div>
      </div>
      <div id="wcTablesContent" class="wc-tables-grid"></div>
    </div>`;

  const alDivs = allData.standings.filter(r => r.league?.id === 103);
  const nlDivs = allData.standings.filter(r => r.league?.id === 104);
  // Desktop: interleaved AL/NL. Mobile: AL then NL (via CSS order).
  // We render AL first, then NL, and use CSS grid-column to interleave on desktop.
  const orderedDivs = [...alDivs, ...nlDivs];

  html += `
    <div class="divisions-rows" id="divisionsGrid">`;

  let alIdx = 0, nlIdx = 0;
  orderedDivs.forEach((divRecord, di) => {
    const divId = divRecord.division?.id;
    const dm = divMeta[divId];
    if (!dm) return;
    const leagueId = divRecord.league?.id || dm.league;
    const wcIds = leagueWCIds[leagueId] || new Set();

    const teams = [...divRecord.teamRecords].sort((a,b) => b.wins - a.wins);
    const divLeaderId = teams[0]?.team?.id;

    let rows = '';
    teams.forEach((tr, i) => {
      const tid = tr.team.id;
      const meta = TEAM_META[tid] || { name: tr.team.name, abbr: tr.team.abbreviation || '???', logo: `https://www.mlbstatic.com/team-logos/${tid}.svg` };
      // Shorten long names for table compactness
      const displayName = meta.name === 'Diamondbacks' ? 'D-Backs' : meta.name;      const isDivLeader = tid === divLeaderId;
      const isWC = wcIds.has(tid) && !isDivLeader;
      const isElim = tr.eliminationNumber === 'E' || tr.wildCardEliminationNumber === 'E';
      const rowCls = isElim ? 'elim-row' : isDivLeader ? 'div-leader' : isWC ? 'wc-spot' : '';

      const pct = parseFloat(tr.winningPercentage || 0).toFixed(3).replace(/^0/, '');
      const gb = i === 0 ? `<span class="gb-leader">—</span>` : `<span class="gb-val">${tr.divisionGamesBack}</span>`;
      const gr = gamesRem[tid] !== undefined ? `<span class="games-rem gr-badge-${tid}">${gamesRem[tid]} GR</span>` : `<span class="games-rem gr-badge-${tid}" style="display:none"></span>`;
      const l10 = tr.records?.splitRecords?.find(s => s.type === 'lastTen');
      const l10str = l10 ? `${l10.wins}-${l10.losses}` : '—';
      const l10color = l10 ? (l10.wins > l10.losses ? 'var(--win)' : l10.wins < l10.losses ? 'var(--loss)' : 'var(--text)') : 'var(--muted)';
      const l10html = `<span style="font-family:'Barlow Condensed';font-weight:700;color:${l10color};white-space:nowrap">${l10str}</span>`;

      const streakCode = tr.streak?.streakCode || '—';
      const streakWin = streakCode.startsWith('W');
      const streakColor = streakCode === '—' ? 'var(--muted)' : streakWin ? 'var(--win)' : 'var(--loss)';
      const streakHtml = `<span style="font-family:'Barlow Condensed';font-weight:700;color:${streakColor}">${streakCode}</span>`;

      const mn = tr.magicNumber;
      const mnNum = parseInt(mn);
      let mnHtml = '<span style="color:var(--border)">—</span>';
      if (mn === 'E') {
        mnHtml = `<span style="font-family:'Barlow Condensed';font-size:11px;color:var(--loss);font-weight:700">ELIM</span>`;
      } else if (!isNaN(mnNum) && mnNum <= 50) {
        mnHtml = `<span style="display:inline-block;background:rgba(21,101,216,.1);color:var(--accent);border:1px solid rgba(21,101,216,.25);font-family:'Barlow Condensed';font-size:11px;font-weight:700;padding:1px 6px;min-width:22px;text-align:center">${mnNum}</span>`;
      } else if (!isNaN(mnNum) && mnNum === 0) {
        mnHtml = `<span style="font-family:'Barlow Condensed';font-size:11px;color:var(--win);font-weight:700">CLINCH</span>`;
      }

      let badge = '';
      if (isDivLeader) badge = `<span class="badge-div">DIV</span>`;
      else if (isWC) badge = `<span class="badge-wc">WC</span>`;

      rows += `<tr class="${rowCls} standings-team-row" id="strow-${divId}-${tid}" onclick="toggleStandingsTeamRow('${divId}','${tid}')">
        <td>
          <div class="team-cell" style="gap:7px">
            ${badge}
            <img class="team-logo-sm" style="width:22px;height:22px" src="https://www.mlbstatic.com/team-logos/${tid}.svg" onerror="this.style.display='none'" alt="">
            <span class="team-name-full" style="font-weight:500;font-size:14px;cursor:pointer;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:2px" onmouseover="this.style.textDecorationColor='var(--accent)'" onmouseout="this.style.textDecorationColor='transparent'" onclick="event.stopPropagation();goToTeam(${tid})">${displayName}</span>
            <span class="team-name-abbr" style="font-weight:600;font-size:14px;cursor:pointer" onclick="event.stopPropagation();goToTeam(${tid})">${meta.abbr}</span>
          </div>
        </td>
        <td class="r">${tr.wins}</td>
        <td class="r">${tr.losses}</td>
        <td class="r">${pct}</td>
        <td class="r">${gb}</td>
        <td class="r div-col-l10">${l10html}</td>
        <td class="r div-col-strk">${streakHtml}</td>
        <td class="r div-col-mn">${mnHtml}</td>
        <td class="r div-col-hist">${histDotsHTML(tid)}</td>
      </tr>
      <tr class="standings-team-detail" id="stnext-${divId}-${tid}">
        <td colspan="9"><div id="stnext-content-${tid}"><div class="standings-next-wrap"><span class="standings-next-label">NEXT GAME</span><span class="standings-next-meta">Loading...</span></div></div></td>
      </tr>`;
    });

    // Show MN column only if any team in this division has ≤30 games remaining or is eliminated
    const showMN = teams.some(tr => {
      const mn = tr.magicNumber;
      const mnNum = parseInt(mn);
      return mn === 'E' || (!isNaN(mnNum) && mnNum <= 30);
    });
    const mnColStyle = showMN ? '' : 'display:none';

    // On desktop: AL (league 103) goes in left column, NL in right. On mobile: AL first (natural order).
    const isAL = leagueId === 103;
    const cardOrder = isAL ? (alIdx++) : (3 + nlIdx++); // AL: order 0,1,2 → left col; NL: order 3,4,5 → right col
    html += `<div class="division-row"><div class="division-card" id="divcard-${divId}">
      <div class="division-header" id="divhdr-${divId}" onclick="toggleDivision(${divId})">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="division-name">${dm.name}</span>
          <span class="division-league">${isAL ? 'AMERICAN LEAGUE' : 'NATIONAL LEAGUE'}</span>
        </div>
        <svg class="div-chevron" id="divchev-${divId}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div id="divbody-${divId}">
        <table class="div-table">
          <thead><tr>
            <th>TEAM</th><th class="r">W</th><th class="r">L</th>
            <th class="r">PCT</th><th class="r">GB</th><th class="r div-col-l10" style="white-space:nowrap">L10</th><th class="r div-col-strk">STRK</th><th class="r div-col-mn" style="${mnColStyle}">MN</th><th class="r div-col-hist" style="white-space:nowrap;font-size:10px;letter-spacing:.5px">LAST 5 SEASONS</th>
          </tr></thead>
          <tbody>${rows.replace(/class="r div-col-mn"/g, `class="r div-col-mn" style="${mnColStyle}"`)}</tbody>
        </table>
      </div>
    </div>
    <div class="div-chart-card"><div class="tracker-section">
      <div class="tracker-header">
        <span class="tracker-title tracker-title-desktop">GAMES OVER .500 · ${dm.name}</span>
        <span class="tracker-title tracker-title-mobile">OVER .500 · ${dm.name}</span>
      </div>
      <div class="div-chart-body"><canvas id="divcanvas-${divId}"></canvas></div>
    </div></div></div>`;
  });

  html += `</div>`;
  el.innerHTML = html;

  // Update date info label
  const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { day:'numeric', month:'short' }).toUpperCase();
  const dateInfo = document.getElementById('standingsDateInfo');
  const wcDateInfo = document.getElementById('standingsDateInfoWildcard');
  if (dateInfo) dateInfo.textContent = dateStr;
  if (wcDateInfo) wcDateInfo.textContent = dateStr;

  ensureStandingsNextGames(allTeamIds).then(() => renderStandingsNextGames(allTeamIds)).catch(()=>{});

  // Draw every division's win% chart once tracker data is ready (desktop)
  if (trackerLoaded) drawAllDivisionCharts();
  else loadTrackerData().then(() => drawAllDivisionCharts()).catch(e => console.warn('Tracker load failed:', e));

  // Keep each chart matched to its standings height as fonts/logos load or the window resizes.
  if (window.ResizeObserver) {
    if (window._divRO) window._divRO.disconnect();
    window._divRO = new ResizeObserver(entries => {
      if (window.innerWidth <= 900 || !trackerLoaded) return;
      entries.forEach(en => drawDivChart(en.target.id.replace('divcard-', '')));
    });
    document.querySelectorAll('[id^="divcard-"]').forEach(c => window._divRO.observe(c));
  }

  // Render wild card tables
  renderWildCardTables();
}

// ── DIVISION TOGGLE ───────────────────────────────────────────────────────
let activeDivisionId = null; // null = show all

function toggleStandingsTeamRow(divId, teamId) {
  const row = document.getElementById(`strow-${divId}-${teamId}`);
  const detail = document.getElementById(`stnext-${divId}-${teamId}`);
  if (!row || !detail) return;
  const isOpen = detail.classList.contains('open');
  detail.classList.toggle('open', !isOpen);
  row.classList.toggle('open', !isOpen);
}

function toggleWildcardTeamRow(leagueKey, teamId) {
  const row = document.getElementById(`wcrow-${leagueKey}-${teamId}`);
  const detail = document.getElementById(`wcnext-${leagueKey}-${teamId}`);
  if (!row || !detail) return;
  const isOpen = detail.classList.contains('open');
  detail.classList.toggle('open', !isOpen);
  row.classList.toggle('open', !isOpen);
}

// Draw one division's win% chart into its own canvas, matched to the standings height.
function drawDivChart(divId) {
  divId = parseInt(divId);
  const canvas = document.getElementById(`divcanvas-${divId}`);
  const card = document.getElementById(`divcard-${divId}`);
  if (!canvas || !card || !TRACKER_DIVISIONS[divId] || !trackerLoaded) return;
  const desktop = window.innerWidth > 900;
  // Desktop pairs the chart height with the standings card; mobile keeps its CSS height.
  const chartCard = canvas.closest('.div-chart-card');
  if (chartCard) chartCard.style.height = desktop ? `${card.offsetHeight}px` : '';
  if (!canvas.offsetHeight) return;
  canvas.style.cursor = 'crosshair';
  canvas.onmousemove = (e) => onDivHover(e, divId);
  canvas.onmouseleave = () => onDivLeave(divId);
  if (desktop) drawDivisionWinLossTracker(divId, canvas, canvas.offsetHeight);
  else drawTracker(trackerDates.length - 1, divId, canvas, canvas.offsetHeight, { divisionChart: true });
}

function _divVisibleDates(divId) {
  const desktop = window.innerWidth > 900;
  if (!desktop) return trackerDates;
  divId = parseInt(divId);
  return trackerDates.filter(date => {
    const dr = (trackerData[date] || []).find(r => r.division?.id === divId);
    return !!dr?.teamRecords?.length;
  });
}

function onDivHover(e, divId) {
  const canvas = e.currentTarget;
  if (!canvas || !trackerLoaded) return;
  const visibleDates = _divVisibleDates(divId);
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const desktop = window.innerWidth > 900;
  const PAD = desktop
    ? divisionWinLossPadding(canvas.offsetWidth, canvas.offsetHeight)
    : trackerChartPadding(canvas.offsetWidth, canvas.offsetHeight, { showXAxis: true, divisionChart: true });
  const cW = canvas.offsetWidth - PAD.left - PAD.right;
  const relX = mx - PAD.left;
  if (relX < 0 || relX > cW) { onDivLeave(divId); return; }
  const idx = Math.max(0, Math.min(Math.round((relX / cW) * Math.max(visibleDates.length - 1, 1)), visibleDates.length - 1));
  if (trackerHoverIdx === idx && _hoverDiv === divId) return;
  trackerHoverIdx = idx; _hoverDiv = divId;
  drawDivChart(divId);
  showDivTooltip(idx, divId, visibleDates, e.clientX, e.clientY);
}

function onDivLeave(divId) {
  trackerHoverIdx = null; _hoverDiv = null;
  drawDivChart(divId);
  const tt = document.getElementById('divTrackerTooltip');
  if (tt) tt.style.display = 'none';
}

function showDivTooltip(idx, divId, visibleDates, cx, cy) {
  let tt = document.getElementById('divTrackerTooltip');
  if (!tt) {
    tt = document.createElement('div');
    tt.id = 'divTrackerTooltip';
    tt.style.cssText = 'position:fixed;background:#fff;border:1px solid var(--border);box-shadow:0 6px 20px rgba(0,0,0,.16);padding:9px 12px;pointer-events:none;min-width:150px;z-index:1000;border-radius:7px';
    document.body.appendChild(tt);
  }
  const date = visibleDates[idx];
  const recs = trackerData[date] || [];
  const dr = recs.find(r => r.division?.id === parseInt(divId));
  if (!dr) { tt.style.display = 'none'; return; }
  const d = new Date(date + 'T12:00:00');
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  tt.innerHTML = `<div style="font-family:'Bebas Neue';font-size:13px;letter-spacing:1.5px;color:#6b7280;margin-bottom:5px">${dateStr}</div>` +
    [...dr.teamRecords]
      .sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses))
      .map(tr => {
      const meta = TEAM_META[tr.team.id] || { abbr: '???' };
      const color = TEAM_COLORS_TRACKER[tr.team.id] || '#999';
      const diff = tr.wins - tr.losses;
      const diffColor = diff > 0 ? 'var(--win)' : diff < 0 ? 'var(--loss)' : '#6b7280';
      const pct = parseFloat(tr.winningPercentage || 0).toFixed(3).replace(/^0/, '');
      return `<div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12px">
        <span style="font-family:'Barlow Condensed';font-weight:700;color:${color};width:30px">${meta.abbr}</span>
        <span style="font-family:'Barlow Condensed';color:#6b7280;width:42px">${tr.wins}-${tr.losses}</span>
        <span style="font-family:'Barlow Condensed';font-weight:700;color:${diffColor};width:30px;text-align:right">${winLossLabel(diff)}</span>
        <span style="font-family:'Barlow Condensed';color:#9ca3af">${pct}</span></div>`;
    }).join('');
  tt.style.display = 'block';
  tt.style.left = Math.min(cx + 14, window.innerWidth - 240) + 'px';
  tt.style.top = Math.min(cy + 14, window.innerHeight - tt.offsetHeight - 10) + 'px';
}

// Desktop: draw every division's chart side-by-side.
function drawAllDivisionCharts() {
  if (window.innerWidth <= 900) return; // mobile draws lazily on click
  document.querySelectorAll('[id^="divcanvas-"]').forEach(cv => {
    drawDivChart(cv.id.replace('divcanvas-', ''));
  });
}

function toggleDivision(divId) {
  // Desktop: each division already shows its own chart — nothing to toggle.
  if (window.innerWidth > 900) return;
  // Mobile: clicking a division reveals its chart below it (one open at a time).
  const card = document.getElementById(`divcard-${divId}`);
  const row = card?.closest('.division-row');
  if (!row) return;
  const opening = !row.classList.contains('open');
  document.querySelectorAll('.division-row.open').forEach(r => r.classList.remove('open'));
  document.querySelectorAll('[id^="divhdr-"]').forEach(h => h.classList.remove('selected'));
  if (opening) {
    row.classList.add('open');
    document.getElementById(`divhdr-${divId}`)?.classList.add('selected');
    drawDivChart(divId);
  }
}

// ── STANDINGS VIEW TOGGLE ─────────────────────────────────────────────────
let standingsView = 'division';

function setStandingsView(view) {
  standingsView = view;
  document.querySelectorAll('.standings-toggle-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.getElementById(view === 'division' ? 'btn-division' : 'btn-wildcard');
  if (activeBtn) activeBtn.classList.add('active');
  document.getElementById('view-division').style.display = view === 'division' ? '' : 'none';
  document.getElementById('view-wildcard').style.display = view === 'wildcard' ? '' : 'none';
  const divGrid = document.getElementById('divisionsGrid');
  if (divGrid) divGrid.style.display = view === 'wildcard' ? 'none' : '';

  // When switching to wild card, collapse any open division
  if (view === 'wildcard' && activeDivisionId !== null) {
    toggleDivision(activeDivisionId); // toggle off
  }
  // When switching back to division, show all cards
  if (view === 'division') {
    document.querySelectorAll('.division-card').forEach(c => c.style.display = '');
  }
}

function renderWildCardTables() {
  const el = document.getElementById('wcTablesContent');
  if (!el || !allData.standings) return;

  const renderLeague = (records, label) => {
    const leagueKey = label === 'AMERICAN LEAGUE' ? 'al' : 'nl';
    let all = []; const divLeaderIds = new Set();
    records.forEach(div => {
      const sorted = div.teamRecords.slice().sort((a,b) => parseFloat(b.winningPercentage) - parseFloat(a.winningPercentage));
      if (sorted[0]) divLeaderIds.add(sorted[0].team.id);
      div.teamRecords.forEach(tr => all.push(tr));
    });
    const divLeaders = all.filter(t => divLeaderIds.has(t.team.id)).sort((a,b) => parseFloat(b.winningPercentage)-parseFloat(a.winningPercentage));
    const rest = all.filter(t => !divLeaderIds.has(t.team.id)).sort((a,b) => parseFloat(b.winningPercentage)-parseFloat(a.winningPercentage));
    const ordered = [...divLeaders, ...rest];
    const wcIds = new Set(ordered.filter(t => !divLeaderIds.has(t.team.id)).slice(0,3).map(t => t.team.id));
    const cutoffIdx = 6; // border-top on 7th row (after 6 playoff spots)
    const wcBubble = rest[2] || rest[rest.length - 1] || null; // WC3 — the last playoff spot, reference for all GB

    let rows = ordered.map((t, i) => {
      const meta = TEAM_META[t.team.id] || { name: t.team.name, abbr:'???' };
      const displayName = meta.name === 'Diamondbacks' ? 'D-Backs' : meta.name;
      const isDivW = divLeaderIds.has(t.team.id);
      const isWC = wcIds.has(t.team.id);
      const isWC3 = isWC && wcBubble && t.team.id === wcBubble.team.id;
      const isElim = t.eliminationNumber === 'E' || t.wildCardEliminationNumber === 'E';
      const rowCls = isElim ? 'wc-elim' : isDivW ? 'wc-div' : isWC ? 'wc-wc' : '';
      const pct = parseFloat(t.winningPercentage||0).toFixed(3).replace(/^0/,'');
      // GB logic:
      // - Div leaders & WC3 (bubble): '—'
      // - WC1/WC2: +games ahead of WC3 (with + prefix)
      // - Outside playoff: GB from WC3 (bubble distance)
      let wcgbStr;
      if (isDivW || isWC3) {
        wcgbStr = '—';
      } else if (isWC && wcBubble) {
        const ahead = ((parseInt(t.wins) - parseInt(wcBubble.wins)) + (parseInt(wcBubble.losses) - parseInt(t.losses))) / 2;
        wcgbStr = ahead <= 0 ? '—' : `+${ahead % 1 === 0 ? ahead : ahead.toFixed(1)}`;
      } else {
        const wcgb = parseFloat(t.wildCardGamesBack);
        wcgbStr = (isNaN(wcgb) || wcgb <= 0) ? '—' : `${wcgb}`;
      }
      const l10 = t.records?.splitRecords?.find(s=>s.type==='lastTen');
      const l10w = l10?.wins ?? 0, l10l = l10?.losses ?? 0;
      const l10color = l10w > l10l ? 'var(--win)' : l10w < l10l ? 'var(--loss)' : 'var(--text)';
      const badge = isDivW
        ? `<span class="badge-div">DIV</span>`
        : isWC ? `<span class="badge-wc">WC</span>` : '';
      // Dashed cutline after 6th team
      const cutlineStyle = i === cutoffIdx ? 'border-top: 2px dashed var(--border);' : '';
      return `<tr class="${rowCls} wc-team-row" id="wcrow-${leagueKey}-${t.team.id}" style="${cutlineStyle}" onclick="toggleWildcardTeamRow('${leagueKey}','${t.team.id}')">
        <td style="width:20px;font-family:'Barlow Condensed';font-weight:700;color:var(--muted);font-size:12px">${i+1}</td>
        <td>
          <div class="team-cell" style="gap:7px">
            <img style="width:22px;height:22px;object-fit:contain" src="https://www.mlbstatic.com/team-logos/${t.team.id}.svg" onerror="this.style.display='none'" alt="">
            <span class="team-name-full" style="font-weight:500;font-size:14px;cursor:pointer;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:2px" onmouseover="this.style.textDecorationColor='var(--accent)'" onmouseout="this.style.textDecorationColor='transparent'" onclick="event.stopPropagation();goToTeam(${t.team.id})">${displayName}</span>
            <span class="team-name-abbr" style="font-weight:600;font-size:14px;cursor:pointer" onclick="event.stopPropagation();goToTeam(${t.team.id})">${meta.abbr}</span>
          </div>
        </td>
        <td class="r">${t.wins}</td>
        <td class="r">${t.losses}</td>
        <td class="r">${pct}</td>
        <td class="r" style="color:${isDivW?'var(--win)':isWC?'var(--accent-blue)':'var(--muted)'}">${wcgbStr}</td>
        <td class="r wc-col-l10"><span style="font-family:'Barlow Condensed';font-weight:700;color:${l10color}">${l10w}-${l10l}</span></td>
        <td>${badge}</td>
      </tr>
      <tr class="wc-team-detail" id="wcnext-${leagueKey}-${t.team.id}">
        <td colspan="8"><div id="wcnext-content-${t.team.id}"><div class="standings-next-wrap"><span class="standings-next-label">NEXT GAME</span><span class="standings-next-meta">Loading...</span></div></div></td>
      </tr>`;
    }).join('');

    return `
      <div class="division-card">
        <div class="division-header">
          <span class="division-name">${label}</span>
          <span class="division-league">PLAYOFF RACE</span>
        </div>
        <table class="wc-table">
          <thead><tr>
            <th style="width:20px">#</th>
            <th>TEAM</th>
            <th class="r">W</th><th class="r">L</th><th class="r">PCT</th>
            <th class="r" style="white-space:nowrap">WCGB</th>
            <th class="r wc-col-l10" style="white-space:nowrap">L10</th>
            <th>STATUS</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  };

  const al = allData.standings.filter(r => r.league?.id === 103);
  const nl = allData.standings.filter(r => r.league?.id === 104);
  el.innerHTML = renderLeague(al, 'AMERICAN LEAGUE') + renderLeague(nl, 'NATIONAL LEAGUE');
  const wcTeamIds = [...new Set([...al, ...nl].flatMap(div => (div.teamRecords || []).map(tr => tr.team.id)))];
  ensureStandingsNextGames(wcTeamIds).then(() => renderWildcardNextGames(wcTeamIds)).catch(()=>{});
}

// ── WILD CARD TRACKER (AL vs NL league-wide PCT) ──────────────────────────
let wcTrackerData = {};
let wcTrackerDates = [];
let wcTrackerLoaded = false;
let wcTrackerHoverIdx = null;
const WC_LEAGUE_COLORS = { 103: '#1565d8', 104: '#e05a2b' };
const WC_LEAGUE_LABELS = { 103: 'AL', 104: 'NL' };

async function initWCTracker() {
  const wrap = document.getElementById('wcTrackerWidget');
  if (!wrap) return;

  const divBtns = ''; // no division pills needed for WC tracker
  wrap.innerHTML = `<div class="tracker-section">
    <div class="tracker-header">
      <span class="tracker-title">WIN% TRACKER — LEAGUE</span>
      <span style="display:flex;align-items:baseline;gap:6px">
        <span class="tracker-date-label" id="wcTrackerDateLabel">—</span>
      </span>
    </div>
    <div style="position:relative;user-select:none">
      <canvas id="wcTrackerCanvas" height="200" style="cursor:crosshair;width:100%;display:block"></canvas>
      <div id="wcTrackerOverlay" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none">
        <span class="tracker-loading" id="wcTrackerLoadingMsg">LOADING…</span>
      </div>
      <div id="wcTrackerTooltip" style="display:none;position:absolute;background:#fff;border:1px solid var(--border);box-shadow:0 4px 16px rgba(0,0,0,.12);padding:10px 14px;pointer-events:none;min-width:140px;z-index:10;font-size:12px"></div>
    </div>
  </div>`;

  const canvas = document.getElementById('wcTrackerCanvas');
  if (canvas) {
    canvas.addEventListener('mousemove', onWCTrackerHover);
    canvas.addEventListener('mouseleave', onWCTrackerLeave);
    canvas.addEventListener('touchstart', onWCTrackerTouch, { passive: true });
    canvas.addEventListener('touchmove', onWCTrackerTouch, { passive: true });
    canvas.addEventListener('touchend', onWCTrackerLeave);
  }

  // Reuse trackerData if already loaded, otherwise wait
  if (trackerLoaded) {
    wcTrackerDates = trackerDates;
    wcTrackerData = trackerData;
    wcTrackerLoaded = true;
    const loadMsg = document.getElementById('wcTrackerLoadingMsg');
    if (loadMsg) loadMsg.style.display = 'none';
    drawWCTracker();
  } else {
    // Poll until division tracker finishes loading
    const poll = setInterval(() => {
      if (trackerLoaded) {
        clearInterval(poll);
        wcTrackerDates = trackerDates;
        wcTrackerData = trackerData;
        wcTrackerLoaded = true;
        const loadMsg = document.getElementById('wcTrackerLoadingMsg');
        if (loadMsg) loadMsg.style.display = 'none';
        drawWCTracker();
      }
    }, 300);
  }
}

function onWCTrackerHover(e) {
  const canvas = document.getElementById('wcTrackerCanvas');
  if (!canvas || !wcTrackerLoaded) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const PAD = { top: 20, right: 50, bottom: 28, left: 50 };
  const W = canvas.offsetWidth;
  const cW = W - PAD.left - PAD.right;
  const relX = mx - PAD.left;
  if (relX < 0 || relX > cW) { onWCTrackerLeave(); return; }
  const idx = Math.round((relX / cW) * Math.max(wcTrackerDates.length - 1, 1));
  const clamped = Math.max(0, Math.min(idx, wcTrackerDates.length - 1));
  if (wcTrackerHoverIdx === clamped) return;
  wcTrackerHoverIdx = clamped;
  drawWCTracker();
  showWCTrackerTooltip(clamped, e.clientX - rect.left, canvas);
}

function onWCTrackerTouch(e) {
  if (e.touches[0]) {
    const canvas = document.getElementById('wcTrackerCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    onWCTrackerHover({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
  }
}

function onWCTrackerLeave() {
  wcTrackerHoverIdx = null;
  const tooltip = document.getElementById('wcTrackerTooltip');
  if (tooltip) tooltip.style.display = 'none';
  drawWCTracker();
}

function showWCTrackerTooltip(idx, mouseX, canvas) {
  const tooltip = document.getElementById('wcTrackerTooltip');
  if (!tooltip) return;
  const date = wcTrackerDates[idx];
  const recs = wcTrackerData[date] || [];
  const d = new Date(date + 'T12:00:00');
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const leagueAvg = (leagueId) => {
    const divs = recs.filter(r => r.league?.id === leagueId);
    let wins = 0, games = 0;
    divs.forEach(div => div.teamRecords.forEach(tr => { wins += tr.wins; games += tr.wins + tr.losses; }));
    return games > 0 ? wins / games : null;
  };

  const rows = [103, 104].map(lid => {
    const avg = leagueAvg(lid);
    if (avg === null) return '';
    const color = WC_LEAGUE_COLORS[lid];
    const label = WC_LEAGUE_LABELS[lid];
    const pct = avg.toFixed(3).replace(/^0/, '');
    return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid #f3f4f6">
      <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <span style="font-family:'Barlow Condensed';font-weight:700;color:${color};width:28px">${label}</span>
      <span style="font-family:'Barlow Condensed';font-weight:700;color:#111827">${pct}</span>
    </div>`;
  }).join('');

  tooltip.innerHTML = `<div style="font-family:'Bebas Neue';font-size:13px;letter-spacing:1.5px;color:#6b7280;margin-bottom:6px">${dateStr}</div>${rows}`;
  tooltip.style.display = 'block';
  const tipW = 160;
  let left = mouseX + 12;
  if (left + tipW > canvas.offsetWidth) left = mouseX - tipW - 12;
  tooltip.style.left = left + 'px';
  tooltip.style.top = '10px';
}

function drawWCTracker() {
  const canvas = document.getElementById('wcTrackerCanvas');
  if (!canvas || !wcTrackerLoaded || !wcTrackerDates.length) return;

  const dateLabel = document.getElementById('wcTrackerDateLabel');
  if (dateLabel) {
    const d = new Date(wcTrackerDates[wcTrackerDates.length - 1] + 'T12:00:00');
    dateLabel.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  const leagueAvgSeries = {};
  [103, 104].forEach(lid => {
    leagueAvgSeries[lid] = wcTrackerDates.map(date => {
      const recs = wcTrackerData[date] || [];
      const divs = recs.filter(r => r.league?.id === lid);
      let wins = 0, games = 0;
      divs.forEach(div => div.teamRecords.forEach(tr => { wins += tr.wins; games += tr.wins + tr.losses; }));
      return games > 0 ? wins / games : null;
    });
  });

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 600;
  const H = 200;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD = { top: 20, right: 50, bottom: 28, left: 50 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  let allVals = [];
  [103,104].forEach(lid => leagueAvgSeries[lid].forEach(v => { if (v != null) allVals.push(v); }));
  if (!allVals.length) return;
  let minPct = Math.max(0, Math.floor(Math.min(...allVals) * 20) / 20 - 0.02);
  let maxPct = Math.min(1, Math.ceil(Math.max(...allVals) * 20) / 20 + 0.02);
  const pctRange = maxPct - minPct || 0.1;

  const yFor = pct => PAD.top + cH - ((pct - minPct) / pctRange) * cH;
  const xFor = i => PAD.left + (i / Math.max(wcTrackerDates.length - 1, 1)) * cW;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.font = '11px Barlow Condensed, sans-serif';
  ctx.textAlign = 'right';
  const step = 0.01;
  for (let p = Math.ceil(minPct * 100) / 100; p <= maxPct + 0.001; p = Math.round((p + step) * 1000) / 1000) {
    const y = yFor(p);
    const is500 = Math.abs(p - 0.5) < 0.001;
    ctx.strokeStyle = is500 ? 'rgba(107,114,128,.4)' : '#f0f0f0';
    ctx.lineWidth = is500 ? 1.5 : 1;
    ctx.setLineDash(is500 ? [4,3] : []);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = is500 ? '#6b7280' : '#c0c0c0';
    ctx.fillText(p.toFixed(3).replace(/^0/,''), PAD.left - 5, y + 3.5);
  }

  // Date labels
  ctx.fillStyle = '#aaa'; ctx.textAlign = 'center';
  const labelStep = Math.max(1, Math.floor(wcTrackerDates.length / 5));
  wcTrackerDates.forEach((date, i) => {
    if (i % labelStep !== 0 && i !== wcTrackerDates.length - 1) return;
    const dd = new Date(date + 'T12:00:00');
    ctx.fillText(dd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), xFor(i), H - 7);
  });

  // Draw lines
  [103, 104].forEach(lid => {
    const vals = leagueAvgSeries[lid];
    const pts = vals.map((v, i) => v != null ? { x: xFor(i), y: yFor(v) } : null).filter(Boolean);
    if (pts.length < 2) return;
    const color = WC_LEAGUE_COLORS[lid];

    // Fill
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const cpx = (pts[i-1].x + pts[i].x) / 2;
      ctx.bezierCurveTo(cpx, pts[i-1].y, cpx, pts[i].y, pts[i].x, pts[i].y);
    }
    ctx.lineTo(pts[pts.length-1].x, PAD.top + cH);
    ctx.lineTo(pts[0].x, PAD.top + cH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
    grad.addColorStop(0, color + '33'); grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad; ctx.fill();

    // Line
    ctx.strokeStyle = color; ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const cpx = (pts[i-1].x + pts[i].x) / 2;
      ctx.bezierCurveTo(cpx, pts[i-1].y, cpx, pts[i].y, pts[i].x, pts[i].y);
    }
    ctx.stroke();

    // End dot
    const last = pts[pts.length-1];
    ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();

    // Label
    ctx.textAlign = 'left';
    ctx.font = 'bold 12px Barlow Condensed, sans-serif';
    ctx.fillStyle = color;
    ctx.fillText(WC_LEAGUE_LABELS[lid], PAD.left + cW + 5, last.y + 4);
  });

  // Hover line
  if (wcTrackerHoverIdx !== null) {
    const hx = xFor(wcTrackerHoverIdx);
    ctx.strokeStyle = 'rgba(107,114,128,.4)'; ctx.lineWidth = 1;
    ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(hx, PAD.top); ctx.lineTo(hx, PAD.top + cH); ctx.stroke();
    ctx.setLineDash([]);
    [103,104].forEach(lid => {
      const v = leagueAvgSeries[lid][wcTrackerHoverIdx];
      if (v == null) return;
      const color = WC_LEAGUE_COLORS[lid];
      ctx.beginPath(); ctx.arc(hx, yFor(v), 4, 0, Math.PI*2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    });
  }
}

const TRACKER_DIVISIONS = {
  200: { name: 'AL West',    league: 103 },
  201: { name: 'AL East',    league: 103 },
  202: { name: 'AL Central', league: 103 },
  203: { name: 'NL West',    league: 104 },
  204: { name: 'NL East',    league: 104 },
  205: { name: 'NL Central', league: 104 },
};

const TEAM_COLORS_TRACKER = {
  108:'#BA0021',109:'#A71930',110:'#DF4601',111:'#BD3039',112:'#0E3386',
  113:'#C6011F',114:'#CC0000',115:'#33006F',116:'#E87722',117:'#EB6E1F',
  118:'#004687',119:'#005A9C',120:'#AB0003',121:'#002D72',133:'#003831',
  134:'#C8A800',135:'#7B5B3A',136:'#0C2C56',137:'#FD5A1E',138:'#C41E3A',
  139:'#092C5C',140:'#003278',141:'#134A8E',142:'#002B5C',143:'#E81828',
  144:'#CE1141',145:'#8A8A8A',146:'#00A3E0',147:'#003087',158:'#12284B',
};

let trackerData = {};
let trackerSchedule = {};
let trackerDates = [];
let trackerCurrentDiv = 201;
let trackerLoaded = false;
let trackerHoverIdx = null;

async function initTracker() {
  const wrap = document.getElementById('trackerWidget');
  if (!wrap) return;

  // Division name for the header
  const divName = TRACKER_DIVISIONS[trackerCurrentDiv]?.name || '';

  wrap.innerHTML = `<div class="tracker-section">
    <div class="tracker-header">
      <span class="tracker-title">WIN% · ${divName}</span>
      <span style="display:flex;align-items:baseline;gap:6px">
        <span class="tracker-date-label" id="trackerDateLabel">—</span>
        <span id="trackerMaxGR"></span>
      </span>
    </div>
    <div style="position:relative;user-select:none;padding:12px">
      <canvas id="trackerCanvas" height="200" style="cursor:crosshair;display:block"></canvas>
      <div id="trackerOverlay" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none">
        <span class="tracker-loading" id="trackerLoadingMsg">LOADING…</span>
      </div>
      <div id="trackerTooltip" style="display:none;position:absolute;background:#fff;border:1px solid var(--border);box-shadow:0 4px 16px rgba(0,0,0,.12);padding:10px 14px;pointer-events:none;min-width:160px;z-index:10;font-size:12px"></div>
    </div>
  </div>`;

  setTimeout(() => {
    const canvas = document.getElementById('trackerCanvas');
    if (canvas) {
      canvas.addEventListener('mousemove', onTrackerHover);
      canvas.addEventListener('mouseleave', onTrackerLeave);
    }
  }, 100);

  // If data already loaded, draw immediately — but reload if it's a new day
  if (trackerLoaded) {
    const todayStr = new Date().toISOString().split('T')[0];
    if (trackerDates[trackerDates.length - 1] !== todayStr) {
      // Day has changed since last load — refresh tracker dates and today's data
      loadTrackerData().catch(e => console.warn('Tracker load failed:', e));
    } else {
      const loadMsg = document.getElementById('trackerLoadingMsg');
      if (loadMsg) loadMsg.style.display = 'none';
      drawTracker(trackerDates.length - 1);
    }
  } else {
    loadTrackerData().catch(e => console.warn('Tracker load failed:', e));
  }
}

async function loadTrackerData() {
  const start = new Date(`${CURRENT_YEAR}-03-25`);
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const todayUTC = new Date(`${todayStr}T00:00:00Z`);
  const dates = [];
  let d = new Date(start);
  while (d <= todayUTC) {
    dates.push(d.toISOString().split('T')[0]);
    d = new Date(d); d.setUTCDate(d.getUTCDate() + 7);
  }
  if (dates[dates.length-1] !== todayStr) dates.push(todayStr);
  trackerDates = dates;

  // Load historical cache — past snapshots never change
  const history = trackerHistoryGet();
  Object.assign(trackerData, history.standings || {});

  // Only fetch dates we don't have yet, plus always refresh today's data
  const todayKey = `mlb_tracker_today_${todayStr}`;
  const todayCached = cacheGet(todayKey);
  const missingDates = dates.filter(date => {
    if (date === todayStr) return !todayCached;
    return !trackerData[date];
  });

  if (missingDates.length > 0) {
    const results = await Promise.all(
      missingDates.map(date =>
        fetchWithTimeout(`${MLB_API}/standings?leagueId=103,104&season=${CURRENT_YEAR}&standingsTypes=regularSeason&hydrate=team,division&date=${date}`)
          .then(r => r.json()).then(data => ({ date, records: data.records || [] })).catch(() => ({ date, records: [] }))
      )
    );

    results.forEach(({date, records}) => { trackerData[date] = records; });

    // Cache today with daily expiry
    cacheSet(todayKey, { standings: trackerData[todayStr] });

    // Save all historical dates permanently (past dates never change)
    const histStandings = {};
    dates.filter(date => date !== todayStr).forEach(date => {
      if (trackerData[date]) histStandings[date] = trackerData[date];
    });
    trackerHistorySet({ standings: histStandings });

  } else if (todayCached) {
    trackerData[todayStr] = todayCached.standings;
  }

  trackerLoaded = true;
  const loadMsg = document.getElementById('trackerLoadingMsg');
  if (loadMsg) loadMsg.style.display = 'none';
  drawTracker(trackerDates.length - 1);
}

function changeTrackerDiv(divId) {
  trackerCurrentDiv = parseInt(divId);
  trackerHoverIdx = null;
  // Update active pill
  document.querySelectorAll('.tracker-div-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.divid) === trackerCurrentDiv);
  });
  drawTracker(trackerDates.length - 1);
}

function onTrackerHover(e) {
  const canvas = document.getElementById('trackerCanvas');
  if (!canvas || !trackerLoaded) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const visibleDates = trackerDates;
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight || 240;
  const PAD = trackerChartPadding(W, H);
  const cW = W - PAD.left - PAD.right;
  const relX = mx - PAD.left;
  if (relX < 0 || relX > cW) { onTrackerLeave(); return; }
  const idx = Math.round((relX / cW) * Math.max(visibleDates.length - 1, 1));
  const clampedIdx = Math.max(0, Math.min(idx, visibleDates.length - 1));
  if (trackerHoverIdx === clampedIdx) return;
  trackerHoverIdx = clampedIdx;
  drawTracker(trackerDates.length - 1);
  showTrackerTooltip(clampedIdx, visibleDates, e.clientX - rect.left, canvas);
}

function onTrackerLeave() {
  trackerHoverIdx = null;
  const tooltip = document.getElementById('trackerTooltip');
  if (tooltip) tooltip.style.display = 'none';
  drawTracker(trackerDates.length - 1);
}

function showTrackerTooltip(idx, visibleDates, mouseX, canvas) {
  const tooltip = document.getElementById('trackerTooltip');
  if (!tooltip) return;
  const date = visibleDates[idx];
  const recs = trackerData[date] || [];
  const dr = recs.find(r => r.division?.id === trackerCurrentDiv);
  if (!dr) return;

  const sorted = [...dr.teamRecords].sort((a,b) => b.wins - a.wins);
  const d = new Date(date + 'T12:00:00');
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  let rows = sorted.map(tr => {
    const tid = tr.team.id;
    const meta = TEAM_META[tid] || { abbr: '???' };
    const color = TEAM_COLORS_TRACKER[tid] || '#999';
    const pct = parseFloat(tr.winningPercentage || 0).toFixed(3).replace(/^0/, '');
    return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid #f3f4f6">
      <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <span style="font-family:'Barlow Condensed';font-weight:700;color:${color};width:28px">${meta.abbr}</span>
      <span style="font-family:'Barlow Condensed';color:#6b7280;width:40px">${tr.wins}-${tr.losses}</span>
      <span style="font-family:'Barlow Condensed';font-weight:700;color:#111827">${pct}</span>
    </div>`;
  }).join('');

  tooltip.innerHTML = `
    <div style="font-family:'Bebas Neue';font-size:13px;letter-spacing:1.5px;color:#6b7280;margin-bottom:6px">${dateStr}</div>
    ${rows}`;
  tooltip.style.display = 'block';

  const tipW = 240;
  let left = mouseX + 12;
  if (left + tipW > canvas.offsetWidth) left = mouseX - tipW - 12;
  tooltip.style.left = left + 'px';
  tooltip.style.top = '10px';
}

let _hoverDiv = null;

// Games over .500 (W−L) is the division charts' y-axis: everyone starts at zero
// on opening day and the field fans out as the season goes on, instead of win%
// swinging wildly in April and collapsing into a tight band by August.
function winLossRange(values) {
  let min = -5, max = 5; // floor keeps opening week from looking like a seismograph
  values.forEach(v => { min = Math.min(min, v); max = Math.max(max, v); });
  const step = (max - min) <= 25 ? 5 : (max - min) <= 60 ? 10 : 15;
  return {
    min: Math.floor((min - 1) / step) * step,
    max: Math.ceil((max + 1) / step) * step,
    step
  };
}

function winLossLabel(v) {
  return v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0';
}

function divisionWinLossPadding(W, H) {
  return { top: 12, right: 54, bottom: H < 190 ? 18 : 24, left: 42 };
}

function drawDivisionWinLossTracker(divId, canvasEl, chartH) {
  const canvas = canvasEl;
  divId = parseInt(divId);
  if (!canvas || !trackerLoaded || !trackerDates.length) return;

  const visibleDates = _divVisibleDates(divId);
  if (!visibleDates.length) return;
  const latestDate = [...visibleDates].reverse().find(date => {
    const dr = (trackerData[date] || []).find(r => r.division?.id === divId);
    return !!dr?.teamRecords?.length;
  });
  const latestRec = (trackerData[latestDate] || []).find(r => r.division?.id === divId);
  if (!latestRec?.teamRecords?.length) return;

  const divTeams = latestRec.teamRecords
    .map(t => t.team.id)
    .sort((a, b) => {
      const ar = latestRec.teamRecords.find(t => t.team.id === a);
      const br = latestRec.teamRecords.find(t => t.team.id === b);
      return ((br?.wins - br?.losses) || 0) - ((ar?.wins - ar?.losses) || 0);
    });

  const series = {};
  divTeams.forEach(id => { series[id] = []; });
  visibleDates.forEach(date => {
    const dr = (trackerData[date] || []).find(r => r.division?.id === divId);
    const seen = new Set();
    if (dr?.teamRecords?.length) {
      dr.teamRecords.forEach(tr => {
        if (!series[tr.team.id]) return;
        series[tr.team.id].push(tr.wins - tr.losses);
        seen.add(tr.team.id);
      });
    }
    divTeams.forEach(id => { if (!seen.has(id)) series[id].push(null); });
  });

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 600;
  const H = chartH || canvas.offsetHeight || 220;
  if (W < 120 || H < 120) return;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD = divisionWinLossPadding(W, H);
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  if (cW <= 0 || cH <= 0) return;

  const flat = [];
  Object.values(series).forEach(vals => vals.forEach(v => {
    if (v !== null && Number.isFinite(v)) flat.push(v);
  }));
  const { min: minWL, max: maxWL, step: gridStep } = winLossRange(flat);
  const wlRange = Math.max(maxWL - minWL, 1);

  const yFor = v => PAD.top + cH - ((v - minWL) / wlRange) * cH;
  const xFor = (i, total) => PAD.left + (i / Math.max(total - 1, 1)) * cW;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  ctx.font = '11px Barlow Condensed, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const startGrid = Math.ceil(minWL / gridStep) * gridStep;
  for (let p = startGrid; p <= maxWL + 0.001; p += gridStep) {
    p = Math.round(p);
    const y = yFor(p);
    const isEven = p === 0; // the old .500 line — now the break-even line
    ctx.strokeStyle = isEven ? 'rgba(107,114,128,.5)' : '#e5e7eb';
    ctx.lineWidth = isEven ? 1.5 : 1;
    ctx.setLineDash(isEven ? [5, 4] : []);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = isEven ? '#4b5563' : '#9ca3af';
    ctx.fillText(winLossLabel(p), PAD.left - 6, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#6b7280';
  const labelStep = Math.max(1, Math.floor(visibleDates.length / (W < 560 ? 3 : 4)));
  const lastIdx = visibleDates.length - 1;
  visibleDates.forEach((date, i) => {
    // Today's label always shows; drop any periodic one that would crowd it.
    if (i !== lastIdx && (i % labelStep !== 0 || lastIdx - i < labelStep / 2)) return;
    const x = xFor(i, visibleDates.length);
    const dd = new Date(date + 'T12:00:00');
    ctx.fillText(dd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), x, H - 6);
  });

  function buildPath(vals, total) {
    const pts = [];
    vals.forEach((v, i) => {
      if (v !== null && Number.isFinite(v)) pts.push({ x: xFor(i, total), y: yFor(v), i });
    });
    return pts;
  }
  function drawSmoothPath(pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1], curr = pts[i];
      const cpx = (prev.x + curr.x) / 2;
      ctx.bezierCurveTo(cpx, prev.y, cpx, curr.y, curr.x, curr.y);
    }
  }

  const currentWL = {};
  divTeams.forEach(id => {
    const last = [...series[id]].reverse().find(v => v !== null && Number.isFinite(v));
    currentWL[id] = last ?? 0;
  });
  const bottomFirst = [...divTeams].sort((a, b) => currentWL[a] - currentWL[b]);
  bottomFirst.forEach(tid => {
    const pts = buildPath(series[tid], visibleDates.length);
    if (pts.length < 2) return;
    const color = TEAM_COLORS_TRACKER[tid] || '#999';
    const isTop = currentWL[tid] === Math.max(...Object.values(currentWL));
    ctx.strokeStyle = color;
    ctx.lineWidth = isTop ? 2.7 : 2;
    ctx.globalAlpha = isTop ? 1 : 0.9;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); drawSmoothPath(pts); ctx.stroke();
    ctx.globalAlpha = 1;
  });

  if (trackerHoverIdx !== null && trackerHoverIdx < visibleDates.length) {
    const hx = xFor(trackerHoverIdx, visibleDates.length);
    ctx.strokeStyle = 'rgba(17,24,39,.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(hx, PAD.top); ctx.lineTo(hx, PAD.top + cH); ctx.stroke();
    ctx.setLineDash([]);
    divTeams.forEach(tid => {
      const v = series[tid][trackerHoverIdx];
      if (v === null || !Number.isFinite(v)) return;
      const color = TEAM_COLORS_TRACKER[tid] || '#999';
      ctx.beginPath(); ctx.arc(hx, yFor(v), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    });
  }

  const labelTeams = [...divTeams].sort((a, b) => currentWL[b] - currentWL[a]);
  const labelY = labelTeams.map(tid => yFor(currentWL[tid]));
  const minGap = 12;
  for (let i = 1; i < labelY.length; i++) {
    if (labelY[i] - labelY[i - 1] < minGap) labelY[i] = labelY[i - 1] + minGap;
  }
  for (let i = labelY.length - 2; i >= 0; i--) {
    if (labelY[i + 1] > PAD.top + cH && labelY[i] > PAD.top) {
      labelY[i] -= labelY[i + 1] - (PAD.top + cH);
    }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  labelTeams.forEach((tid, i) => {
    const vals = series[tid];
    const lastIdx = vals.map(v => v !== null && Number.isFinite(v)).lastIndexOf(true);
    if (lastIdx < 0) return;
    const color = TEAM_COLORS_TRACKER[tid] || '#999';
    const x = xFor(lastIdx, visibleDates.length);
    const y = yFor(vals[lastIdx]);
    ctx.beginPath(); ctx.arc(x, y, currentWL[tid] === Math.max(...Object.values(currentWL)) ? 4 : 3.2, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4; ctx.stroke();
    const meta = TEAM_META[tid] || { abbr: '???' };
    ctx.font = 'bold 11px Barlow Condensed, sans-serif';
    ctx.fillStyle = color;
    ctx.fillText(meta.abbr, PAD.left + cW + 6, Math.min(PAD.top + cH, Math.max(PAD.top, labelY[i])));
  });
}

function trackerChartPadding(W, H, opts = {}) {
  const compact = !!opts.divisionChart || W < 560 || H < 260;
  return {
    top: compact ? 14 : 20,
    right: opts.showTeamLabels === false ? 16 : (compact ? 46 : 58),
    bottom: opts.showXAxis === false ? (compact ? 10 : 12) : (compact ? 24 : 28),
    left: compact ? 42 : 50
  };
}

function drawTracker(sliderIdx, divId, canvasEl, chartH, opts) {
  const canvas = canvasEl || document.getElementById('trackerCanvas');
  divId = divId || trackerCurrentDiv;
  opts = opts || {};
  if (!canvas || !trackerLoaded || !trackerDates.length) return;

  const wl = !!opts.divisionChart; // division charts plot games over .500, not win%
  const visibleDates = opts.startDate ? trackerDates.filter(d => d >= opts.startDate) : trackerDates;
  if (!visibleDates.length) return;
  const lastIdx = trackerDates.length - 1;
  const dateLabel = document.getElementById('trackerDateLabel');
  if (dateLabel) {
    const d = new Date(visibleDates[visibleDates.length - 1] + 'T12:00:00');
    dateLabel.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  const latestRec = trackerData[trackerDates[lastIdx]] || [];
  const divRec = latestRec.find(r => r.division?.id === divId);
  if (!divRec) return;
  const divTeams = divRec.teamRecords.map(t => t.team.id);

  const series = {};
  divTeams.forEach(id => series[id] = []);
  visibleDates.forEach(date => {
    const recs = trackerData[date] || [];
    const dr = recs.find(r => r.division?.id === divId);
    const seen = new Set();
    if (dr) {
      dr.teamRecords.forEach(tr => {
        if (series[tr.team.id]) {
          series[tr.team.id].push(wl ? tr.wins - tr.losses : (parseFloat(tr.winningPercentage) || 0));
          seen.add(tr.team.id);
        }
      });
    }
    divTeams.forEach(id => { if (!seen.has(id)) series[id].push(null); });
  });

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 600;
  const H = chartH || canvas.offsetHeight || 240;
  if (W < 120 || H < 120) return;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD = trackerChartPadding(W, H, opts);
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  if (cW <= 0 || cH <= 0) return;

  let minY, maxY, gridStep;
  if (wl) {
    const flat = [];
    Object.values(series).forEach(arr => arr.forEach(v => { if (v != null) flat.push(v); }));
    ({ min: minY, max: maxY, step: gridStep } = winLossRange(flat));
  } else {
    minY = .350; maxY = .750;
    Object.values(series).forEach(arr => arr.forEach(v => {
      if (v != null) { minY = Math.min(minY, v); maxY = Math.max(maxY, v); }
    }));
    minY = Math.max(0, Math.floor(minY * 10) / 10 - 0.05);
    maxY = Math.min(1, Math.ceil(maxY * 10) / 10 + 0.05);
    gridStep = 0.1;
  }
  const yRange = Math.max(maxY - minY, wl ? 1 : 0.1);

  const yFor = v => PAD.top + cH - ((v - minY) / yRange) * cH;
  const xFor = (i, total) => PAD.left + (i / Math.max(total - 1, 1)) * cW;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const compact = !!opts.divisionChart || W < 560 || H < 260;
  ctx.font = `${compact ? 11 : 12}px Barlow Condensed, sans-serif`;
  ctx.textAlign = 'right';
  const gridVals = [];
  if (wl) {
    for (let p = Math.ceil(minY / gridStep) * gridStep; p <= maxY + 0.001; p += gridStep) gridVals.push(Math.round(p));
  } else {
    for (let p = Math.ceil(minY * 10) / 10; p <= maxY + 0.001; p = Math.round((p + 0.1) * 10) / 10) gridVals.push(p);
  }
  gridVals.forEach(p => {
    const y = yFor(p);
    const isBase = wl ? p === 0 : Math.abs(p - 0.5) < 0.001;
    ctx.strokeStyle = isBase ? 'rgba(107,114,128,.45)' : '#e5e7eb';
    ctx.lineWidth = isBase ? 1.5 : 1;
    ctx.setLineDash(isBase ? [4,3] : []);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = isBase ? '#4b5563' : '#9ca3af';
    ctx.fillText(wl ? winLossLabel(p) : p.toFixed(3).replace(/^0/,''), PAD.left - 5, y + 3.5);
  });

  if (opts.showXAxis !== false) {
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    const labelStep = Math.max(1, Math.floor(visibleDates.length / 5));
    const lastLabelIdx = visibleDates.length - 1;
    visibleDates.forEach((date, i) => {
      // Today's label always shows; drop any periodic one that would crowd it.
      if (i !== lastLabelIdx && (i % labelStep !== 0 || lastLabelIdx - i < labelStep / 2)) return;
      const x = xFor(i, visibleDates.length);
      const dd = new Date(date + 'T12:00:00');
      ctx.fillText(dd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), x, H - 7);
    });
  }

  const currentVals = {};
  divTeams.forEach(id => {
    const arr = series[id];
    const last = [...arr].reverse().find(v => v != null);
    currentVals[id] = last ?? null;
  });
  const sortedTeams = [...divTeams].sort((a,b) => currentVals[b] - currentVals[a]);

  function buildPath(vals, total) {
    const pts = [];
    vals.forEach((v, i) => { if (v != null) pts.push({ x: xFor(i, total), y: yFor(v), i }); });
    return pts;
  }
  function drawSmooth(ctx, pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i-1], curr = pts[i];
      const cpx = (prev.x + curr.x) / 2;
      ctx.bezierCurveTo(cpx, prev.y, cpx, curr.y, curr.x, curr.y);
    }
  }

  sortedTeams.forEach((tid) => {
    const vals = series[tid];
    const pts = buildPath(vals, visibleDates.length);
    if (pts.length < 2) return;
    const color = TEAM_COLORS_TRACKER[tid] || '#999';

    ctx.beginPath();
    drawSmooth(ctx, pts);
    ctx.lineTo(pts[pts.length-1].x, PAD.top + cH);
    ctx.lineTo(pts[0].x, PAD.top + cH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
    grad.addColorStop(0, color + '22');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.fill();
  });

  sortedTeams.forEach((tid, rank) => {
    const vals = series[tid];
    const pts = buildPath(vals, visibleDates.length);
    if (!pts.length) return;
    const color = TEAM_COLORS_TRACKER[tid] || '#999';
    const isTop = rank === 0;

    ctx.strokeStyle = color;
    ctx.lineWidth = isTop ? (compact ? 2.8 : 2.6) : (compact ? 2 : 1.8);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    drawSmooth(ctx, pts);
    ctx.stroke();

    const lastPt = pts[pts.length-1];
    ctx.beginPath(); ctx.arc(lastPt.x, lastPt.y, isTop ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  });

  if (trackerHoverIdx !== null && trackerHoverIdx < visibleDates.length) {
    const hx = xFor(trackerHoverIdx, visibleDates.length);
    ctx.strokeStyle = 'rgba(107,114,128,.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(hx, PAD.top); ctx.lineTo(hx, PAD.top + cH); ctx.stroke();
    ctx.setLineDash([]);

    sortedTeams.forEach(tid => {
      const v = series[tid][trackerHoverIdx];
      if (v == null) return;
      const color = TEAM_COLORS_TRACKER[tid] || '#999';
      ctx.beginPath(); ctx.arc(hx, yFor(v), 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    });
  }

  ctx.textAlign = 'left';
  const labelY = sortedTeams.map(tid => {
    const v = currentVals[tid];
    return v == null ? null : yFor(v); // 0 is a real value in W−L (even record)
  });
  const minGap = compact ? 12 : 13;
  for (let i = 1; i < labelY.length; i++) {
    if (labelY[i] !== null && labelY[i-1] !== null && labelY[i] - labelY[i-1] < minGap) {
      labelY[i] = labelY[i-1] + minGap;
    }
  }
  sortedTeams.forEach((tid, i) => {
    if (labelY[i] === null) return;
    const meta = TEAM_META[tid] || { abbr: '???' };
    ctx.font = `bold ${compact ? 11 : 12}px Barlow Condensed, sans-serif`;
    ctx.fillStyle = TEAM_COLORS_TRACKER[tid] || '#999';
    ctx.fillText(meta.abbr, PAD.left + cW + 5, labelY[i] + 4);
  });
}

async function loadBracket() {
  const el = document.getElementById('bracketContent');
  try {
    if (!isPlayoffSeason) {
      el.innerHTML = renderProjectedBracket();
      return;
    }
    el.innerHTML = renderPlayoffBracket(allData.playoffs);
  } catch(e) {
    el.innerHTML = errorStateHTML('loadBracket()');
  }
}

function renderProjectedBracket() {
  if (!allData.standings) return '<div class="error-box">No data available.</div>';

  const getSeeds = (records) => {
    let all = []; const divLeaderIds = new Set();
    records.forEach(div => {
      const sorted = div.teamRecords.slice().sort((a,b) => {
        const pa = parseFloat(a.winningPercentage)||0, pb = parseFloat(b.winningPercentage)||0;
        return pb - pa;
      });
      if (sorted[0]) divLeaderIds.add(sorted[0].team.id);
      div.teamRecords.forEach(tr => all.push(tr));
    });
    const divLeaders = all
      .filter(t => divLeaderIds.has(t.team.id))
      .sort((a,b) => parseFloat(b.winningPercentage) - parseFloat(a.winningPercentage))
      .slice(0,3);
    const wc = all
      .filter(t => !divLeaderIds.has(t.team.id))
      .sort((a,b) => parseFloat(b.winningPercentage) - parseFloat(a.winningPercentage))
      .slice(0,3);
    return [...divLeaders, ...wc];
  };

  const al = allData.standings.filter(r => r.league?.id === 103);
  const nl = allData.standings.filter(r => r.league?.id === 104);

  const renderBracket = (seeds, leagueLabel) => {
    const seedCard = (t, seed) => {
      if (!t) return `<div style="display:flex;align-items:center;gap:5px;padding:5px 8px;background:var(--surface2);border-radius:4px;opacity:.55"><span style="font-family:'Barlow Condensed';font-weight:800;font-size:11px;color:var(--muted);width:14px">${seed}</span><span style="font-family:'Barlow Condensed';font-size:12px;color:var(--muted)">TBD</span></div>`;
      const meta = TEAM_META[t.team.id] || { name: t.team.name, abbr: t.team.abbreviation||'???' };
      const abbr = meta.abbr || meta.name.slice(0,3).toUpperCase();
      const isDivW = typeof seed === 'number' && seed <= 3;
      const badge = isDivW
        ? `<span style="font-size:8px;font-weight:700;padding:1px 3px;background:rgba(22,163,74,.12);color:var(--win);border-radius:2px">D</span>`
        : `<span style="font-size:8px;font-weight:700;padding:1px 3px;background:rgba(21,101,216,.1);color:var(--accent);border-radius:2px">WC</span>`;
      return `<div style="display:flex;align-items:center;gap:5px;padding:5px 8px;background:var(--bg);border-radius:4px;">
        <span style="font-family:'Barlow Condensed';font-weight:800;font-size:11px;color:var(--muted);width:14px">${seed}</span>
        <img src="https://www.mlbstatic.com/team-logos/${t.team.id}.svg" style="width:18px;height:18px;object-fit:contain" onerror="this.style.display='none'" alt="">
        <span style="font-family:'Barlow Condensed';font-weight:700;font-size:13px;flex:1">${abbr}</span>
        <span style="font-size:10px;color:var(--muted)">${t.wins}-${t.losses}</span>
        ${badge}
      </div>`;
    };
    const vs = `<div style="font-family:'Barlow Condensed';font-size:9px;color:var(--muted);text-align:center;padding:1px 0">VS</div>`;
    const box = (a, sa, b, sb) => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:5px;overflow:hidden;margin-bottom:6px">${seedCard(a,sa)}${vs}${seedCard(b,sb)}</div>`;
    const tbdBox = (label) => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:10px;text-align:center;color:var(--muted);font-family:'Barlow Condensed';font-size:11px;letter-spacing:1px">${label}</div>`;
    const colHdr = (t) => `<div style="font-family:'Barlow Condensed';font-size:9px;letter-spacing:2px;color:var(--muted);font-weight:700;margin-bottom:8px;text-align:center">${t}</div>`;

    const [s1,s2,s3,s4,s5,s6] = seeds;
    return `
      <div style="margin-bottom:16px">
        <div style="font-family:'Bebas Neue';font-size:15px;letter-spacing:3px;color:var(--accent);margin-bottom:8px">${leagueLabel}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;background:var(--surface2);border:1px solid var(--border);padding:10px;border-radius:7px">
          <div>
            ${colHdr('WILD CARD')}
            ${box(s3,3,s6,6)}
            ${box(s4,4,s5,5)}
          </div>
          <div>
            ${colHdr('DIV SERIES')}
            ${box(s1,1,null,'WC')}
            ${box(s2,2,null,'WC')}
          </div>
          <div>
            ${colHdr('CHAMP. SERIES')}
            ${tbdBox('DS Winner vs DS Winner')}
          </div>
        </div>
      </div>`;
  };

  const alSeeds = getSeeds(al);
  const nlSeeds = getSeeds(nl);

  const wsLogoCard = (seeds, label) => {
    if (!seeds || !seeds[0]) return `<div style="text-align:center;color:var(--muted);font-family:'Barlow Condensed';font-size:13px;padding:12px">TBD</div>`;
    const meta = TEAM_META[seeds[0].team.id] || { abbr:'?' };
    return `<div style="text-align:center;padding:10px">
      <img src="https://www.mlbstatic.com/team-logos/${seeds[0].team.id}.svg" style="width:40px;height:40px;object-fit:contain;opacity:.4" onerror="this.style.display='none'">
      <div style="font-family:'Barlow Condensed';font-weight:700;font-size:13px;color:var(--muted);margin-top:4px">${meta.abbr}?</div>
      <div style="font-size:9px;letter-spacing:1px;color:var(--muted);font-family:'Barlow Condensed'">${label}</div>
    </div>`;
  };

  const wcTable = (records, label) => {
    let all = []; const divLeaderIds = new Set();
    records.forEach(div => {
      const sorted = div.teamRecords.slice().sort((a,b) => parseFloat(b.winningPercentage) - parseFloat(a.winningPercentage));
      if (sorted[0]) divLeaderIds.add(sorted[0].team.id);
      div.teamRecords.forEach(tr => all.push(tr));
    });
    const divLeaders = all.filter(t => divLeaderIds.has(t.team.id)).sort((a,b) => parseFloat(b.winningPercentage)-parseFloat(a.winningPercentage));
    const rest = all.filter(t => !divLeaderIds.has(t.team.id)).sort((a,b) => parseFloat(b.winningPercentage)-parseFloat(a.winningPercentage));
    const ordered = [...divLeaders, ...rest];
    const wcIds = new Set(ordered.slice(3,6).map(t => t.team.id));
    let rows = '';
    ordered.forEach((t, i) => {
      const meta = TEAM_META[t.team.id] || { name: t.team.name, abbr:'???' };
      const displayName = meta.name === 'Diamondbacks' ? 'D-Backs' : meta.name;
      const isDivW = divLeaderIds.has(t.team.id);
      const isWC = wcIds.has(t.team.id);
      const isElim = t.eliminationNumber === 'E' || t.wildCardEliminationNumber === 'E';
      const rc = isElim ? 'xr' : isDivW ? 'dr' : isWC ? 'wr' : '';
      const pct = parseFloat(t.winningPercentage||0).toFixed(3).replace(/^0/,'');
      const wcgb = parseFloat(t.wildCardGamesBack);
      let wcgbStr;
      if (isNaN(wcgb) || wcgb < 0) { wcgbStr = (isDivW || isWC) ? '—' : '—'; }
      else if (wcgb === 0) { wcgbStr = '—'; }
      else { wcgbStr = `${wcgb}`; }
      const l10 = t.records?.splitRecords?.find(s=>s.type==='lastTen');
      const l10w = l10?.wins ?? 0, l10l = l10?.losses ?? 0;
      const l10color = l10w > l10l ? 'var(--win)' : l10w < l10l ? 'var(--loss)' : 'var(--text)';
      const badge = isDivW ? '<span class="badge-div">DIV</span>' : isWC ? '<span class="badge-wc">WC</span>' : '';
      rows += `<tr class="${rc}">
        <td style="width:28px;font-family:'Barlow Condensed';font-weight:700;color:var(--muted);font-size:13px">${i+1}</td>
        <td><div class="team-cell" style="gap:7px">
          <img style="width:22px;height:22px;object-fit:contain" src="https://www.mlbstatic.com/team-logos/${t.team.id}.svg" onerror="this.style.display='none'" alt="">
          <span style="font-weight:500;font-size:14px">${displayName}</span>
        </div></td>
        <td class="num">${t.wins}</td><td class="num">${t.losses}</td>
        <td class="num pct">${pct}</td>
        <td class="num" style="color:${isWC||isDivW?'var(--win)':'var(--muted)'}">${wcgbStr}</td>
        <td class="num"><span style="font-family:'Barlow Condensed';font-weight:700;color:${l10color};white-space:nowrap">${l10w}-${l10l}</span></td>
        <td>${badge}</td>
      </tr>`;
    });
    return `
      <div class="section-title" style="margin-top:32px">${label} — WILD CARD RACE</div>
      <table class="standings-table" style="margin-bottom:8px">
        <thead><tr>
          <th style="width:28px">#</th><th>TEAM</th>
          <th class="num">W</th><th class="num">L</th><th class="num">PCT</th>
          <th class="num" style="white-space:nowrap">WC GB</th><th class="num" style="white-space:nowrap">L10</th><th>STATUS</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  };

  return `
    <div class="section-title">PROJECTED PLAYOFF BRACKET</div>
    <div style="margin-bottom:20px">
      <div class="section-title" style="font-size:16px;margin-bottom:8px">🏆 WORLD SERIES</div>
      <div style="display:grid;grid-template-columns:1fr 48px 1fr;gap:0;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;box-shadow:0 2px 8px rgba(0,0,0,.06)">
        ${wsLogoCard(alSeeds,'AL CHAMPION')}
        <div style="text-align:center;font-family:'Bebas Neue';font-size:20px;color:var(--accent)">VS</div>
        ${wsLogoCard(nlSeeds,'NL CHAMPION')}
      </div>
    </div>
    ${renderBracket(alSeeds, 'AMERICAN LEAGUE')}
    ${renderBracket(nlSeeds, 'NATIONAL LEAGUE')}
    ${wcTable(al, 'AMERICAN LEAGUE')}
    ${wcTable(nl, 'NATIONAL LEAGUE')}`;
}

function renderPlayoffBracket(data) {
  if (!data || !data.series) return '<div class="error-box">No playoff data found.</div>';

  const rounds = {};
  data.series.forEach(s => {
    const round = s.series.round || 'Unknown';
    if (!rounds[round]) rounds[round] = [];
    rounds[round].push(s);
  });

  const roundOrder = ['WC', 'DS', 'CS', 'WS'];
  const roundNames = { WC: 'WILD CARD', DS: 'DIVISION SERIES', CS: 'CHAMPIONSHIP SERIES', WS: 'WORLD SERIES' };

  let html = `<div class="section-title">PLAYOFF BRACKET</div>`;

  for (const rk of roundOrder) {
    if (!rounds[rk]) continue;
    html += `<div class="section-title" style="font-size:16px; margin-top:24px">${roundNames[rk]||rk}</div>`;
    html += `<div class="bracket-grid">`;
    rounds[rk].forEach(s => {
      const teams = (s.series && s.series.teams) || [];
      html += `<div class="series-card">
        <div class="series-round">${s.series.description || rk}</div>
        <div class="series-matchup">`;
      teams.forEach(t => {
        if (!t || !t.team) return;
        const meta = TEAM_META[t.team.id] || { name: t.team.name, abbr:'?', logo:'' };
        const isWinner = t.isWinner;
        const isElim = !isWinner && t.wins !== undefined && s.series.isOver;
        html += `
          <div class="series-team ${isWinner ? 'winner' : isElim ? 'eliminated' : ''}">
            <div class="series-team-info">
              <img class="series-logo" src="${meta.logo}" alt="${meta.abbr}" onerror="this.style.display='none'">
              <div>
                <div class="series-name">${meta.name}</div>
                <div class="series-record">${t.wins||0} wins</div>
              </div>
            </div>
            <div class="series-wins ${isWinner ? 'w' : ''}">${t.wins||0}</div>
          </div>`;
      });
      html += `</div></div>`;
    });
    html += `</div>`;
  }
  return html;
}

async function loadSchedule() {
  const el = document.getElementById('scheduleContent');
  try {
    let url;
    if (isPlayoffSeason) {
      url = `${MLB_API}/schedule?sportId=1&season=${CURRENT_YEAR}&gameType=F,D,L,W&hydrate=team,linescore&sortBy=gameDate`;
    } else {
      const today = new Date().toISOString().split('T')[0];
      const end = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];
      url = `${MLB_API}/schedule?sportId=1&startDate=${today}&endDate=${end}&gameType=R&hydrate=team,linescore`;
    }
    const res = await fetch(url);
    const data = await res.json();
    allData.schedule = data.dates || [];

    const games = [];
    (data.dates||[]).forEach(d => {
      (d.games||[]).forEach(g => {
        const away = g.teams.away.team.id;
        const home = g.teams.home.team.id;
        if (isPlayoffSeason || playoffTeamIds.size === 0 || playoffTeamIds.has(away) || playoffTeamIds.has(home)) {
          games.push(g);
        }
      });
    });

    if (!games.length) {
      el.innerHTML = '<div class="error-box">No upcoming games found for playoff contenders.</div>';
      return;
    }

    let html = `<div class="section-title">${isPlayoffSeason ? 'PLAYOFF SCHEDULE' : 'UPCOMING — PLAYOFF CONTENDERS'}</div>`;
    html += `<div class="schedule-list">`;

    games.slice(0,50).forEach(g => {
      const awayMeta = TEAM_META[g.teams.away.team.id] || { name: g.teams.away.team.name, abbr:'???', logo:'' };
      const homeMeta = TEAM_META[g.teams.home.team.id] || { name: g.teams.home.team.name, abbr:'???', logo:'' };
      const status = g.status.abstractGameState;
      const gdate = new Date(g.gameDate);
      const dateStr = gdate.toLocaleDateString('en-US', { month:'short', day:'numeric' });
      const timeStr = gdate.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });

      let awayScore = '', homeScore = '', statusHtml = '';
      if (status === 'Final') {
        awayScore = g.teams.away.score ?? '';
        homeScore = g.teams.home.score ?? '';
        statusHtml = `<div class="game-status final">FINAL</div>`;
      } else if (status === 'Live') {
        awayScore = g.teams.away.score ?? '';
        homeScore = g.teams.home.score ?? '';
        const inn = g.linescore ? `${g.linescore.currentInningOrdinal||''}` : 'LIVE';
        statusHtml = `<div class="game-status live">${inn}</div>`;
      } else {
        awayScore = '—';
        homeScore = '—';
        statusHtml = `<div class="game-status upcoming">${timeStr}</div>`;
      }

      html += `
        <div class="game-row">
          <div class="game-date">${dateStr}</div>
          <div class="game-team">
            <img class="game-team-logo" src="${awayMeta.logo}" alt="${awayMeta.abbr}" onerror="this.style.display='none'">
            <div class="game-team-name">${awayMeta.abbr}</div>
          </div>
          <div class="game-score">${awayScore} – ${homeScore}</div>
          <div class="game-team">
            <img class="game-team-logo" src="${homeMeta.logo}" alt="${homeMeta.abbr}" onerror="this.style.display='none'">
            <div class="game-team-name">${homeMeta.abbr}</div>
          </div>
          <div class="game-info">${statusHtml}<div style="font-size:11px;color:var(--muted);margin-top:2px">${g.venue ? g.venue.name||'' : ''}</div></div>
        </div>`;
    });

    html += `</div>`;
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = errorStateHTML('loadSchedule()');
  }
}

let teamsImpactCache = {};
let selectedTeamId = null;
let selectedDiamondKey = null;

function getDiamondPlayerColor(value, type) {
  if (type === 'hitter') {
    if (!value || value <= 0) return '#9ca3af';
    if (value >= 0.900) return '#16a34a';   // verde: elite
    if (value >= 0.750) return '#b1c882';   // verde claro
    if (value >= 0.600) return '#ffc000';   // amarillo
    if (value >= 0.450) return '#ff8100';   // naranja
    return '#ff2200';                        // rojo
  } else {
    // FORMA 0-100. Media MLB ≈ 51. ≥75 élite, ≥60 bueno, ≥40 medio, <40 malo
    if (value == null || value < 0) return '#9ca3af';
    if (value >= 75) return '#16a34a';   // verde: elite
    if (value >= 60) return '#b1c882';   // verde claro
    if (value >= 40) return '#ffc000';   // amarillo
    if (value >= 25) return '#ff8100';   // naranja
    return '#ff2200';                     // rojo
  }
}

function diamondTextColor(bg) {
  return ['#16a34a', '#ff2200', '#ff8100'].includes(bg) ? '#fff' : '#1a1209';
}

// ── "Shiny" historic-season flag ──────────────────────────────────────────
// True only for a genuinely historic, qualified season — strict & conservative
// so it lights up rarely (0–3 players league-wide). Hitters: OPS ≥ 1.000.
// Pitchers: ERA ≤ 2.00 AND WHIP ≤ 1.00. Volume floors keep out small samples
// (and, for pitchers, relievers — sub-2 ERA is routine in short relief stints).
// When true the player is always already in the elite-green tier. Tunable.
const HISTORIC_MIN_PA = 150;   // hitter qualification guard
const HISTORIC_MIN_IP = 60;    // pitcher guard (also excludes relievers)
function isHistoricSeason(type, p) {
  if (!p) return false;
  if (type === 'hitter') {
    const ops = p.ops || 0;
    const pa  = parseInt(p.stats?.plateAppearances || p.stats?.atBats || 0);
    return ops >= 1.000 && pa >= HISTORIC_MIN_PA;
  }
  const s    = p.stats || {};
  const era  = parseFloat(s.era);
  const whip = parseFloat(s.whip);
  const ip   = parseFloat(s.inningsPitched) || 0;
  return !isNaN(era) && !isNaN(whip) && era <= 2.00 && whip <= 1.00 && ip >= HISTORIC_MIN_IP;
}

// Map a bright scale color to a darkened variant readable as text on white.
// Bright colors (yellow/light-green) wash out as text; these match the
// "Team Stats vs League" rank colors.
function statTextColor(scaleColor) {
  return {
    '#16a34a': '#16a34a',  // verde
    '#b1c882': '#7d9440',  // verde claro
    '#ffc000': '#c29200',  // amarillo
    '#ff8100': '#e06f00',  // naranja
    '#ff2200': '#e51f00',  // rojo
    '#9ca3af': '#6b7280',  // sin datos
  }[scaleColor] || scaleColor;
}

function diamondColorLegendHTML() {
  const tiers = [
    ['#ff2200', 'POOR'],
    ['#ff8100', 'BELOW AVG'],
    ['#ffc000', 'AVERAGE'],
    ['#b1c882', 'ABOVE AVG'],
    ['#16a34a', 'ELITE'],
  ];
  return `<div style="margin:0 0 14px;max-width:420px">
    <div style="display:flex;border-radius:999px;overflow:hidden;height:8px">${tiers.map(([c]) =>
      `<div style="flex:1;background:${c}"></div>`
    ).join('')}</div>
    <div style="display:flex;margin-top:4px">${tiers.map(([, label]) =>
      `<div style="flex:1;text-align:center;font-family:'Barlow Condensed';font-size:9px;font-weight:700;letter-spacing:.5px;color:var(--muted)">${label}</div>`
    ).join('')}</div>
  </div>`;
}

// ── FORMA score system (0–100, never exceeds 100) ─────────────────────────
// Media MLB 2024: ERA 4.15, WHIP 1.27 → FORMA 51
// Kershaw carrera: ERA 2.53, WHIP 1.018 → FORMA 76
const ERA_BEST = 1.50,  ERA_WORST = 6.00;
const WHIP_BEST = 0.80, WHIP_WORST = 2.00;
const MIN_IP_RELIABLE = 3;

function calcBaseScore(era, whip) {
  const eraScore = !isNaN(era) && era >= 0
    ? Math.max(0, Math.min(100, ((ERA_WORST - era) / (ERA_WORST - ERA_BEST)) * 100))
    : null;
  const whipScore = !isNaN(whip) && whip >= 0
    ? Math.max(0, Math.min(100, ((WHIP_WORST - whip) / (WHIP_WORST - WHIP_BEST)) * 100))
    : null;
  const components = [eraScore, whipScore].filter(v => v !== null);
  if (components.length === 0) return null;
  return Math.round(components.reduce((a, b) => a + b, 0) / components.length);
}

function calcFormaScore(eraSeason, whipSeason, eraRecent, whipRecent, ipRecent) {
  const base = calcBaseScore(eraSeason, whipSeason);
  if (base === null) return null;
  const hasRecent = !isNaN(eraRecent) && !isNaN(whipRecent) && (ipRecent || 0) >= MIN_IP_RELIABLE;
  if (!hasRecent) return base;
  const recent = calcBaseScore(eraRecent, whipRecent);
  if (recent === null) return base;
  return Math.round(base * 0.85 + recent * 0.15);
}

function calcPitcherScore(stat) {
  if (!stat) return null;
  const s = calcBaseScore(parseFloat(stat.era), parseFloat(stat.whip));
  // If stats exist but score is 0 or negative (terrible ERA/WHIP), show 0 not null
  if (s === null) return null;
  return Math.max(0, s);
}

function calcPitcherScoreWithRecent(stat, pid) {
  if (!stat) return null;
  const recent = recentPitchingCache[pid];
  return calcFormaScore(
    parseFloat(stat.era), parseFloat(stat.whip),
    recent?.era, recent?.whip, recent?.ip
  );
}

async function loadRosters() {
  const listEl = document.getElementById('teamSelectorList');
  if (!allData.standings) {
    // Standings not yet loaded — wait up to 10s
    listEl.innerHTML = '<div class="loading"><div class="spinner"></div><div class="loading-text">LOADING...</div></div>';
    let attempts = 0;
    while (!allData.standings && attempts < 40) {
      await new Promise(r => setTimeout(r, 250));
      attempts++;
    }
  }
  if (!allData.standings) {
    listEl.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px">No standings data.</div>';
    return;
  }

  // Division order: AL East, AL Central, AL West, NL East, NL Central, NL West
  const DIV_ORDER = [201, 202, 200, 204, 205, 203];
  const DIV_LABELS = {
    200: 'AL West', 201: 'AL East', 202: 'AL Central',
    203: 'NL West', 204: 'NL East', 205: 'NL Central',
  };

  // Build a map: divId → sorted teamRecords
  const divMap = {};
  allData.standings.forEach(div => {
    const divId = div.division?.id;
    if (!divId) return;
    const sorted = [...div.teamRecords].sort((a,b) => {
      const pa = parseFloat(a.winningPercentage)||0, pb = parseFloat(b.winningPercentage)||0;
      return pb - pa || b.wins - a.wins;
    });
    divMap[divId] = sorted;
  });

  let html = '';
  DIV_ORDER.forEach(divId => {
    const teams = divMap[divId];
    if (!teams?.length) return;
    html += `<div class="team-div-group">
      <div class="team-div-label">${DIV_LABELS[divId] || ''}</div>
      <div class="team-logo-grid">`;
    teams.forEach(tr => {
      const tid = tr.team.id;
      const meta = TEAM_META[tid] || {
        name: tr.team.name,
        abbr: tr.team.abbreviation || String(tid),
        logo: `https://www.mlbstatic.com/team-logos/${tid}.svg`,
      };
      html += `<button class="team-logo-btn" id="ts-${tid}" onclick="selectTeam(${tid})" title="${meta.name}" aria-label="${meta.name}">
        <img src="${meta.logo}" alt="${meta.abbr}" onerror="this.style.display='none'">
      </button>`;
    });
    html += `</div></div>`;
  });
  listEl.innerHTML = html;
}

function toggleTeamSelector(forceOpen) {
  const list = document.getElementById('teamSelectorList');
  const chevron = document.getElementById('teamSelectorChevron');
  if (!list) return;
  const isCollapsed = list.style.display === 'none';
  const shouldOpen = forceOpen !== undefined ? forceOpen : isCollapsed;
  list.style.display = shouldOpen ? '' : 'none';
  if (chevron) chevron.style.transform = shouldOpen ? '' : 'rotate(-90deg)';
}

// Navigate from Top Games to MVP tracker — shows breadcrumb back to Top Games
function goToMVPFromTopGames(awardType) {
  window._fromTopGames = true;
  window._fromTopGamesAwardType = awardType;
  // Map award type to filter
  const filterMap = { MVP: 'mvp', CY: 'cy', ROY: 'roy' };
  const filter = filterMap[awardType] || 'all';
  switchTab('mvp');
  // Apply filter once MVP loads
  setTimeout(() => {
    if (window._renderMVPView) {
      setMVPFilter(filter);
    }
  }, 300);
}

// Navigate from standings to a team — shows breadcrumb back to standings
function goToTeam(teamId) {
  window._fromStandings = true;
  switchTab('rosters');
  // Wait for rosters to load then select the team
  const trySelect = () => {
    if (document.getElementById(`ts-${teamId}`)) {
      selectTeam(teamId);
    } else {
      setTimeout(trySelect, 150);
    }
  };
  setTimeout(trySelect, 100);
}

async function selectTeam(teamId) {
  document.querySelectorAll('.team-logo-btn').forEach(el => el.classList.remove('active'));
  const selEl = document.getElementById(`ts-${teamId}`);
  if (selEl) selEl.classList.add('active');

  // Update selector label to show selected team name
  const meta = TEAM_META[teamId] || { name: `Team ${teamId}`, abbr: '?', logo: `https://www.mlbstatic.com/team-logos/${teamId}.svg`, color: '#1565d8' };
  const label = document.getElementById('teamSelectorLabel');
  if (label) label.textContent = meta.abbr || meta.name;

  // On mobile: collapse the selector list and scroll to diamond panel
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    toggleTeamSelector(false);
    setTimeout(() => {
      const panel = document.getElementById('diamondPanel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }

  selectedTeamId = teamId;
  selectedDiamondKey = null;

  const abbrSlug = (meta.abbr || '').toLowerCase();
  if (abbrSlug && abbrSlug !== '?') history.replaceState(null, '', `#rosters/${abbrSlug}`);

  // Breadcrumb: show "← Clasificaciones" if arrived from standings
  const breadcrumbEl = document.getElementById('rosterBreadcrumb');
  if (breadcrumbEl) {
    if (window._fromStandings) {
      breadcrumbEl.style.display = 'flex';
    } else {
      breadcrumbEl.style.display = 'none';
    }
  }

  const panel = document.getElementById('diamondPanel');

  panel.innerHTML = `
    <div class="diamond-panel-header">
      <img class="dp-logo" src="${meta.logo}" alt="${meta.abbr}" onerror="this.style.display='none'">
      <div>
        <div class="dp-team-name">${meta.name}</div>
        <div class="dp-subtitle">LOADING IMPACT DATA…</div>
      </div>
    </div>
    <div class="loading" style="padding:40px 0"><div class="spinner"></div><div class="loading-text">FETCHING ROSTER & STATS…</div></div>`;

  try {
    let impact = teamsImpactCache[teamId];
    let fromStorage = false;
    if (!impact) {
      // Try localStorage bundle: impact + per-player caches, saved with daily expiry
      const stored = cacheGet(`mlb_team_impact_v3_${teamId}`);
      if (stored?.impact) {
        impact = stored.impact;
        teamsImpactCache[teamId] = impact;
        Object.assign(careerStatsCache, stored.career || {});
        Object.assign(awardsCache, stored.awards || {});
        Object.assign(recentPitchingCache, stored.recentP || {});
        Object.assign(recentHittingCache, stored.recentH || {});
        Object.assign(seasonHistoryCache, stored.seasonHist || {});
        fromStorage = true;
      }
    }
    if (!impact) {
      impact = await fetchTeamImpact(teamId);
      teamsImpactCache[teamId] = impact;
    }
    const allPids = [
      ...Object.values(impact.hittersByPos).flat().map(p=>p.id),
      ...impact.spList.map(p=>p.id),
      ...impact.clList.map(p=>p.id),
      ...impact.rpList.map(p=>p.id),
      ...impact.ilPlayers.map(p=>p.id),
    ].filter(Boolean);
    const uniquePids = [...new Set(allPids)];
    const pitcherPids = [...new Set([
      ...impact.spList.map(p=>p.id),
      ...impact.clList.map(p=>p.id),
      ...impact.rpList.map(p=>p.id),
      ...impact.ilPlayers.filter(p=>p.isPitcher).map(p=>p.id),
    ])].filter(Boolean);
    const hitterPids = [...new Set(
      Object.values(impact.hittersByPos).flat().map(p=>p.id).filter(Boolean)
    )];
    await Promise.all([
      fetchLeagueTeamStats(),
      fetchCareerStats(uniquePids),
      fetchRecentPitching(pitcherPids),
      fetchRecentHitting(hitterPids),
      fetchAwards(uniquePids),
      fetchTrades(),
    ]);
    Object.values(impact.hittersByPos).flat().forEach(p => { p.isRookie = isRookieEligible(p.id, 'hitter'); p.tradedIn = tradedCache[p.id] === teamId; });
    [...impact.spList, ...impact.clList, ...impact.rpList].forEach(p => { p.isRookie = isRookieEligible(p.id, 'pitcher'); p.tradedIn = tradedCache[p.id] === teamId; });
    impact.ilPlayers.forEach(p => { p.isRookie = isRookieEligible(p.id, p.isPitcher ? 'pitcher' : 'hitter'); p.tradedIn = tradedCache[p.id] === teamId; });
    // Recalculate FORMA with recent data now available
    [...impact.spList, ...impact.clList, ...impact.rpList].forEach(p => {
      p.score = calcPitcherScoreWithRecent(p.stats || {}, p.id) ?? 0;
    });
    renderDiamondPanel(teamId, impact);

    if (!fromStorage) {
      // Persist bundle so revisits (even after reload) skip all fetches today
      const pick = src => {
        const o = {};
        uniquePids.forEach(pid => { if (pid in src) o[pid] = src[pid]; });
        return o;
      };
      cacheSet(`mlb_team_impact_v3_${teamId}`, {
        impact,
        career: pick(careerStatsCache),
        awards: pick(awardsCache),
        recentP: pick(recentPitchingCache),
        recentH: pick(recentHittingCache),
        seasonHist: pick(seasonHistoryCache),
      });
    }
  } catch(e) {
    panel.innerHTML = errorStateHTML(`selectTeam(${teamId})`);
  }
}

function getDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

async function fetchTeamImpact(teamId) {
  const season = CURRENT_YEAR;
  const yesterday = getDateOffset(-1);
  const today     = getDateOffset(0);

  // Fetch roster (hydrated), schedule (for boxscores + yesterday's games), and IL list in parallel
  const [rosterData, schedData, ilData] = await Promise.all([
    fetchWithTimeout(`${MLB_API}/teams/${teamId}/roster?rosterType=active&season=${season}&hydrate=person(birthCountry,stats(group=[hitting,pitching],type=season,season=${season}))`)
      .then(r => r.json()).catch(() => ({ roster: [] })),
    fetchWithTimeout(`${MLB_API}/schedule?sportId=1&teamId=${teamId}&season=${season}&gameType=R&startDate=${season}-03-01&endDate=${today}`)
      .then(r => r.json()).catch(() => ({ dates: [] })),
    // 40-man roster includes IL players with their status
    fetchWithTimeout(`${MLB_API}/teams/${teamId}/roster?rosterType=40Man&season=${season}&hydrate=person(birthCountry,pitchHand,stats(group=[hitting,pitching],type=season,season=${season}))`)
      .then(r => r.json()).catch(() => ({ roster: [] })),
  ]);

  const roster = rosterData.roster || [];
  // IL players = those in 40-man but NOT on active roster, with an injury-related status
  const activeIds = new Set(roster.map(p => p.person?.id));
  const IL_STATUSES = new Set(['7-Day Injured List', '10-Day Injured List', '15-Day Injured List', '60-Day Injured List', 'Paternity List', 'Bereavement List', 'Suspended List']);
  const ilRoster = (ilData.roster || []).filter(p => {
    if (activeIds.has(p.person?.id)) return false; // skip active players
    const statusDesc = p.status?.description || '';
    // Include if status explicitly mentions IL, or if not on active roster and has a non-active status
    return IL_STATUSES.has(statusDesc) || statusDesc.toLowerCase().includes('injured') || statusDesc.toLowerCase().includes('list');
  });

  // Fetch recent transactions to get the actual IL placement date for each player
  const ilPlacementDates = {}; // pid → date string 'YYYY-MM-DD'
  try {
    const seasonStart = `${season}-01-01`;
    const txRes = await fetchWithTimeout(
      `${MLB_API}/transactions?teamId=${teamId}&startDate=${seasonStart}&endDate=${today}&sportId=1`
    ).then(r => r.json()).catch(() => ({ transactions: [] }));
    // Sort newest-first so we capture the most recent IL placement per player
    const txList = (txRes.transactions || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    txList.forEach(tx => {
      const pid = tx.person?.id;
      if (!pid) return;
      const desc = (tx.description || '').toLowerCase();
      const typeCode = (tx.typeCode || tx.type?.code || '').toUpperCase();
      const isILPlacement =
        typeCode === 'IL' || typeCode === 'ILD' ||
        (desc.includes('placed') && desc.includes('injured list')) ||
        (desc.includes('transferred') && desc.includes('injured list'));
      if (isILPlacement && !ilPlacementDates[pid]) {
        ilPlacementDates[pid] = (tx.date || tx.effectiveDate || '').slice(0, 10);
      }
    });
  } catch(e) { /* silently ignore */ }

  // Parse hydrated stats for active roster
  const hitStatMap   = {};
  const pitchStatMap = {};
  [...roster, ...ilRoster].forEach(player => {
    const pid = player.person?.id;
    if (!pid) return;
    (player.person?.stats || []).forEach(sg => {
      const stat = sg?.splits?.[0]?.stat;
      const grp  = sg?.group?.displayName?.toLowerCase();
      if (!stat || !grp) return;
      if (grp === 'hitting')  hitStatMap[pid]   = stat;
      if (grp === 'pitching') pitchStatMap[pid] = stat;
    });
  });

  // Fallback: fetch missing stats individually (batched)
  const missingPids = roster
    .filter(p => {
      const pid = p.person?.id, pos = p.position?.abbreviation;
      if (!pid) return false;
      if (pos === 'P') return !pitchStatMap[pid];
      return !hitStatMap[pid];
    })
    .map(p => p.person.id);

  if (missingPids.length) {
    for (let i = 0; i < missingPids.length; i += 20) {
      const chunk = missingPids.slice(i, i + 20).join(',');
      await Promise.all([
        fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=season,group=hitting,season=${season})`).then(r=>r.json()).then(d=>{
          (d.people||[]).forEach(p=>{ const s=p.stats?.find(g=>g.group?.displayName==='hitting')?.splits?.[0]?.stat; if(s) hitStatMap[p.id]=s; });
        }).catch(()=>{}),
        fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=season,group=pitching,season=${season})`).then(r=>r.json()).then(d=>{
          (d.people||[]).forEach(p=>{ const s=p.stats?.find(g=>g.group?.displayName==='pitching')?.splits?.[0]?.stat; if(s) pitchStatMap[p.id]=s; });
        }).catch(()=>{})
      ]);
    }
  }

  // Collect recent game IDs for boxscore analysis
  const allGameIds = [];
  let yesterdayGameId = null;
  (schedData.dates || []).forEach(d => {
    (d.games || []).forEach(g => {
      if (g.status.abstractGameState !== 'Final') return;
      allGameIds.push(g.gamePk);
      if (d.date === yesterday) yesterdayGameId = g.gamePk;
    });
  });

  // Fetch all season boxscores for QS calculation AND full-season hitter pos tracking
  // (Previously only last-15 were used for hitters, which caused wrong starters when
  //  a player returned from the IL with few recent appearances despite more total games)
  const last15 = allGameIds.slice(-15); // kept for pitcher rest-days only
  // Also store the date of each game by gamePk
  const gamePkToDate = {};
  (schedData.dates || []).forEach(d => {
    (d.games || []).forEach(g => { gamePkToDate[g.gamePk] = d.date; });
  });

  const dhCount          = {}; // pid → # of DH appearances
  const hitterPosCount   = {}; // pid → {pos → count}
  const hitterPosRecent  = {}; // pid → {pos → lastDate}
  const pitcherApps      = {}; // pid → {starts, relief, closerApps, lastPitchDate, qualityStarts}
  const lineupSnapshots  = []; // [{ date, gamePk, starters:[{pid,pos}] }]

  // Use all games for pitcher stats (QS needs full season), last15 is still used for hitter positions
  await Promise.all(allGameIds.map(async (gamePk) => {
    const isRecent = last15.includes(gamePk);
    try {
      const bData = await fetchWithTimeout(`${MLB_API}/game/${gamePk}/boxscore`).then(r => r.json());
      const teamKey = Object.keys(bData.teams||{}).find(k => bData.teams[k].team?.id === teamId);
      if (!teamKey) return;
      const gameDate = gamePkToDate[gamePk] || null;
      const lineupStarters = [];

      // The pitchers array lists them in order: index 0 = starter
      const pitchersArr = bData.teams[teamKey].pitchers || [];
      const starterPid = pitchersArr[0] || null;

      Object.values(bData.teams[teamKey].players || {}).forEach(pl => {
        const pid = pl.person?.id;
        const pos = pl.position?.abbreviation;
        if (!pid) return;

        const allPos = pl.allPositions || [];
        const gamePrimaryPos = allPos.length > 0 ? allPos[0].abbreviation : pos;
        const battingOrder = String(pl.battingOrder || '');
        const isStartingBatter = battingOrder.endsWith('00');

        // Track hitter positions across ALL games this season (not just last 15)
        // Use gamePrimaryPos so we track where they actually played, not their roster slot
        const trackPos = gamePrimaryPos;
        if (trackPos && trackPos !== 'P' && trackPos !== 'TWP' && trackPos !== 'N/A') {
          if (!hitterPosCount[pid]) hitterPosCount[pid] = {};
          hitterPosCount[pid][trackPos] = (hitterPosCount[pid][trackPos] || 0) + 1;
          if (trackPos === 'DH') dhCount[pid] = (dhCount[pid] || 0) + 1;
          if (gameDate) {
            if (!hitterPosRecent[pid]) hitterPosRecent[pid] = {};
            if (!hitterPosRecent[pid][trackPos] || gameDate > hitterPosRecent[pid][trackPos]) {
              hitterPosRecent[pid][trackPos] = gameDate;
            }
          }
        }
        if (isStartingBatter && gamePrimaryPos && gamePrimaryPos !== 'P' && gamePrimaryPos !== 'TWP' && gamePrimaryPos !== 'N/A') {
          lineupStarters.push({ pid, pos: gamePrimaryPos });
        }

        // Check if this player pitched (primary pos P/TWP OR appears in pitchers array with pitching stats)
        const pitchedThisGame = (pos === 'P' || pos === 'TWP') ||
          (pid === starterPid) ||
          (pl.allPositions || []).some(ap => ap.abbreviation === 'P' || ap.abbreviation === 'TWP');

        if (pitchedThisGame) {
          if (!pitcherApps[pid]) pitcherApps[pid] = { starts: 0, relief: 0, closerApps: 0, lastPitchDate: null, qualityStarts: 0 };
          const pst = pl.stats?.pitching || {};
          const ipThisGame = parseFloat(pst.inningsPitched) || 0;
          if (ipThisGame > 0) {
            if (pid === starterPid) {
              pitcherApps[pid].starts++;
              // Quality Start: starter pitches ≥6 IP and allows ≤3 earned runs
              const erThisGame = parseInt(pst.earnedRuns) || 0;
              if (ipThisGame >= 6.0 && erThisGame <= 3) {
                pitcherApps[pid].qualityStarts++;
              }
            } else {
              pitcherApps[pid].relief++;
              if ((parseInt(pst.saves)||0) > 0 || (parseInt(pst.holds)||0) > 0 || (parseInt(pst.blownSaves)||0) > 0) {
                pitcherApps[pid].closerApps++;
              }
            }
            if (gameDate && (!pitcherApps[pid].lastPitchDate || gameDate > pitcherApps[pid].lastPitchDate)) {
              pitcherApps[pid].lastPitchDate = gameDate;
            }
          }
        }
      });
      if (lineupStarters.length && gameDate) {
        lineupSnapshots.push({ date: gameDate, gamePk, starters: lineupStarters });
      }
    } catch(e) {}
  }));

  const latestLineup = lineupSnapshots
    .slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || ((b.gamePk || 0) - (a.gamePk || 0)))[0] || null;
  const latestLineupByPos = {};
  const latestLineupByPid = {};
  if (latestLineup) {
    latestLineup.starters.forEach(entry => {
      if (!latestLineupByPos[entry.pos]) latestLineupByPos[entry.pos] = entry.pid;
      latestLineupByPid[entry.pid] = entry.pos;
    });
  }

  // MLB debut year for rookie detection:
  // - Debuted this season = definite rookie
  // - Debuted last season but career AB < 130 AND career IP < 130 = still ROY-eligible (e.g. McLean)
  const rookiePids = new Set();
  roster.forEach(p => {
    if (NON_ROOKIE_OVERRIDES.has(p.person?.id)) return;
    const debut = p.person?.mlbDebutDate;
    if (!debut) return;
    const debutYear = parseInt(debut.slice(0, 4));
    if (debutYear === season) {
      rookiePids.add(p.person.id); // true rookie
    } else if (debutYear === season - 1) {
      // Check career thresholds — if loaded, use them; if not yet loaded, mark tentatively
      const c = careerStatsCache[p.person.id];
      if (!c || isRookieEligible(p.person.id, p.position?.abbreviation === 'P' ? 'pitcher' : 'hitter')) {
        rookiePids.add(p.person.id);
      }
    }
  });

  // ── HITTERS ──────────────────────────────────────────────────────────────
  // LAST LINEUP:
  // Titulares = alineación inicial del último partido finalizado.
  // Alternativas = posiciones habituales de temporada.

  const VALID_POS = new Set(['C','1B','2B','SS','3B','LF','CF','RF','DH']);
  const GENERIC_POS = new Set(['OF','IF','UT','PH','PR']);
  const GENERIC_FALLBACK = { OF:'LF', IF:'SS', UT:'DH', PH:'DH', PR:'DH' };

  // Build player objects for all non-pitchers on roster
  const allHitters = [];
  roster.filter(p => p.position?.abbreviation !== 'P').forEach(p => {
    const pid      = p.person?.id;
    if (!pid) return;
    const hs        = hitStatMap[pid] || null;
    const ops       = parseFloat(hs?.ops) || 0;
    const gamesPlayed = parseInt(hs?.gamesPlayed) || 0;
    const rosterPos = p.position?.abbreviation || '';
    const isTWP     = rosterPos === 'TWP';
    const posCount  = hitterPosCount[pid] || {};

    // Best position from boxscores = most appearances in a valid pos this season
    const boxscoreEntries = Object.entries(posCount)
      .filter(([pp]) => VALID_POS.has(pp))
      .sort((a, b) => b[1] - a[1]);
    const bestBoxscorePos = boxscoreEntries[0]?.[0] || null;

    // Fallback: use roster API position if no boxscore data
    let fallbackPos = null;
    if (VALID_POS.has(rosterPos)) fallbackPos = rosterPos;
    else if (GENERIC_POS.has(rosterPos)) fallbackPos = GENERIC_FALLBACK[rosterPos] || 'DH';
    else if (rosterPos === 'TWP') fallbackPos = 'DH';
    else fallbackPos = 'DH';

    allHitters.push({
      id: pid,
      name: p.person?.fullName||'?',
      lastName: p.person?.lastName||'?',
      number: p.jerseyNumber||'',
      bats: p.person?.batSide?.code||'?',
      dhApps: dhCount[pid] || 0,
      isRookie: rookiePids.has(pid),
      flag: countryFlag(p.person?.birthCountry, p.person?.id),
      gamesPlayed,
      ops, stats: hs,
      rosterPos,
      isTWP,
      posCount,
      posRecent: hitterPosRecent[pid] || {},
      lastLineupPos: latestLineupByPid[pid] || null,
      bestBoxscorePos,
      fallbackPos,
      photoUrl: siloHeadshot(pid)
    });
  });

  const hittersByPos = {};
  const nonTWP = allHitters.filter(p => !p.isTWP);
  const hitterById = Object.fromEntries(allHitters.map(p => [p.id, p]));

  // STEP 1: Determine each player's "claim" position.
  // Priority order:
  //   (a) If the roster API lists them as DH → always DH (e.g. Yordan Alvarez)
  //   (b) If DH appearances in boxscores exceed any single field position → DH
  //   (c) If DH appearances are ≥ 40% of their total appearances (primary DH who
  //       also plays some LF/RF) → DH. Catches players listed as OF on roster
  //       but used mainly as DH in-game.
  //   (d) Otherwise use bestBoxscorePos, falling back to rosterPos
  nonTWP.forEach(p => {
    const dhApps = p.posCount['DH'] || 0;
    const totalApps = Object.values(p.posCount).reduce((a, b) => a + b, 0);
    const bestFieldPos = Object.entries(p.posCount)
      .filter(([pp]) => VALID_POS.has(pp) && pp !== 'DH')
      .sort((a, b) => b[1] - a[1])[0];
    const bestFieldCount = bestFieldPos ? bestFieldPos[1] : 0;

    if (p.rosterPos === 'DH') {
      // Roster API says DH → always DH (e.g. Yordan Alvarez)
      p.claimPos = 'DH';
    } else if (dhApps > 0 && totalApps > 0 && (dhApps / totalApps) >= 0.60) {
      // Clear majority DH (≥60% of appearances) → primary DH regardless of listed position
      // 3 DH out of 20 games = 15% → stays at field pos
      // 12 DH out of 18 games = 67% → becomes DH
      p.claimPos = 'DH';
    } else {
      // Use best boxscore pos or roster API position as fallback
      p.claimPos = p.bestBoxscorePos || p.fallbackPos;
    }
    p.claimCount = p.posCount[p.claimPos] || 0;
  });


  // STEP 2: Build candidate pools from season-long position usage.
  const POS_PRIORITY = ['C','SS','2B','3B','1B','CF','LF','RF','DH'];
  const candidatesByPos = {};
  POS_PRIORITY.forEach(pos => {
    candidatesByPos[pos] = nonTWP
      .filter(p => (p.posCount[pos] || 0) > 0 || p.claimPos === pos)
      .sort((a, b) => {
        const aCount = a.posCount[pos] || 0;
        const bCount = b.posCount[pos] || 0;
        if (bCount !== aCount) return bCount - aCount;
        // Tiebreaker 1: prefer player whose roster API position matches this pos
        // (catches Langeliers case: listed as C on roster but fewer recent boxscore C apps)
        const aIsNative = a.rosterPos === pos ? 1 : 0;
        const bIsNative = b.rosterPos === pos ? 1 : 0;
        if (bIsNative !== aIsNative) return bIsNative - aIsNative;
        // Tiebreaker 2: total games played this season
        if (b.gamesPlayed !== a.gamesPlayed) return b.gamesPlayed - a.gamesPlayed;
        return b.ops - a.ops;
      });
  });

  // STEP 3: Lock starters from the latest lineup, then fill any gaps greedily.
  const primaryPos = {};  // pid → pos (starter assignment)
  Object.entries(latestLineupByPos).forEach(([pos, pid]) => {
    if (VALID_POS.has(pos) && hitterById[pid]) primaryPos[pid] = pos;
  });
  POS_PRIORITY.forEach(pos => {
    if (Object.values(primaryPos).includes(pos)) return;
    const candidates = (candidatesByPos[pos] || []).filter(p =>
      !(p.id in primaryPos) && (pos === 'DH' || p.claimPos !== 'DH')
    );
    const starter = candidates[0];
    if (starter) primaryPos[starter.id] = pos;
  });

  // Players with no assignment go to DH as fallback
  allHitters.filter(p => !(p.id in primaryPos)).forEach(p => {
    primaryPos[p.id] = 'DH';
  });

  // TWP players (Ohtani-type): fallback to DH only if latest lineup didn't already define DH.
  const twpPlayers = allHitters.filter(p => p.isTWP);
  if (!latestLineupByPos['DH'] && twpPlayers.length && !(twpPlayers[0].id in primaryPos)) {
    primaryPos[twpPlayers[0].id] = 'DH';
  }

  // STEP 4: Build hittersByPos.
  // - Starter: latest lineup if available, otherwise primaryPos fallback.
  // - Alts: players who've actually played that spot, but are starters elsewhere or bench depth.
  POS_PRIORITY.forEach(pos => {
    let starter = null;
    const latestPid = latestLineupByPos[pos];
    if (latestPid && hitterById[latestPid]) {
      starter = { ...hitterById[latestPid], pos, truePrimaryPos: pos };
    } else if (pos === 'DH') {
      const dhCandidates = allHitters
        .filter(p => primaryPos[p.id] === 'DH')
        .sort((a, b) => (b.posCount['DH'] || 0) - (a.posCount['DH'] || 0) || b.gamesPlayed - a.gamesPlayed);
      if (dhCandidates[0]) starter = { ...dhCandidates[0], pos: 'DH', truePrimaryPos: 'DH' };
    } else {
      const found = allHitters.find(p => primaryPos[p.id] === pos);
      if (found) starter = { ...found, pos, truePrimaryPos: pos };
    }

    const alts = allHitters
      .filter(p =>
        p.id !== starter?.id &&
        primaryPos[p.id] !== pos &&
        (p.posCount[pos] || 0) >= 2
      )
      .sort((a, b) => (b.posCount[pos]||0) - (a.posCount[pos]||0) || b.gamesPlayed - a.gamesPlayed || b.ops - a.ops);

    if (pos === 'DH' && starter?.isTWP) {
      const dhFallbacks = nonTWP
        .filter(p => primaryPos[p.id] === 'DH' && (p.posCount['DH'] || 0) >= 1)
        .sort((a, b) => b.gamesPlayed - a.gamesPlayed || b.ops - a.ops);
      dhFallbacks.forEach(p => {
        if (!alts.find(a => a.id === p.id)) alts.unshift({ ...p });
      });
    }

    const all = [];
    if (starter) all.push(starter);
    alts.forEach(p => all.push({ ...p, pos, truePrimaryPos: primaryPos[p.id] || p.claimPos }));
    if (all.length) hittersByPos[pos] = all;
  });

  // ── PITCHERS ─────────────────────────────────────────────────────────────
  const todayDate = new Date(today + 'T12:00:00');
  const pitcherEntries = roster
    .filter(p => p.position?.abbreviation === 'P' || p.position?.abbreviation === 'TWP')
    .map(p => {
      const pid = p.person?.id;
      const ps  = pitchStatMap[pid] || null;
      const gp  = parseInt(ps?.gamesPitched)    || 0;
      const gs  = parseInt(ps?.gamesStarted)    || 0;
      const sv  = parseInt(ps?.saves)           || 0;
      const hld = parseInt(ps?.holds)           || 0;
      const svo = parseInt(ps?.saveOpportunities)|| 0;
      const ip  = parseFloat(ps?.inningsPitched)|| 0;
      const apps = pitcherApps[pid] || { starts:0, relief:0, closerApps:0, lastPitchDate: null };

      // Calculate days of rest since last appearance
      let restDays = null;
      if (apps.lastPitchDate) {
        const lastDate = new Date(apps.lastPitchDate + 'T12:00:00');
        restDays = Math.round((todayDate - lastDate) / (1000 * 60 * 60 * 24));
      }

      return {
        id: pid, name: p.person?.fullName||'?', lastName: p.person?.lastName||'?',
        number: p.jerseyNumber||'', throws: p.person?.pitchHand?.code||'?',
        score: calcPitcherScore(ps), stats: ps,
        gp, gs, sv, hld, svo, ip,
        ipPerStart: gs > 0 ? ip / gs : 0,
        recentStartPct: (apps.starts + apps.relief) > 0 ? apps.starts / (apps.starts + apps.relief) : (gp > 0 ? gs/gp : 0),
        closerSignal: apps.closerApps,
        restDays,
        qualityStarts: apps.qualityStarts || 0,
        isRookie: rookiePids.has(pid),
        flag: countryFlag(p.person?.birthCountry, p.person?.id),
        photoUrl: siloHeadshot(pid)
      };
    });

  // QS is now calculated from boxscores above (≥6 IP + ≤3 ER as starter)
  // Inject calculated QS into pitchStatMap so it shows in statsLine
  pitcherEntries.forEach(p => {
    if (p.qualityStarts > 0 && pitchStatMap[p.id]) {
      pitchStatMap[p.id].qualityStarts = p.qualityStarts;
      p.stats = pitchStatMap[p.id];
    }
  });

  const spList = [], clList = [], rpList = [];

  pitcherEntries.forEach(p => {
    // TWP (Ohtani): only include in pitching if he has actually pitched this season
    if (p.stats === null || (p.gp === 0 && p.gs === 0 && p.ip === 0)) return;

    // A pitcher with holds CANNOT be a starter — holds are by definition relief-only
    if (p.hld > 0) { rpList.push(p); return; }

    // Opener: started games but short outings AND more relief apps than starts → RP
    const isOpener = p.gs >= 1 && p.ipPerStart < 3.0 && p.gp > 0 && (p.gp - p.gs) > p.gs;

    // Starter: at least 1 GS, not an opener, majority of recent appearances are starts
    // Early-season fallback: if no boxscore data yet (recentStartPct comes from season gs/gp ratio)
    const isStarter = p.gs >= 1 && !isOpener && p.recentStartPct >= 0.4;

    // Closer: pure reliever (gs=0, hld=0) with save opportunities or closer signal from boxscores
    const isCloser = !isStarter && p.gs === 0 && (p.svo >= 1 || p.sv >= 1 || p.closerSignal >= 2);

    if (isStarter)     spList.push(p);
    else if (isCloser) clList.push(p);
    else               rpList.push(p);
  });

  // Sort pitcher groups by days of rest desc (most rested first).
  // null restDays (no recent data) go to the end.
  function sortPitchersByRest(a, b, secondary) {
    const aRest = a.restDays ?? -1;
    const bRest = b.restDays ?? -1;
    return (bRest - aRest) || secondary(a, b);
  }
  spList.sort((a,b) => sortPitchersByRest(a, b, (x, y) => (y.gs - x.gs) || (y.ip - x.ip)));
  clList.sort((a,b) => sortPitchersByRest(a, b, (x, y) => (y.sv - x.sv) || (y.svo - x.svo) || (y.score - x.score)));
  rpList.sort((a,b) => sortPitchersByRest(a, b, (x, y) => (y.score - x.score) || (y.hld - x.hld) || (y.ip - x.ip)));

  // ── IL PLAYERS ───────────────────────────────────────────────────────────
  const IL_DURATION = { '7': 7, '10': 10, '15': 15, '60': 60 };
  function ilDays(desc) {
    const m = (desc||'').match(/(\d+)[\s-]*day/i);
    return m ? parseInt(m[1]) : 15;
  }

  const ilPlayers = ilRoster.map(p => {
    const pid  = p.person?.id;
    const pos  = p.position?.abbreviation;
    const hs   = hitStatMap[pid]   || null;
    const ps   = pitchStatMap[pid] || null;
    const ops  = parseFloat(hs?.ops) || 0;
    const score = calcPitcherScore(ps);
    const ilType = p.status?.description || 'IL';
    const duration = ilDays(ilType);
    // Use placement date from transactions API (most reliable source)
    const placedDate = ilPlacementDates[pid] || null;
    let daysRemaining = null;
    if (placedDate) {
      const placed = new Date(placedDate + 'T12:00:00');
      const nowDay = new Date();
      nowDay.setHours(12, 0, 0, 0);
      const elapsed = Math.floor((nowDay - placed) / 86400000);
      daysRemaining = Math.max(0, duration - elapsed);
    }
    return {
      id: pid, name: p.person?.fullName||'?', pos,
      ilType, ilDays: duration,
      daysRemaining, placedDate,
      isPitcher: pos === 'P' || pos === 'TWP',
      flag: countryFlag(p.person?.birthCountry, p.person?.id),
      throws: p.person?.pitchHand?.code || '?',
      ops, score,
      hasSeasonStats: (pos === 'P' || pos === 'TWP')
        ? !!ps && [ps.era, ps.whip, ps.inningsPitched].some(v => v !== undefined && v !== null && String(v).trim() !== '')
        : !!hs && [hs.avg, hs.ops, hs.homeRuns, hs.rbi].some(v => v !== undefined && v !== null && String(v).trim() !== ''),
      stats: (pos === 'P' || pos === 'TWP') ? ps : hs,
      photoUrl: siloHeadshot(pid)
    };
  }).sort((a, b) => {
    // Field players before pitchers, then players closest to returning first.
    if (a.isPitcher !== b.isPitcher) return a.isPitcher ? 1 : -1;
    const aRemain = a.daysRemaining ?? Number.POSITIVE_INFINITY;
    const bRemain = b.daysRemaining ?? Number.POSITIVE_INFINITY;
    return (aRemain - bRemain) || (a.ilDays - b.ilDays) || a.name.localeCompare(b.name);
  });

  // ── SP vs RP innings split (from season stats of classified pitchers) ──
  let spSeasonIp = 0, totalSeasonIp = 0;
  [...spList, ...clList, ...rpList].forEach(p => {
    const ip = parseFloat(p.stats?.inningsPitched) || 0;
    totalSeasonIp += ip;
    if (spList.includes(p)) spSeasonIp += ip;
  });

  return { hittersByPos, spList, clList, rpList, ilPlayers, spSeasonIp, totalSeasonIp };
}

// ── Awards cache & fetch ──────────────────────────────────────────────────
const awardsCache = {};

// ── In-season trade badge ─────────────────────────────────────────────────
// tradedCache[playerId] = team id the player was traded TO during the current
// regular season (latest wins). A player shows the badge on that team only.
// Call-ups, free-agent signings and a player going in/out of his own roster do
// NOT count — only `typeCode === 'TR'` (trades) since the season opener.
// (Offseason regime — winter trades + free agents — is a future addition.)
const tradedCache = {};
let _tradesLoaded = false;

async function fetchTrades() {
  if (_tradesLoaded) return;
  _tradesLoaded = true;
  try {
    const start = `${CURRENT_YEAR}-03-25`;   // ~ regular-season opener; excludes winter/spring trades
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetchWithTimeout(
      `${MLB_API}/transactions?startDate=${start}&endDate=${today}&sportId=1`);
    const data = await res.json();
    (data.transactions || []).forEach(t => {
      if (t.typeCode === 'TR' && t.person?.id && t.toTeam?.id) {
        tradedCache[t.person.id] = t.toTeam.id;   // chronological order → latest team wins
      }
    });
  } catch (e) { /* badge simply won't show */ }
}

function tradedBadgeHTML(traded) {
  if (!traded) return '';
  return `<span title="Acquired via in-season trade" style="position:absolute;top:50%;right:-7px;transform:translateY(-50%);width:15px;height:15px;border-radius:50%;background:#7c3aed;border:1.5px solid #fff;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#fff;line-height:1">⇄</span>`;
}

async function fetchAwards(pids) {
  const missing = pids.filter(id => !(id in awardsCache));
  if (!missing.length) return;
  missing.forEach(id => { awardsCache[id] = { allStar:false, goldGlove:false, silverSlugger:false, mvp:false, cyYoung:false }; });
  await Promise.all(missing.map(pid =>
    fetchWithTimeout(`${MLB_API}/people/${pid}/awards`)
      .then(r => r.json()).then(d => {
        (d.awards || []).forEach(a => {
          const name = (a.award?.name || a.name || '').toLowerCase();
          const id   = (a.awardId || '').toUpperCase();
          const cache = awardsCache[pid];
          // All-Star: ASG selection award
          if (name.includes('all-star') || name.includes('all star') ||
              id.includes('ASGSEL') || id === 'ASG') cache.allStar = true;
          // Gold Glove — exact match, avoid false positives
          if (name.includes('gold glove')) cache.goldGlove = true;
          // Silver Slugger — exact match only
          if (name.includes('silver slugger')) cache.silverSlugger = true;
        });
      }).catch(() => {})
  ));
}

function playerAwardState(pid) {
  const apiAwards = awardsCache[pid] || { allStar:false, goldGlove:false, silverSlugger:false, mvp:false, cyYoung:false };
  const pastAwards = PAST_AWARDS[pid] || null;
  return {
    allStar: !!apiAwards.allStar,
    goldGlove: !!apiAwards.goldGlove,
    silverSlugger: !!apiAwards.silverSlugger,
    mvp: !!pastAwards?.mvp?.length,
    cyYoung: !!pastAwards?.cy?.length,
  };
}

// ── Award SVG icons (14×14 viewBox, minimalista/lineal) ───────────────────
const AWARD_SVGS = {
  // All-Star: yellow circle + white star
  allStar: () => `<svg width="16" height="16" viewBox="-16 -16 32 32"><circle r="15" fill="#f59e0b"/><polygon points="0,-9 2.5,-3.5 8.5,-3.5 4,0 5.5,6.5 0,3 -5.5,6.5 -4,0 -8.5,-3.5 -2.5,-3.5" fill="white"/></svg>`,
  // Gold Glove: gold circle + white "G"
  goldGlove: () => `<svg width="16" height="16" viewBox="-16 -16 32 32"><circle r="15" fill="#d97706"/><text x="0" y="6" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-weight="900" font-size="17" fill="white">G</text></svg>`,
  // Silver Slugger: silver circle + white "S"
  silverSlugger: () => `<svg width="16" height="16" viewBox="-16 -16 32 32"><circle r="15" fill="#94a3b8"/><text x="0" y="6" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-weight="900" font-size="17" fill="white">S</text></svg>`,
  // MVP: amber circle + white trophy
  mvp: () => `<svg width="16" height="16" viewBox="-16 -16 32 32"><circle r="15" fill="#f59e0b"/><rect x="-9" y="4" width="18" height="4" rx="1" fill="white"/><polyline points="-9,4 -9,-7 -4,0 0,-9 4,0 9,-7 9,4" fill="none" stroke="white" stroke-width="2" stroke-linejoin="round"/><circle cx="-4" cy="6" r="1.2" fill="white"/><circle cx="0" cy="6" r="1.2" fill="white"/><circle cx="4" cy="6" r="1.2" fill="white"/></svg>`,
  // Cy Young: blue circle + white "C"
  cyYoung: () => `<svg width="16" height="16" viewBox="-16 -16 32 32"><circle r="15" fill="#1565d8"/><text x="0" y="6" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-weight="900" font-size="17" fill="white">C</text></svg>`,
};

// Positions around the circle for each award
const AWARD_POSITIONS = [
  { key:'allStar',       style:'top:-5px;left:-5px' },
  { key:'goldGlove',     style:'top:-5px;right:-5px' },
  { key:'silverSlugger', style:'bottom:-5px;left:-5px' },
  { key:'mvp',           style:'bottom:-5px;right:-5px' },
  { key:'cyYoung',       style:'top:50%;left:-8px;transform:translateY(-50%)' },
];

function awardPipsHTML(pid) {
  const a = playerAwardState(pid);
  if (!a) return '';
  return AWARD_POSITIONS
    .filter(p => a[p.key])
    .map(p => `<span class="award-pip" style="${p.style}">${AWARD_SVGS[p.key]()}</span>`)
    .join('');
}

function awardInlineBadges(pid) {
  const a = playerAwardState(pid);
  if (!a) return '';
  return Object.entries(AWARD_SVGS)
    .filter(([key]) => a[key])
    .map(([key, fn]) => `<span class="award-inline-badge" title="${key}" style="margin-left:2px">${fn()}</span>`)
    .join('');
}

function restDotHTML(days) {
  if (days === null || days === undefined) return '';
  const cls = days <= 0 ? 'rest-0' : days === 1 ? 'rest-1' : days === 2 ? 'rest-2' : 'rest-3';
  const label = days <= 0 ? 'Pitched today' : days === 1 ? '1d rest' : `${days}d rest`;
  return `<span class="rest-dot ${cls}">${label}</span>`;
}

// ── Affiliate links (brand-safe: tickets + team gear) ─────────────────────
// Revenue plumbing. To monetize: create SeatGeek / Fanatics affiliate accounts
// and replace the destination builders below with your tracking/deep links.
// `q` is the URL-encoded team name. Set enabled:false to hide the row.
const AFFILIATE = {
  enabled: false,   // hidden for now — flip to true to bring the affiliate row back
  tickets: q => `https://seatgeek.com/search?q=${q}`,
  gear:    q => `https://www.fanatics.com/search?query=${q}`,
};

function affiliateRowHTML(meta) {
  if (!AFFILIATE.enabled || !meta?.name) return '';
  const q = encodeURIComponent(meta.name);
  return `<div class="aff-row">
    <a class="aff-link" href="${AFFILIATE.tickets(q)}" target="_blank" rel="sponsored noopener" aria-label="${meta.name} tickets">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z"/><path d="M13 5v14"/></svg>
      Tickets
    </a>
    <a class="aff-link" href="${AFFILIATE.gear(q)}" target="_blank" rel="sponsored noopener" aria-label="Shop ${meta.name} gear">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23Z"/></svg>
      Shop gear
    </a>
    <span class="aff-note">Sponsored</span>
  </div>`;
}

// ── Narrative badges ────────────────────────────────────────────────────────
function getNarrativeBadges(stats, lgAvg, pa, opsLast30) {
  if (!stats || !lgAvg || pa < 40) return [];

  // Fallback constants if dynamic rates not yet available (early season)
  const lgHRPA = lgAvg.hrPA || 0.032;
  const lgSBAttPA = lgAvg.sbAttPA || 0.010;
  const lgSOPA = lgAvg.soPA || 0.225;
  const lgBBPA = lgAvg.bbPA || 0.085;

  const avg  = parseFloat(stats.avg)  || 0;
  const obp  = parseFloat(stats.obp)  || 0;
  const slg  = parseFloat(stats.slg)  || 0;
  const ops  = parseFloat(stats.ops)  || 0;
  const hr   = parseInt(stats.homeRuns)      || 0;
  const sb   = parseInt(stats.stolenBases)   || 0;
  const cs   = parseInt(stats.caughtStealing)|| 0;
  const so   = parseInt(stats.strikeOuts)    || 0;
  const bb   = parseInt(stats.baseOnBalls || stats.walks) || 0;
  const risp = parseFloat(stats.avgWithRISP || stats.rISP || 0) || 0;

  const hrPA  = pa > 0 ? hr / pa : 0;
  const bbPA  = pa > 0 ? bb / pa : 0;
  const soPA  = pa > 0 ? so / pa : 0;
  const sbAtt = sb + cs;
  const sbAttPA = pa > 0 ? sbAtt / pa : 0;

  const badges = [];
  const has = k => badges.includes(k);

  // Habilidad: Power Hitter: HR rate ≥115% liga
  if (pa >= 60 && hrPA >= lgHRPA * 1.15 && !has('Contact Hitter'))
    badges.push('Power Hitter');

  // Habilidad: Contact Hitter: AVG ≥ liga+.025
  if (pa >= 75 && avg >= lgAvg.avg + 0.025 && !has('Power Hitter'))
    badges.push('Contact Hitter');

  // Habilidad: Patient Hitter: BB rate ≥125% liga + OBP ≥ liga+.020
  if (pa >= 60 && bbPA >= lgBBPA * 1.25 && obp >= lgAvg.obp + 0.020)
    badges.push('Patient Hitter');

  // Habilidad: Base Stealer: CS% ≤25% con al menos 4 intentos
  if (sbAtt >= 4 && cs / Math.max(sbAtt, 1) <= 0.25)
    badges.push('Base Stealer');

  // Descriptivo: Speed Threat: intentos de robo ≥250% liga + ≥4 intentos
  if (pa >= 40 && sbAtt >= 4 && sbAttPA >= lgSBAttPA * 2.5 && !has('Base Stealer'))
    badges.push('Speed Threat');

  // Descriptivo: Table Setter: OBP ≥ liga+.030 + HR rate ≤65% liga
  if (pa >= 60 && obp >= lgAvg.obp + 0.030 && hrPA <= lgHRPA * 0.65)
    badges.push('Table Setter');

  // Descriptivo: All-or-Nothing: K rate ≥115% liga + HR rate ≥105% liga
  if (pa >= 75 && soPA >= lgSOPA * 1.15 && hrPA >= lgHRPA * 1.05)
    badges.push('All-or-Nothing');

  // Descriptivo: Complete Hitter: contacto + poder + disciplina
  if (pa >= 75 && avg >= lgAvg.avg + 0.020 && hrPA >= lgHRPA * 1.10 && bbPA >= lgBBPA * 1.10)
    badges.push('Complete Hitter');

  // Descriptivo: Empty Average: AVG ≥ liga+.025 pero SLG ≤ liga
  if (pa >= 80 && avg >= lgAvg.avg + 0.025 && slg <= lgAvg.slg && !has('Power Hitter') && !has('Complete Hitter'))
    badges.push('Empty Average');

  // Descriptivo: Clutch Hitter: AVG RISP ≥ AVG+.035
  if (pa >= 100 && risp > 0 && risp >= avg + 0.035)
    badges.push('Clutch Hitter');

  // Descriptivo: Undisciplined: OBP < AVG+.025 o SO/BB ≥2.8
  if (pa >= 60 && (obp < avg + 0.025 || (bb > 0 && so/bb >= 2.8)))
    badges.push('Undisciplined');

  // Descriptivo: On Fire: OPS últimos 30d vs temporada ≥ +.095
  if (opsLast30 != null && ops > 0 && opsLast30 - ops >= 0.095)
    badges.push('On Fire');

  return badges.slice(0, 3);
}

function getPitcherNarrativeBadges(p, role) {
  const s = p.stats || {};
  const era  = parseFloat(s.era)  || 0;
  const whip = parseFloat(s.whip) || 0;
  const ip   = parseFloat(s.inningsPitched) || 0;
  const gs   = parseInt(s.gamesStarted)     || 0;
  const so   = parseInt(s.strikeOuts)       || 0;
  const bb   = parseInt(s.baseOnBalls)      || 0;
  const sv   = parseInt(s.saves)            || 0;
  const svo  = parseInt(s.saveOpportunities)|| 0;
  const hld  = parseInt(s.holds)            || 0;
  const gp   = parseInt(s.gamesPitched)     || 0;

  // Dynamic league pitching rates (fallback to 2026 constants)
  const lg = (leagueTeamStatsCache || {})._leaguePitch || { era:4.10, whip:1.28, k9:8.5, bb9:3.2, ipPerApp:1.30 };

  const k9  = ip > 0 ? (so/ip)*9 : 0;
  const bb9 = ip > 0 ? (bb/ip)*9 : 0;
  const ipPS = gs > 0 ? ip/gs : 0;
  const ipPerApp = gp > 0 ? ip/gp : 0;
  const svPct = svo > 0 ? sv/svo : 0;

  const badges = [];

  if (k9 >= lg.k9 * 1.10 && gp >= 3 && ip >= 5)
    badges.push('Strikeout Artist');

  if (bb9 <= lg.bb9 * 0.80 && gp >= 3 && ip >= 5)
    badges.push('Control Specialist');

  if (role === 'SP' && gs >= 2) {
    if (era > 0 && era <= lg.era * 0.85 && whip <= lg.whip * 0.90 && ipPS >= 5.8)
      badges.push('Ace');
    else if (era > 0 && era <= lg.era * 0.95 && whip <= lg.whip * 0.95 && ipPS >= 5.2)
      badges.push('Quality Starter');

    if (ipPS >= 6.2)
      badges.push('Workhorse');
    if (era >= lg.era * 1.15 && gs >= 3)
      badges.push('Vulnerable');

  } else if (role === 'CL' && gp >= 3) {
    if (era > 0 && era <= lg.era * 0.85 && svPct >= 0.85 && svo >= 1)
      badges.push('Elite Closer');
    else if (era > 0 && era <= lg.era && svPct >= 0.75 && svo >= 1)
      badges.push('Reliable Closer');
    if (sv >= 1 && era > 0 && era <= lg.era * 0.75 && whip <= lg.whip * 0.85)
      badges.push('Lockdown Closer');
    if (era >= lg.era * 1.10 && whip >= lg.whip * 1.10)
      badges.push('Shaky');

  } else if (role === 'RP' && gp >= 5) {
    if (hld >= 2 && era > 0 && era <= lg.era * 0.95)
      badges.push('Setup Man');
    if (gs <= 2 && ipPerApp >= lg.ipPerApp * 1.20)
      badges.push('Swing Man');
    if (era >= lg.era * 1.10 && whip >= lg.whip * 1.10)
      badges.push('Shaky');
    if (era >= lg.era * 1.15 && gp >= 8)
      badges.push('Vulnerable');
  }

  return badges.slice(0, 2);
}

function narrativeBadgesHTML(badges) {
  if (!badges || !badges.length) return '';
  return `<div class="narrative-badges-row">${
    badges.map(b => {
      const tone = HITTER_BADGE_TONES[b];
      return `<span class="narrative-badge ${tone ? tone : ''}">${b}</span>`;
    }).join('')
  }</div>`;
}

function playerDetailHTML(p, type, roleOrPos) {
  const isHitter = type === 'hitter';
  const barVal   = isHitter ? p.ops : p.score;
  const maxVal   = isHitter ? 1.2 : 100;
  const barWidth = Math.min(100, Math.round((barVal / maxVal) * 100));
  const color    = getDiamondPlayerColor(barVal, isHitter ? 'hitter' : 'pitcher');
  const s        = p.stats || {};
  const barLabel = isHitter ? 'OPS' : 'FORM';
  const barDisp  = isHitter ? (barVal > 0 ? barVal.toFixed(3) : '—') : (barVal != null ? Math.max(0, barVal) : '—');

  let statsLine = '';
  if (isHitter) {
    statsLine = formatSeasonHitterSummary(s);
  } else if (roleOrPos === 'SP') {
    const qsVal = s.qualityStarts != null ? s.qualityStarts : (p.qualityStarts || null);
    const qs = qsVal != null ? ` · QS ${qsVal}` : '';
    statsLine = `ERA ${s.era||'—'} · WHIP ${s.whip||'—'} · IP ${s.inningsPitched||'—'}<br>GS ${s.gamesStarted??'—'}${qs}`;
  } else if (roleOrPos === 'CL') {
    statsLine = `ERA ${s.era||'—'} · WHIP ${s.whip||'—'} · SV ${s.saves??'—'} · SVO ${s.saveOpportunities??'—'}`;
  } else {
    statsLine = `ERA ${s.era||'—'} · WHIP ${s.whip||'—'} · HLD ${s.holds??'—'} · IP ${s.inningsPitched||'—'}`;
  }

  const throwsCode = p.throws || '?';
  const handBadge = isHitter
    ? (p.bats && p.bats !== '?' ? `<span class="hand-badge${p.bats==='L'?' lhb':p.bats==='S'?' swi':''}">${p.bats==='L'?'LHB':p.bats==='S'?'SWI':'RHB'}</span>` : '')
    : (throwsCode !== '?' ? `<span class="hand-badge ${throwsCode==='L'?'lhp':''}">${throwsCode==='L'?'LHP':'RHP'}</span>` : '');

  // Secondary positions: native roster pos first (green), then by appearances desc
  let secPosBadges = '';
  if (isHitter && p.posCount) {
    const VALID_POS = new Set(['C','1B','2B','SS','3B','LF','CF','RF','DH']);
    const nativePos = p.truePrimaryPos || null;
    const allPos = Object.entries(p.posCount)
      .filter(([pos, count]) => VALID_POS.has(pos) && count >= 2)
      .sort((a, b) => {
        const aNative = a[0] === nativePos ? 1 : 0;
        const bNative = b[0] === nativePos ? 1 : 0;
        if (bNative !== aNative) return bNative - aNative;
        return b[1] - a[1];
      })
      .slice(0, 3)
      .map(([pos]) => pos);
    secPosBadges = allPos.map(pos => {
      const isNative = pos === nativePos;
      const isCurrent = pos === roleOrPos;
      const style = isNative
        ? 'background:rgba(22,163,74,.12);color:var(--win);border-color:rgba(22,163,74,.3);'
        : isCurrent
          ? 'background:rgba(21,101,216,.1);color:var(--accent);border-color:rgba(21,101,216,.25);'
          : '';
      return `<span class="sec-pos-badge" style="${style}">${pos}</span>`;
    }).join('');
  }
  const rookieBadge = p.isRookie ? `<span class="rookie-badge">R</span>` : '';
  const restBadge = (!isHitter && p.restDays !== null && p.restDays !== undefined)
    ? restDotHTML(p.restDays) : '';

  // Trend vs career — skip for rookies (no prior career data)
  let trendBadge = '';
  if (!p.isRookie) {
    if (isHitter) {
      const career = careerStatsCache[p.id];
      if (career?.ops && p.ops) trendBadge = trendBadgeHTML(p.ops, career.ops, 'ops');
    } else {
      const career = careerStatsCache[p.id];
      if (career?.formaScore != null && p.score != null) {
        trendBadge = trendFormaHTML(p.score, career.formaScore);
      }
    }
  }

  // Narrative badges (purple)
  let narrativeHTML = '';
  if (isHitter) {
    const lgAvg = (leagueTeamStatsCache || {})._leagueAvg || { avg:0.245, obp:0.315, slg:0.405 };
    const pa = parseInt(p.stats?.plateAppearances || p.stats?.atBats || 0);
    // Use last-30d OPS vs season OPS for "En racha" (more reliable than career)
    const opsLast30 = recentHittingCache[p.id] ?? null;
    const nbadges = getNarrativeBadges(p.stats, lgAvg, pa, opsLast30);
    narrativeHTML = narrativeBadgesHTML(nbadges.slice(0, 3));
  } else {
    narrativeHTML = narrativeBadgesHTML(getPitcherNarrativeBadges(p, roleOrPos));
  }

  return `<div class="impact-row">
    <div class="impact-row-left">
      <img class="impact-photo" src="${p.photoUrl}" style="background:${teamPhotoBg(selectedTeamId)}" alt="${p.name}"
        onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
      <div class="impact-name-block">
        <div class="impact-name">${p.name} ${handBadge}${secPosBadges}${rookieBadge}${p.tradedIn ? '<span class="traded-badge">TRADE</span>' : ''}${p.isRookie ? '' : awardInlineBadges(p.id)}${restBadge}</div>
        <div class="impact-stats-line">${statsLine}</div>
        ${narrativeHTML}
      </div>
    </div>
    <div class="impact-bar-val-wrap">
      <span class="impact-bar-label">${barLabel}</span>
      <span class="impact-bar-val" style="color:${statTextColor(color)}">${barDisp}</span>
      <div class="impact-bar-block">
        <div class="impact-bar-bg"><div class="impact-bar-fill" style="width:${barWidth}%;background:${color}"></div></div>
      </div>
      ${trendBadge ? `<div style="margin-top:3px;text-align:right">${trendBadge}</div>` : ''}
      ${seasonDotsHTML(p.id, isHitter ? 'hitter' : 'pitcher')}
    </div>
  </div>`;
}

function formatSeasonHitterSummary(stats) {
  const s = stats || {};
  const avg = s.avg || '.---';
  const parts = [`AVG ${avg}`];
  const extras = [];

  const hr = parseInt(s.homeRuns) || 0;
  const rbi = parseInt(s.rbi) || 0;
  const sb = parseInt(s.stolenBases) || 0;
  const runs = parseInt(s.runs) || 0;
  const hits = parseInt(s.hits) || 0;
  const walks = parseInt(s.baseOnBalls ?? s.walks) || 0;
  const so = parseInt(s.strikeOuts) || 0;
  const pa = parseInt(s.plateAppearances || s.atBats) || 0;
  const obp = parseFloat(s.obp) || 0;
  const slg = parseFloat(s.slg) || 0;
  const kPct = pa > 0 ? (so / pa) * 100 : 0;

  if (hr > 0) extras.push(`HR ${hr}`);
  if (rbi > 0) extras.push(`RBI ${rbi}`);
  if (sb > 0) extras.push(`SB ${sb}`);

  if (obp >= 0.340) extras.push(`OBP ${obp.toFixed(3)}`);
  if (slg >= 0.430) extras.push(`SLG ${slg.toFixed(3)}`);
  if (pa >= 40 && kPct > 0 && kPct <= 18) extras.push(`K% ${kPct.toFixed(1)}`);
  if (runs >= 10) extras.push(`R ${runs}`);

  if (!extras.length) {
    if (obp > 0) extras.push(`OBP ${obp.toFixed(3)}`);
    if (slg > 0) extras.push(`SLG ${slg.toFixed(3)}`);
    if (runs > 0) extras.push(`R ${runs}`);
    if (walks > 0) extras.push(`BB ${walks}`);
    if (hits > 0) extras.push(`H ${hits}`);
  }

  return parts.concat(extras.slice(0, 3)).join(' · ');
}

function renderTeamStatsPanel(teamId, impact) {
  const map = leagueTeamStatsCache || {};
  const mine = map[teamId];
  if (!mine) return '';

  // Build arrays for ranking
  const allTeams = Object.entries(map).filter(([k]) => !k.startsWith('_'));
  function rank(key, lowerBetter = false) {
    // Sort best→worst: for lowerBetter asc (lowest ERA = rank 1), for higherBetter desc (highest AVG = rank 1)
    const vals = allTeams.map(([,v]) => v[key]).filter(x => x && x > 0).sort((a,b) => lowerBetter ? a-b : b-a);
    const myVal = mine[key];
    if (!myVal) return { rank: '—', total: vals.length, pct: 0.5 };
    // findIndex of first element that is at least as good as myVal
    const pos = vals.findIndex(v => lowerBetter ? v >= myVal : v <= myVal);
    const r = pos === -1 ? vals.length : pos + 1;
    const total = vals.length;
    // pct: 1 = best (rank 1), 0 = worst (rank total)
    const pct = total > 1 ? (total - r) / (total - 1) : 1;
    return { rank: r, total, pct };
  }

  function rankBadge(r) {
    if (r.rank === '—') return '<span class="team-stat-rank mid">—</span>';
    const t = rankTier(r);
    return `<span class="team-stat-rank" style="background:${t.bar}26;color:${t.text}">#${r.rank} / ${r.total}</span>`;
  }

  function leagueBar(key, lowerBetter = false, color, rankObj) {
    const vals = allTeams.map(([,v]) => v[key]).filter(x => x && x > 0);
    if (!vals.length) return '';
    const myVal = mine[key] || 0;
    const minVal = Math.min(...vals), maxVal = Math.max(...vals);
    const range = maxVal - minVal || 1;
    // Fill based on rank: rank 1 = 100%, rank last = ~5%
    const total = rankObj?.total || vals.length;
    const rk = (rankObj?.rank === '—' ? total : rankObj?.rank) || total;
    const fillPct = Math.max(5, Math.round(((total - rk + 1) / total) * 100));
    const decimals = key === 'era' || key === 'whip' ? 2 : 3;
    // worst label on left, best label on right
    const leftLabel = lowerBetter ? maxVal.toFixed(decimals) : minVal.toFixed(decimals).replace(/^0/,'');
    const rightLabel = lowerBetter ? minVal.toFixed(decimals) : maxVal.toFixed(decimals).replace(/^0/,'');
    return `<div class="team-stat-bar-wrap" style="margin-top:2px">
      <div class="team-stat-bar-fill" style="width:${fillPct}%;background:${color}"></div>
      <div style="display:flex;justify-content:space-between;margin-top:3px;margin-bottom:8px">
        <span style="font-size:10px;color:var(--muted);font-family:'Barlow Condensed';opacity:.6">${leftLabel}</span>
        <span style="font-size:10px;color:var(--muted);font-family:'Barlow Condensed';opacity:.6">${rightLabel}</span>
      </div>
    </div>`;
  }


  // Player color scale by rank quintile: 1-6 green, 7-12 light green,
  // 13-18 yellow, 19-24 orange, 25-30 red. `bar` is the exact scale color
  // (fills/badges); `text` is a darkened variant readable on white.
  function rankTier(r) {
    if (r.rank === '—') return { bar: '#9ca3af', text: '#6b7280' };
    const rk = r.rank;
    if (rk <= 6)  return { bar: '#16a34a', text: '#16a34a' };
    if (rk <= 12) return { bar: '#b1c882', text: '#7d9440' };
    if (rk <= 18) return { bar: '#ffc000', text: '#c29200' };
    if (rk <= 24) return { bar: '#ff8100', text: '#e06f00' };
    return { bar: '#ff2200', text: '#e51f00' };
  }

  const avgR  = rank('avg');  const opsR  = rank('ops');
  const eraR  = rank('era', true); const whipR = rank('whip', true);

  const avgT  = rankTier(avgR);
  const opsT  = rankTier(opsR);
  const eraT  = rankTier(eraR);
  const whipT = rankTier(whipR);

  // Innings split — use SP/RP breakdown calculated from classified pitchers' season stats
  const spSeasonIp    = impact?.spSeasonIp    || 0;
  const totalSeasonIp = impact?.totalSeasonIp || 0;
  const spPct = totalSeasonIp > 0 ? Math.round((spSeasonIp / totalSeasonIp) * 100) : 0;
  const rpPct = 100 - spPct;
  // Translate to "of 9 innings"
  const spInnings = (spPct / 100 * 9).toFixed(1);
  const rpInnings = (rpPct / 100 * 9).toFixed(1);

  // Narrative stats
  return `<div class="team-stats-panel">
    <div class="team-stats-title">Team Stats vs League</div>
    <div class="team-stats-grid" style="grid-template-columns:1fr 1fr">
      <div style="grid-column:1;display:flex;flex-direction:column;gap:8px">
        <div style="font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;padding-bottom:4px;border-bottom:1px solid var(--border)">BATTING</div>
        <div class="team-stat-row">
          <div class="team-stat-header">
            <span class="team-stat-label">AVG</span>
            <div style="display:flex;align-items:center;gap:5px">
              <span class="team-stat-val" style="color:${avgT.text}">${mine.avg ? mine.avg.toFixed(3).replace(/^0/,'') : '—'}</span>
              ${rankBadge(avgR)}
            </div>
          </div>
          ${leagueBar('avg', false, avgT.bar, avgR)}
        </div>
        <div class="team-stat-row">
          <div class="team-stat-header">
            <span class="team-stat-label">OPS</span>
            <div style="display:flex;align-items:center;gap:5px">
              <span class="team-stat-val" style="color:${opsT.text}">${mine.ops ? mine.ops.toFixed(3).replace(/^0/,'') : '—'}</span>
              ${rankBadge(opsR)}
            </div>
          </div>
          ${leagueBar('ops', false, opsT.bar, opsR)}
        </div>
      </div>
      <div style="grid-column:2;display:flex;flex-direction:column;gap:8px">
        <div style="font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;padding-bottom:4px;border-bottom:1px solid var(--border)">PITCHING</div>
        <div class="team-stat-row">
          <div class="team-stat-header">
            <span class="team-stat-label">ERA</span>
            <div style="display:flex;align-items:center;gap:5px">
              <span class="team-stat-val" style="color:${eraT.text}">${mine.era ? mine.era.toFixed(2) : '—'}</span>
              ${rankBadge(eraR)}
            </div>
          </div>
          ${leagueBar('era', true, eraT.bar, eraR)}
        </div>
        <div class="team-stat-row">
          <div class="team-stat-header">
            <span class="team-stat-label">WHIP</span>
            <div style="display:flex;align-items:center;gap:5px">
              <span class="team-stat-val" style="color:${whipT.text}">${mine.whip ? mine.whip.toFixed(2) : '—'}</span>
              ${rankBadge(whipR)}
            </div>
          </div>
          ${leagueBar('whip', true, whipT.bar, whipR)}
        </div>
      </div>
      ${totalSeasonIp > 0 ? `
      <div class="team-stat-row innings-split-row" style="grid-column:1/-1">
        <div class="innings-split-title">Innings by starters vs bullpen (out of 9)</div>
        <div class="innings-bar-wrap">
          <div class="innings-bar-sp" style="width:${spPct}%">${spPct >= 18 ? `SP ${spInnings}` : ''}</div>
          <div class="innings-bar-rp">${rpPct >= 18 ? `RP ${rpInnings}` : ''}</div>
        </div>
        <div class="innings-legend">
          <div class="innings-legend-item"><div class="innings-legend-dot" style="background:var(--accent-blue)"></div>Starters ${spInnings} inn (${spPct}%)</div>
          <div class="innings-legend-item"><div class="innings-legend-dot" style="background:#7aa9e6"></div>Bullpen ${rpInnings} inn (${rpPct}%)</div>
        </div>
      </div>` : ''}
    </div>
  </div>`;
}

function renderDiamondPanel(teamId, impact) {

  const panel = document.getElementById('diamondPanel');
  const meta = TEAM_META[teamId] || { name: `Team ${teamId}`, abbr: '?', logo: `https://www.mlbstatic.com/team-logos/${teamId}.svg`, color: '#1565d8' };
  const { hittersByPos, spList, clList, rpList, ilPlayers = [] } = impact;

  const DPOS = {
    'CF': { left:'50%', top: '8%' },
    'LF': { left:'18%', top:'22%' },
    'RF': { left:'82%', top:'22%' },
    'SS': { left:'36%', top:'42%' },
    '2B': { left:'64%', top:'42%' },
    '3B': { left:'20%', top:'58%' },
    '1B': { left:'80%', top:'58%' },
    'C':  { left:'50%', top:'78%' },
    'DH': { left:'86%', top:'78%' },
  };

  function fieldBtn(pos) {
    const key = `h-${pos}`;
    const players = hittersByPos[pos] || [];
    const p = players[0];
    const ops = p ? p.ops : 0;
    const color = p ? getDiamondPlayerColor(ops, 'hitter') : '#9ca3af';
    const shiny = isHistoricSeason('hitter', p) ? ' dfield-shiny' : '';
    const txtColor = diamondTextColor(color);
    const nameLabel = p ? p.name : '—';
    const rookieStar = p?.isRookie ? `<span style="position:absolute;top:-3px;right:-3px;width:14px;height:14px;border-radius:50%;background:#b45309;border:1.5px solid #fff;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;color:#fff;line-height:1">R</span>` : '';
    const pips = (p && !p.isRookie) ? awardPipsHTML(p.id) : '';
    const flagHtml = p?.flag ? `<span style="font-size:14px;line-height:1">${p.flag}</span>` : '';
    const xy = DPOS[pos];
    return `<button class="dfield-btn" id="pb-${key}"
      style="left:${xy.left};top:${xy.top};--btn-color:${color}"
      onclick="selectDiamondKey('${key}',${teamId})">
      <div class="dfield-circle${shiny}" style="background:${color};color:${txtColor};position:relative;flex-direction:column;gap:1px">${pips}${rookieStar}${tradedBadgeHTML(p?.tradedIn)}<span style="font-size:12px;font-weight:800;line-height:1">${pos}</span>${flagHtml}</div>
      <div class="dfield-pill">${nameLabel}</div>
    </button>`;
  }

  const fieldBtns = Object.keys(DPOS).map(pos => fieldBtn(pos)).join('');

  function pitcherGroupHTML(list, role, limit = 99) {
    if (!list.length) return '';
    const roleLabels = { SP:'STARTERS', CL:'CLOSERS', RP:'RELIEVERS' };
    const shown = list.slice(0, limit);

    const circles = shown.map((p, i) => {
      const key   = `p-${role}-${i}`;
      const color = getDiamondPlayerColor(p.score, 'pitcher');
      const shiny = isHistoricSeason('pitcher', p) ? ' dfield-shiny' : '';
      const txtColor = diamondTextColor(color);
      const label = p.throws !== '?' ? p.throws : role;
      const rookieStar = p.isRookie ? `<span style="position:absolute;top:-3px;right:-3px;width:14px;height:14px;border-radius:50%;background:#b45309;border:1.5px solid #fff;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;color:#fff;line-height:1">R</span>` : '';
      const pips = p.isRookie ? '' : awardPipsHTML(p.id);
      const flagHtml = p.flag ? `<span style="font-size:14px;line-height:1">${p.flag}</span>` : '';
      const restPart   = p.restDays !== null && p.restDays !== undefined ? restDotHTML(p.restDays) : '';
      const extras = restPart ? `<div style="display:flex;gap:3px;justify-content:center;flex-wrap:wrap">${restPart}</div>` : '';
      return `<button class="dfield-btn-inline" id="pb-${key}" style="--btn-color:${color}"
        onclick="selectDiamondKey('${key}',${teamId})">
        <div class="dfield-circle${shiny}" style="background:${color};color:${txtColor};position:relative;flex-direction:column;gap:1px">${pips}${rookieStar}${tradedBadgeHTML(p.tradedIn)}<span style="font-size:12px;font-weight:800;line-height:1">${label}</span>${flagHtml}</div>
        <div class="dfield-pill">${p.name}</div>
        ${extras}
      </button>`;
    }).join('');

    const details = shown.map((p, i) => {
      const key = `p-${role}-${i}`;
      return `<div class="pitcher-detail-card" id="detail-${key}" style="display:none">
        ${playerDetailHTML(p, 'pitcher', role)}
      </div>`;
    }).join('');

    return `<div class="pitcher-group-wrap">
      <div class="pitcher-group-label">${roleLabels[role]||role}</div>
      <div class="pitcher-circles-row">${circles}</div>
      ${details}
    </div>`;
  }

  // IL section
  let ilHTML = '';
  if (ilPlayers.length) {
    function ilRowHTML(p) {
      const color    = p.isPitcher ? getDiamondPlayerColor(p.score,'pitcher') : getDiamondPlayerColor(p.ops,'hitter');
      const val      = p.isPitcher
        ? (p.hasSeasonStats ? Math.max(0, p.score ?? 0) : '—')
        : (p.ops > 0 ? p.ops.toFixed(3) : '—');
      const barLabel = p.isPitcher ? 'FORM' : 'OPS';
      const barPct   = p.isPitcher ? Math.min(100,Math.round(p.score/100*100)) : Math.min(100,Math.round(p.ops/1.2*100));
      const s        = p.stats || {};
      const statsLine = p.isPitcher
        ? `ERA ${s.era||'—'} · WHIP ${s.whip||'—'} · IP ${s.inningsPitched||'—'}`
        : formatSeasonHitterSummary(s);
      const ilLabel = p.ilType
        .replace(/(\d+)[\s-]*day[\s-]*injured[\s-]*list/i,'$1d IL')
        .replace(/injured list/i,'IL');
      const daysRemainingBadge = (() => {
        if (p.daysRemaining === null || p.daysRemaining === undefined) return '';
        if (p.daysRemaining === 0) return `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(22,163,74,.12);color:var(--win);letter-spacing:.5px;margin-left:3px">✓ ELIGIBLE</span>`;
        const urgency = p.daysRemaining <= 7
          ? 'background:rgba(234,179,8,.15);color:#b45309'
          : 'background:rgba(220,38,38,.08);color:var(--loss)';
        return `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;${urgency};letter-spacing:.5px;margin-left:3px">${p.daysRemaining}d remaining</span>`;
      })();
      const posLabel = p.isPitcher ? (p.pos||'P') : (p.pos||'?');
      const ilCareer = careerStatsCache[p.id];
      let ilTrend = '';
      if (p.isPitcher && ilCareer?.formaScore != null && p.score != null) ilTrend = trendFormaHTML(p.score, ilCareer.formaScore);
      else if (!p.isPitcher && ilCareer?.ops && p.ops) ilTrend = trendBadgeHTML(p.ops, ilCareer.ops, 'ops');
      return `<div class="il-row">
        <div class="impact-row-left" style="grid-column:1;grid-row:1/3">
          <img class="impact-photo" src="${p.photoUrl}" style="background:${teamPhotoBg(selectedTeamId)}" alt="${p.name}"
            onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
          <div class="impact-name-block">
            <div class="impact-name" style="opacity:.8">${p.name}
              <span style="font-size:10px;font-weight:600;color:var(--muted)">${posLabel}</span>
              <span class="il-badge">${ilLabel}</span>${daysRemainingBadge}
            </div>
            <div class="impact-stats-line">${statsLine}</div>
          </div>
        </div>
        <div class="impact-bar-block" style="grid-column:2;grid-row:1;align-self:end;margin-bottom:2px">
          <div class="impact-bar-bg"><div class="impact-bar-fill" style="width:${barPct}%;background:${color};opacity:.6"></div></div>
        </div>
        <div class="impact-bar-val-wrap" style="grid-column:2;grid-row:2;align-self:start">
          <span class="impact-bar-label">${barLabel}</span>
          <span class="impact-bar-val" style="color:${statTextColor(color)};opacity:.7">${val}</span>
          ${ilTrend ? `<div style="margin-top:3px;text-align:right">${ilTrend}</div>` : ''}
          ${seasonDotsHTML(p.id, p.isPitcher ? 'pitcher' : 'hitter')}
        </div>
      </div>`;
    }

    const ilHitters  = ilPlayers.filter(p => !p.isPitcher);
    const ilPitchers = ilPlayers.filter(p =>  p.isPitcher);

    // IL players as colored circles (like the pitching staff) so the form/OPS
    // color mix is visible at a glance. Keys start with 'il-' so a click lands
    // on selectDiamondKey's generic detail-card branch (not the hitter branch).
    function ilGroupHTML(list, label, keyPrefix) {
      if (!list.length) return '';
      const circles = list.map((p, i) => {
        const key      = `${keyPrefix}-${i}`;
        const color    = p.isPitcher ? getDiamondPlayerColor(p.score,'pitcher') : getDiamondPlayerColor(p.ops,'hitter');
        const txtColor = diamondTextColor(color);
        const circleLabel = p.isPitcher ? (p.throws && p.throws !== '?' ? p.throws : 'P') : (p.pos||'?');
        const flagHtml = p.flag ? `<span style="font-size:14px;line-height:1">${p.flag}</span>` : '';
        const days = p.daysRemaining === 0
          ? `<span class="il-chip il-chip-ok">✓ ELIGIBLE</span>`
          : (p.daysRemaining ? `<span class="il-chip il-chip-out">${p.daysRemaining}d remaining</span>` : '');
        return `<button class="dfield-btn-inline" id="pb-${key}" style="--btn-color:${color}"
          onclick="selectDiamondKey('${key}',${teamId})">
          <div class="dfield-circle" style="background:${color};color:${txtColor};position:relative;flex-direction:column;gap:1px"><span style="font-size:12px;font-weight:800;line-height:1">${circleLabel}</span>${flagHtml}</div>
          <div class="dfield-pill">${p.name}</div>
          ${days}
        </button>`;
      }).join('');
      const details = list.map((p, i) =>
        `<div class="pitcher-detail-card" id="detail-${keyPrefix}-${i}" style="display:none">${ilRowHTML(p)}</div>`
      ).join('');
      return `<div class="pitcher-group-wrap">
        <div class="pitcher-group-label">${label}</div>
        <div class="pitcher-circles-row">${circles}</div>
        ${details}
      </div>`;
    }

    ilHTML = `<div class="il-section">
      <details class="il-accordion">
        <summary class="il-summary-row">
          <div class="il-section-title" style="margin-bottom:0">🏥 Injured List — ${ilPlayers.length} players</div>
          <svg class="il-summary-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </summary>
        <div style="margin-top:14px">
          ${ilGroupHTML(ilHitters, `Batters (${ilHitters.length})`, 'il-h')}
          ${ilGroupHTML(ilPitchers, `Pitchers (${ilPitchers.length})`, 'il-p')}
        </div>
      </details>
    </div>`;
  }

  // Some cap-on-dark logos clash with their own team-color banner — recolor them.
  const dpFx = ({ 111:'white', 138:'white', 137:'black', 134:'black', 121:'#FF5910' })[teamId];
  const dpCap = meta.logo.replace('/team-logos/', '/team-logos/team-cap-on-dark/');
  const dpLogo = dpFx === 'white' ? `<img class="dp-logo dp-logo-white" src="${dpCap}" alt="${meta.abbr}" onerror="this.onerror=null;this.src='${meta.logo}'">`
    : dpFx === 'black' ? `<img class="dp-logo dp-logo-black" src="${dpCap}" alt="${meta.abbr}" onerror="this.onerror=null;this.src='${meta.logo}'">`
    : dpFx ? `<span class="dp-logo dp-logo-tint" style="background:${dpFx};-webkit-mask:url('${dpCap}') center/contain no-repeat;mask:url('${dpCap}') center/contain no-repeat"></span>`
    : `<img class="dp-logo" src="${dpCap}" alt="${meta.abbr}" onerror="this.onerror=null;this.src='${meta.logo}'">`;

  panel.innerHTML = `
    <div class="diamond-panel-header" style="--dp-c1:${meta.color || '#1a2e1f'};--dp-c2:${shadeHex(meta.color || '#1a2e1f', 0.5)}">
      ${dpLogo}
      <div>
        <div class="dp-team-name">${meta.name}</div>
        <div class="dp-subtitle">SEASON IMPACT — ${CURRENT_YEAR}</div>
      </div>
    </div>
    ${affiliateRowHTML(meta)}
    ${renderTeamStatsPanel(teamId, impact)}

    <div class="diamond-box">
      <div class="diamond-section-label">Last Lineup</div>
      ${diamondColorLegendHTML()}
      <div class="dfield-container">
        <div class="dfield-rombo"></div>
        <div class="dfield-homeplate"></div>
        ${fieldBtns}
      </div>
      <div id="hitterDetailCard" style="display:none;margin-top:10px"></div>
    </div>

    <div class="pitcher-area">
      <div class="pitcher-area-title">Pitching Staff</div>
      ${pitcherGroupHTML(spList,'SP')}
      ${pitcherGroupHTML(clList,'CL')}
      ${pitcherGroupHTML(rpList,'RP')}
    </div>

    ${ilHTML}
  `;
}

function selectDiamondKey(key, teamId) {
  const impact = teamsImpactCache[teamId];
  if (!impact) return;

  if (selectedDiamondKey === key) {
    selectedDiamondKey = null;
    document.querySelectorAll('.dfield-btn, .dfield-btn-inline').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.pitcher-detail-card').forEach(c => c.style.display = 'none');
    const hCard = document.getElementById('hitterDetailCard');
    if (hCard) hCard.style.display = 'none';
    return;
  }

  document.querySelectorAll('.dfield-btn, .dfield-btn-inline').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.pitcher-detail-card').forEach(c => c.style.display = 'none');
  const hCard = document.getElementById('hitterDetailCard');
  if (hCard) hCard.style.display = 'none';

  selectedDiamondKey = key;
  const btn = document.getElementById(`pb-${key}`);
  if (btn) btn.classList.add('active');

  if (key.startsWith('h-')) {
    const pos = key.replace('h-', '');
    const players = impact.hittersByPos[pos] || [];
    if (!players.length || !hCard) return;
    const p = players[0];
    const alts = players.slice(1);
    let html = `<div class="impact-detail-card">
      ${playerDetailHTML(p, 'hitter', pos)}`;
    if (alts.length) {
      html += `<div class="alts-section-title">ALTERNATIVES</div>`;
      alts.forEach((a) => {
        html += playerDetailHTML(a, 'hitter', pos);
      });
    }
    html += `</div>`;
    hCard.innerHTML = html;
    hCard.style.display = 'block';

  } else {
    const detailEl = document.getElementById(`detail-${key}`);
    if (detailEl) detailEl.style.display = 'block';
  }
}

// ── League-wide team stats cache ──────────────────────────────────────────
let leagueTeamStatsCache = null; // { teamId: { avg, ops, era, whip, spIp, totalIp } }

async function fetchLeagueTeamStats() {
  if (leagueTeamStatsCache) return leagueTeamStatsCache;
  try {
    const [hitRes, pitchRes] = await Promise.all([
      fetchWithTimeout(`${MLB_API}/teams/stats?season=${CURRENT_YEAR}&sportId=1&group=hitting&stats=season&gameType=R`).then(r=>r.json()).catch(()=>({stats:[]})),
      fetchWithTimeout(`${MLB_API}/teams/stats?season=${CURRENT_YEAR}&sportId=1&group=pitching&stats=season&gameType=R`).then(r=>r.json()).catch(()=>({stats:[]})),
    ]);
    const map = {};
    const hitSplits = hitRes.stats?.[0]?.splits || [];
    hitSplits.forEach(s => {
      const id = s.team?.id; if (!id) return;
      map[id] = map[id] || {};
      map[id].avg = parseFloat(s.stat?.avg) || 0;
      map[id].ops = parseFloat(s.stat?.ops) || 0;
      map[id].obp = parseFloat(s.stat?.obp) || 0;
      map[id].slg = parseFloat(s.stat?.slg) || 0;
    });
    // Compute league-wide averages for narrative badge thresholds
    // Fallbacks use 2026 MLB historical constants
    const FALLBACK_HIT = { avg:0.245, obp:0.315, slg:0.405, ops:0.720, hrPA:0.032, sbPA:0.008, sbAttPA:0.010, soPA:0.225, bbPA:0.085 };
    const FALLBACK_PITCH = { era:4.10, whip:1.28, k9:8.5, bb9:3.2, ipPerApp:1.30 };

    const lgAccum = { avg:0, obp:0, slg:0, ops:0, hr:0, pa:0, sb:0, cs:0, so:0, bb:0, n:0 };
    hitSplits.forEach(s => {
      if (!s.stat?.avg) return;
      lgAccum.avg += parseFloat(s.stat.avg)||0;
      lgAccum.obp += parseFloat(s.stat.obp)||0;
      lgAccum.slg += parseFloat(s.stat.slg)||0;
      lgAccum.ops += parseFloat(s.stat.ops)||0;
      lgAccum.hr  += parseInt(s.stat.homeRuns)||0;
      lgAccum.pa  += parseInt(s.stat.plateAppearances)||0;
      lgAccum.sb  += parseInt(s.stat.stolenBases)||0;
      lgAccum.cs  += parseInt(s.stat.caughtStealing)||0;
      lgAccum.so  += parseInt(s.stat.strikeOuts)||0;
      lgAccum.bb  += parseInt(s.stat.walks ?? s.stat.baseOnBalls)||0;
      lgAccum.n++;
    });
    if (lgAccum.n && lgAccum.pa > 0) {
      const n = lgAccum.n;
      map._leagueAvg = {
        avg:  lgAccum.avg/n,
        obp:  lgAccum.obp/n,
        slg:  lgAccum.slg/n,
        ops:  lgAccum.ops/n,
        hrPA: lgAccum.hr / lgAccum.pa,
        sbPA: lgAccum.sb / lgAccum.pa,
        sbAttPA: (lgAccum.sb + lgAccum.cs) / lgAccum.pa,
        soPA: lgAccum.so / lgAccum.pa,
        bbPA: lgAccum.bb / lgAccum.pa,
      };
    } else {
      map._leagueAvg = { ...FALLBACK_HIT };
    }

    const pitchSplits = pitchRes.stats?.[0]?.splits || [];
    const lgPitch = { era:0, whip:0, k9:0, bb9:0, ipPerApp:0, ip:0, n:0 };
    pitchSplits.forEach(s => {
      const id = s.team?.id; if (!id) return;
      map[id] = map[id] || {};
      map[id].era  = parseFloat(s.stat?.era)  || 0;
      map[id].whip = parseFloat(s.stat?.whip) || 0;
      map[id].spIp    = parseFloat(s.stat?.inningsPitchedStart) || 0;
      map[id].totalIp = parseFloat(s.stat?.inningsPitched)      || 0;
      // Accumulate for league pitching averages
      const ip = parseFloat(s.stat?.inningsPitched)||0;
      if (ip > 0) {
        lgPitch.era  += parseFloat(s.stat?.era)||0;
        lgPitch.whip += parseFloat(s.stat?.whip)||0;
        const so = parseInt(s.stat?.strikeOuts)||0;
        const bb = parseInt(s.stat?.baseOnBalls)||0;
        const gp = parseInt(s.stat?.gamesPitched)||0;
        lgPitch.k9   += ip > 0 ? (so/ip)*9 : 0;
        lgPitch.bb9  += ip > 0 ? (bb/ip)*9 : 0;
        lgPitch.ipPerApp += gp > 0 ? ip/gp : 0;
        lgPitch.n++;
      }
    });
    if (lgPitch.n) {
      const n = lgPitch.n;
      map._leaguePitch = { era: lgPitch.era/n, whip: lgPitch.whip/n, k9: lgPitch.k9/n, bb9: lgPitch.bb9/n, ipPerApp: lgPitch.ipPerApp/n };
    } else {
      map._leaguePitch = { ...FALLBACK_PITCH };
    }
    leagueTeamStatsCache = map;
    return map;
  } catch(e) { return {}; }
}

// ── Career stats cache (for trend detection) ──────────────────────────────
const careerStatsCache = {};
const recentPitchingCache = {};
// Per-season history for the last 5 years: { pid: { hit: {year: ops}, pitch: {year: formaScore} } }
const seasonHistoryCache = {};

const ROOKIE_AB_LIMIT = 130;
const ROOKIE_IP_LIMIT = 50;
const NON_ROOKIE_OVERRIDES = new Set([
  808963, // Roki Sasaki: exceeded rookie service-time limit in 2025 despite low IP.
]);

function inningsToOuts(ip) {
  if (ip == null) return 0;
  const [wholeRaw, fracRaw = '0'] = String(ip).split('.');
  const whole = parseInt(wholeRaw, 10) || 0;
  const frac = parseInt(fracRaw, 10) || 0;
  return whole * 3 + (frac === 1 || frac === 2 ? frac : 0);
}

function outsToInnings(outs) {
  return (outs || 0) / 3;
}

function priorSeasonSplits(person, groupName) {
  return (person.stats || [])
    .find(g => g.group?.displayName?.toLowerCase() === groupName && g.type?.displayName?.toLowerCase() === 'yearbyyear')
    ?.splits
    ?.filter(sp => parseInt(sp.season, 10) < CURRENT_YEAR) || [];
}

function summarizePriorHitting(person) {
  const totals = priorSeasonSplits(person, 'hitting').reduce((acc, sp) => {
    const s = sp.stat || {};
    acc.ab += parseInt(s.atBats, 10) || 0;
    acc.h += parseInt(s.hits, 10) || 0;
    acc.d += parseInt(s.doubles, 10) || 0;
    acc.t += parseInt(s.triples, 10) || 0;
    acc.hr += parseInt(s.homeRuns, 10) || 0;
    acc.bb += parseInt(s.baseOnBalls, 10) || 0;
    acc.hbp += parseInt(s.hitByPitch, 10) || 0;
    acc.sf += parseInt(s.sacFlies, 10) || 0;
    return acc;
  }, { ab:0, h:0, d:0, t:0, hr:0, bb:0, hbp:0, sf:0 });
  const singles = Math.max(0, totals.h - totals.d - totals.t - totals.hr);
  const tb = singles + 2 * totals.d + 3 * totals.t + 4 * totals.hr;
  const obpDen = totals.ab + totals.bb + totals.hbp + totals.sf;
  const obp = obpDen > 0 ? (totals.h + totals.bb + totals.hbp) / obpDen : 0;
  const slg = totals.ab > 0 ? tb / totals.ab : 0;
  return {
    careerAB: totals.ab,
    avg: totals.ab > 0 ? totals.h / totals.ab : 0,
    ops: obp + slg,
  };
}

function summarizePriorPitching(person) {
  const totals = priorSeasonSplits(person, 'pitching').reduce((acc, sp) => {
    const s = sp.stat || {};
    acc.outs += inningsToOuts(s.inningsPitched);
    acc.er += parseInt(s.earnedRuns, 10) || 0;
    acc.h += parseInt(s.hits, 10) || 0;
    acc.bb += parseInt(s.baseOnBalls, 10) || 0;
    return acc;
  }, { outs:0, er:0, h:0, bb:0 });
  const ip = outsToInnings(totals.outs);
  const era = ip > 0 ? (totals.er * 9) / ip : 0;
  const whip = ip > 0 ? (totals.h + totals.bb) / ip : 0;
  return {
    careerIP: ip,
    era,
    whip,
    formaScore: ip > 0 ? calcBaseScore(era, whip) : null,
  };
}

function isRookieCareerEligible(pid, career, role = 'both') {
  if (!pid || NON_ROOKIE_OVERRIDES.has(pid)) return false;
  if (!career) return true;
  if (career.debutYear && career.debutYear < CURRENT_YEAR - 1) return false;
  if (role === 'hitter') return (career.careerAB ?? 0) < ROOKIE_AB_LIMIT;
  if (role === 'pitcher') return (career.careerIP ?? 0) < ROOKIE_IP_LIMIT;
  return (career.careerAB ?? 0) < ROOKIE_AB_LIMIT && (career.careerIP ?? 0) < ROOKIE_IP_LIMIT;
}

function isRookieEligible(pid, role = 'both') {
  return isRookieCareerEligible(pid, careerStatsCache[pid], role);
}

// Cache for last-30d hitter stats (for "En racha" badge)
const recentHittingCache = {};

async function fetchRecentHitting(pids) {
  const missing = pids.filter(id => !(id in recentHittingCache));
  if (!missing.length) return;
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  // Batch in chunks of 20
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i+20).join(',');
    await fetchWithTimeout(
      `${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=byDateRange,group=hitting,startDate=${startDate},endDate=${endDate},season=${CURRENT_YEAR})`
    ).then(r => r.json()).then(d => {
      (d.people || []).forEach(p => {
        const s = p.stats?.find(g => g.group?.displayName?.toLowerCase() === 'hitting')?.splits?.[0]?.stat;
        recentHittingCache[p.id] = s ? parseFloat(s.ops)||0 : null;
      });
    }).catch(() => {
      missing.slice(i, i+20).forEach(id => { recentHittingCache[id] = null; });
    });
  }
}

async function fetchRecentPitching(pids) {
  const missing = pids.filter(id => !(id in recentPitchingCache));
  if (!missing.length) return;
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0];
  await Promise.all(missing.map(pid =>
    fetchWithTimeout(`${MLB_API}/people/${pid}/stats?stats=byDateRange&group=pitching&startDate=${startDate}&endDate=${endDate}&season=${CURRENT_YEAR}`)
      .then(r => r.json()).then(d => {
        const s = d.stats?.find(g => g.group?.displayName === 'pitching')?.splits?.[0]?.stat;
        recentPitchingCache[pid] = s ? {
          era: parseFloat(s.era), whip: parseFloat(s.whip),
          ip: parseFloat(s.inningsPitched) || 0,
        } : null;
      }).catch(() => { recentPitchingCache[pid] = null; })
  ));
}

// ── MVP Tracker uses tighter time windows for HEAT (recent form) ──────────
// Hitters bat almost daily — 10 days is enough to see real form
// Pitchers start every 5 days — 15 days = ~3 starts, enough to see a trend
const mvpHeatHittingCache = {};   // pid -> {ops, ab}
const mvpHeatPitchingCache = {};  // pid -> {era, ip}

async function fetchMvpHeatHitting(pids) {
  const missing = pids.filter(id => !(id in mvpHeatHittingCache));
  if (!missing.length) return;
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 10 * 86400000).toISOString().split('T')[0];
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i+20).join(',');
    await fetchWithTimeout(
      `${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=byDateRange,group=hitting,startDate=${startDate},endDate=${endDate},season=${CURRENT_YEAR})`
    ).then(r => r.json()).then(d => {
      (d.people || []).forEach(p => {
        const s = p.stats?.find(g => g.group?.displayName?.toLowerCase() === 'hitting')?.splits?.[0]?.stat;
        mvpHeatHittingCache[p.id] = s ? {
          ops: parseFloat(s.ops) || 0,
          ab:  parseInt(s.atBats) || 0,
        } : null;
      });
    }).catch(() => {
      missing.slice(i, i+20).forEach(id => { mvpHeatHittingCache[id] = null; });
    });
  }
}

async function fetchMvpHeatPitching(pids) {
  const missing = pids.filter(id => !(id in mvpHeatPitchingCache));
  if (!missing.length) return;
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 15 * 86400000).toISOString().split('T')[0];
  await Promise.all(missing.map(pid =>
    fetchWithTimeout(`${MLB_API}/people/${pid}/stats?stats=byDateRange&group=pitching&startDate=${startDate}&endDate=${endDate}&season=${CURRENT_YEAR}`)
      .then(r => r.json()).then(d => {
        const s = d.stats?.find(g => g.group?.displayName === 'pitching')?.splits?.[0]?.stat;
        mvpHeatPitchingCache[pid] = s ? {
          era: parseFloat(s.era),
          ip: parseFloat(s.inningsPitched) || 0,
        } : null;
      }).catch(() => { mvpHeatPitchingCache[pid] = null; })
  ));
}

// ── MVP Tracker: next game + probable pitcher + IL status ─────────────────
let mvpScheduleCache = null;       // teamId -> { date, opponent, time, probablePids, homeAway }
const mvpILCache = {};             // teamId -> Set of pids on IL
const mvpPitcherQSCache = {};      // pid -> computed quality starts from game logs

async function fetchMvpSchedule() {
  if (mvpScheduleCache && Object.keys(mvpScheduleCache).length) return;
  mvpScheduleCache = {};
  const today  = new Date().toISOString().split('T')[0];
  const future = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  try {
    const d = await fetchWithTimeout(
      `${MLB_API}/schedule?sportId=1&startDate=${today}&endDate=${future}&gameType=R&hydrate=probablePitcher,team`
    ).then(r => r.json()).catch(() => ({ dates: [] }));
    for (const dateObj of (d.dates || [])) {
      for (const game of (dateObj.games || [])) {
        const dateStr  = dateObj.date;
        const gameTime = game.gameDate ? new Date(game.gameDate) : null;
        const timeStr  = gameTime
          ? gameTime.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })
          : null;
        const home = game.teams?.home;
        const away = game.teams?.away;
        if (!home || !away) continue;
        const homeId   = home.team?.id;
        const awayId   = away.team?.id;
        const homeMeta = TEAM_META[homeId] || { abbr: home.team?.abbreviation || '?', logo: `https://www.mlbstatic.com/team-logos/${homeId}.svg` };
        const awayMeta = TEAM_META[awayId] || { abbr: away.team?.abbreviation || '?', logo: `https://www.mlbstatic.com/team-logos/${awayId}.svg` };
        const homeAbbr = homeMeta.abbr;
        const awayAbbr = awayMeta.abbr;
        const probPids = new Set();
        [home.probablePitcher?.id, away.probablePitcher?.id].forEach(id => { if (id) probPids.add(id); });
        if (homeId && !mvpScheduleCache[homeId])
          mvpScheduleCache[homeId] = { gamePk: game.gamePk, date: dateStr, opponent: awayAbbr, opponentId: awayId, opponentLogo: awayMeta.logo, time: timeStr, probablePids: probPids, homeAway: 'vs' };
        if (awayId && !mvpScheduleCache[awayId])
          mvpScheduleCache[awayId] = { gamePk: game.gamePk, date: dateStr, opponent: homeAbbr, opponentId: homeId, opponentLogo: homeMeta.logo, time: timeStr, probablePids: probPids, homeAway: '@' };
      }
    }
  } catch(e) {
    mvpScheduleCache = {};
  }
}

async function fetchMvpIL(teamIds) {
  const missing = teamIds.filter(id => !(id in mvpILCache));
  if (!missing.length) return;
  const IL_STATUSES = new Set(['7-Day Injured List','10-Day Injured List','15-Day Injured List','60-Day Injured List']);
  await Promise.all(missing.map(teamId =>
    fetchWithTimeout(`${MLB_API}/teams/${teamId}/roster?rosterType=40Man&season=${CURRENT_YEAR}`)
      .then(r => r.json()).then(d => {
        const ilSet = new Set();
        (d.roster || []).forEach(e => {
          if (IL_STATUSES.has(e.status?.description || '')) ilSet.add(e.person?.id);
        });
        mvpILCache[teamId] = ilSet;
      }).catch(() => { mvpILCache[teamId] = new Set(); })
  ));
}

async function fetchMvpPitcherQS(pids) {
  const missing = pids.filter(id => !(id in mvpPitcherQSCache));
  if (!missing.length) return;
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20).join(',');
    await fetchWithTimeout(
      `${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=gameLog,group=pitching,season=${CURRENT_YEAR})`
    ).then(r => r.json()).then(d => {
      (d.people || []).forEach(p => {
        const splits = p.stats?.find(g => g.group?.displayName === 'pitching')?.splits || [];
        let qs = 0;
        splits.forEach(sp => {
          const s = sp.stat || {};
          const gs = parseInt(s.gamesStarted || 0) || 0;
          const ip = parseFloat(s.inningsPitched || 0) || 0;
          const er = parseInt(s.earnedRuns || 0) || 0;
          if (gs > 0 && ip >= 6 && er <= 3) qs++;
        });
        mvpPitcherQSCache[p.id] = qs;
      });
    }).catch(() => {
      missing.slice(i, i + 20).forEach(id => { mvpPitcherQSCache[id] = 0; });
    });
  }
}

function nextGameHTML(p, awardType) {
  const game = mvpScheduleCache?.[p.teamId];
  if (!game) return '';
  const todayStr    = new Date().toISOString().split('T')[0];
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const isToday = game.date === todayStr;
  const matchup = `${game.homeAway === 'vs' ? 'VS' : '@'} ${game.opponent}`;
  let dateLabel;
  if (isToday) dateLabel = 'Today';
  else if (game.date === tomorrowStr) dateLabel = 'Tomorrow';
  else {
    const d = new Date(game.date + 'T12:00:00');
    dateLabel = d.toLocaleDateString('en-US', { weekday:'short', day:'numeric', month:'short' });
  }
  const timeLabel = game.time ? ` · ${game.time}` : '';
  const stateCls  = ` confirmed${isToday ? ' today' : ''}`;
  const logoHtml = game.opponentLogo ? `<img class="mvp-next-logo" src="${game.opponentLogo}" alt="${game.opponent}" onerror="this.style.display='none'">` : '';
  if (awardType === 'cy') {
    const isStarter = (parseInt(p.s?.gamesStarted||0) > 0);
    const label = isStarter ? 'Next start' : 'Next game';
    if (game.probablePids.has(p.pid)) {
      const canOpen = game.gamePk && isGameInTopGamesWindow(game.date);
      return `<div class="mvp-next${stateCls}${canOpen ? ' linkable' : ''}" ${canOpen ? `onclick="event.stopPropagation();goToTopGame('${game.gamePk}','${game.date}','mvp')"` : ''}>${logoHtml}<span>${label}: ${matchup}<span class="mvp-next-sep"> · </span><span class="mvp-next-datetime">${dateLabel}${timeLabel}</span></span></div>`;
    }
    else
      return `<div class="mvp-next unconfirmed">${label}: unconfirmed</div>`;
  }
  const canOpen = game.gamePk && isGameInTopGamesWindow(game.date);
  return `<div class="mvp-next${stateCls}${canOpen ? ' linkable' : ''}" ${canOpen ? `onclick="event.stopPropagation();goToTopGame('${game.gamePk}','${game.date}','mvp')"` : ''}>${logoHtml}<span>Next game: ${matchup}<span class="mvp-next-sep"> · </span><span class="mvp-next-datetime">${dateLabel}${timeLabel}</span></span></div>`;
}

function ilBadgeHTML(p) {
  const ilSet = mvpILCache[p.teamId];
  if (!ilSet || !ilSet.has(p.pid)) return '';
  return `<div class="mvp-il">🏥 Injured List</div>`;
}

async function fetchCareerStats(pids) {
  const missing = pids.filter(id => !(id in careerStatsCache));
  if (!missing.length) return;
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i+20).join(',');
    await Promise.all([
      fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=yearByYear,group=hitting)`).then(r=>r.json()).then(d=>{
        (d.people||[]).forEach(p => {
          careerStatsCache[p.id] = careerStatsCache[p.id] || {};
          if (p.mlbDebutDate) careerStatsCache[p.id].debutYear = parseInt(p.mlbDebutDate.slice(0,4));
          Object.assign(careerStatsCache[p.id], summarizePriorHitting(p));
        });
      }).catch(()=>{}),
      fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=yearByYear,group=pitching)`).then(r=>r.json()).then(d=>{
        (d.people||[]).forEach(p => {
          careerStatsCache[p.id] = careerStatsCache[p.id] || {};
          if (p.mlbDebutDate) careerStatsCache[p.id].debutYear = parseInt(p.mlbDebutDate.slice(0,4));
          Object.assign(careerStatsCache[p.id], summarizePriorPitching(p));
        });
      }).catch(()=>{})
    ]);
  }

  await fetchSeasonHistory(pids);
}

async function fetchSeasonHistory(pids) {
  const prevYear = CURRENT_YEAR - 1;
  const seasons = Array.from({length: 5}, (_, k) => prevYear - (4 - k)); // [prevYear-4 .. prevYear]
  const missingHistory = pids.filter(id => {
    const hist = seasonHistoryCache[id];
    if (!hist) return true;
    const hitCount = Object.keys(hist.hit || {}).length;
    const pitchCount = Object.keys(hist.pitch || {}).length;
    return hitCount === 0 && pitchCount === 0;
  });
  if (!missingHistory.length) return;

  for (let i = 0; i < missingHistory.length; i += 20) {
    const chunk = missingHistory.slice(i, i+20).join(',');
    await Promise.all([
      // Hitting seasons
      fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=yearByYear,group=hitting,startSeason=${seasons[0]},endSeason=${prevYear})`)
        .then(r=>r.json()).then(d=>{
          (d.people||[]).forEach(p => {
            if (!seasonHistoryCache[p.id]) seasonHistoryCache[p.id] = { hit: {}, pitch: {} };
            const sg = p.stats?.find(g => g.group?.displayName==='hitting');
            if (!sg) return;
            (sg.splits||[]).forEach(sp => {
              const yr = sp.season ? parseInt(sp.season) : null;
              if (yr && seasons.includes(yr) && sp.stat?.ops) {
                seasonHistoryCache[p.id].hit[yr] = parseFloat(sp.stat.ops)||0;
              }
            });
          });
        }).catch(()=>{}),
      // Pitching seasons
      fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=yearByYear,group=pitching,startSeason=${seasons[0]},endSeason=${prevYear})`)
        .then(r=>r.json()).then(d=>{
          (d.people||[]).forEach(p => {
            if (!seasonHistoryCache[p.id]) seasonHistoryCache[p.id] = { hit: {}, pitch: {} };
            const sg = p.stats?.find(g => g.group?.displayName==='pitching');
            if (!sg) return;
            (sg.splits||[]).forEach(sp => {
              const yr = sp.season ? parseInt(sp.season) : null;
              if (yr && seasons.includes(yr) && sp.stat?.era != null) {
                const era = parseFloat(sp.stat.era), whip = parseFloat(sp.stat.whip);
                seasonHistoryCache[p.id].pitch[yr] = calcBaseScore(era, whip) ?? null;
              }
            });
          });
        }).catch(()=>{})
    ]);
  }
}

// Generate colored dots for each season with data (up to 5) for OPS (hitters) or FORMA (pitchers)
function seasonDotsHTML(pid, type) {
  const hist = seasonHistoryCache[pid];
  const prevYear = CURRENT_YEAR - 1;
  const seasons = Array.from({length: 5}, (_, k) => prevYear - (4 - k));
  const data = hist ? (type === 'hitter' ? hist.hit : hist.pitch) : {};

  const dots = seasons
    .filter(yr => data[yr] != null)
    .map(yr => {
      const val = data[yr];
      const color = getDiamondPlayerColor(val, type);
      const tooltip = type === 'hitter'
        ? `OPS ${val.toFixed(3)} (${yr})`
        : `FORM ${val} (${yr})`;
      return `<span class="season-dot" style="background:${color}" title="${tooltip}"></span>`;
    }).join('');

  if (!dots) return '';

  return `<div class="season-dots-row">
    <span class="season-dot-label">5Y</span>${dots}
  </div>`;
}

// "≈ career" badge: no meaningful trend, so color it by the player's absolute
// level (same 5-tier scale as their FORM/OPS chip). Maps a scale color onto the
// trend tier classes, which already carry those exact colors.
function absLevelTrendClass(scaleColor) {
  return {
    '#16a34a': 'trend-up-strong',   // elite — green
    '#b1c882': 'trend-up',          // above avg — light green
    '#ffc000': 'trend-flat',        // average — yellow
    '#ff8100': 'trend-down',        // below avg — orange
    '#ff2200': 'trend-down-strong', // poor — red
  }[scaleColor] || 'trend-flat';
}

function trendBadgeHTML(current, career, metric) {
  if (!career || !current || career === 0) return '';
  const lowerBetter = metric === 'era' || metric === 'whip';
  const delta = lowerBetter ? career - current : current - career;
  const absDelta = Math.abs(delta);
  const pct = absDelta / career;
  const threshold = metric === 'ops' ? 0.025 : metric === 'avg' ? 0.010 : metric === 'era' ? 0.25 : 0.04;
  const decimals = (metric === 'ops' || metric === 'avg') ? 3 : 2;
  const isUp   = delta >  threshold || (pct > 0.07 && delta > 0);
  const isDown = delta < -threshold || (pct > 0.07 && delta < 0);
  if (isUp) {
    const cls = pct > 0.15 ? 'trend-up-strong' : 'trend-up';
    return `<span class="trend-badge ${cls}">▲ ${absDelta.toFixed(decimals)}<br>vs career</span>`;
  } else if (isDown) {
    const cls = pct > 0.15 ? 'trend-down-strong' : 'trend-down';
    return `<span class="trend-badge ${cls}">▼ ${absDelta.toFixed(decimals)}<br>vs career</span>`;
  } else {
    const cls = absLevelTrendClass(getDiamondPlayerColor(current, 'hitter'));
    return `<span class="trend-badge ${cls}">≈ career</span>`;
  }
}

// FORMA trend: compares two 0-100 scores — higher always = better
function trendFormaHTML(currentScore, careerScore) {
  if (currentScore == null || careerScore == null) return '';
  const delta = currentScore - careerScore;
  const abs = Math.abs(delta);
  if (abs < 5) {
    const cls = absLevelTrendClass(getDiamondPlayerColor(currentScore, 'pitcher'));
    return `<span class="trend-badge ${cls}">≈ career</span>`;
  }
  if (delta > 0) {
    const cls = abs >= 12 ? 'trend-up-strong' : 'trend-up';
    return `<span class="trend-badge ${cls}">▲ ${abs}<br>vs career</span>`;
  } else {
    const cls = abs >= 12 ? 'trend-down-strong' : 'trend-down';
    return `<span class="trend-badge ${cls}">▼ ${abs}<br>vs career</span>`;
  }
}

const loaded = { standings: true, bracket: false, schedule: false, rosters: false, rankings: true, topgames: false, players: false, mvp: false };

function warmAppData() {
  setTimeout(() => {
    ensureMvpLists().catch(e => console.warn('MVP preload failed:', e));

    if (!loaded.topgames) {
      loaded.topgames = true;
      loadTopGames().catch(e => console.warn('Top Games preload failed:', e));
    }

    if (!loaded.rosters) {
      loaded.rosters = true;
      loadRosters().catch(e => console.warn('Rosters preload failed:', e));
    }
  }, 250);
}

function switchTab(tab) {
  try {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`[onclick="switchTab('${tab}')"]`);
    if (btn) btn.classList.add('active');
    // Also activate the matching bottom nav button
    const bnavBtn = document.querySelector(`.bnav-btn[data-tab="${tab}"]`);
    if (bnavBtn) bnavBtn.classList.add('active');
    const panel = document.getElementById(`tab-${tab}`);
    if (panel) panel.classList.add('active');
    if (tab === 'standings') startStandingsAutoRefresh();
    else stopStandingsAutoRefresh();
    const rosterAbbr = (tab === 'rosters' && selectedTeamId && TEAM_META[selectedTeamId]?.abbr)
      ? TEAM_META[selectedTeamId].abbr.toLowerCase() : '';
    history.replaceState(null, '', rosterAbbr ? `#rosters/${rosterAbbr}` : `#${tab}`);
    if (tab !== 'rosters') window._fromStandings = false;
    if (tab !== 'topgames') {
      window._fromStandingsTopGames = false;
      window._fromMvpTopGames = false;
    }
    if (tab !== 'mvp') window._fromTopGames = false;
    // Show/hide MVP breadcrumb
    const mvpBC = document.getElementById('mvpBreadcrumb');
    if (mvpBC) mvpBC.style.display = (tab === 'mvp' && window._fromTopGames) ? 'flex' : 'none';
    const tgBC = document.getElementById('topGamesBreadcrumb');
    const tgBCLabel = document.getElementById('topGamesBreadcrumbLabel');
    if (tgBC) {
      const fromStandings = !!window._fromStandingsTopGames;
      const fromMvp = !!window._fromMvpTopGames;
      tgBC.style.display = (tab === 'topgames' && (fromStandings || fromMvp)) ? 'flex' : 'none';
      if (tab === 'topgames' && (fromStandings || fromMvp)) {
        if (tgBCLabel) tgBCLabel.textContent = fromMvp ? 'MVP RACE' : 'PLAYOFF RACE';
        tgBC.onclick = () => switchTab(fromMvp ? 'mvp' : 'standings');
      }
    }
    if (!loaded[tab]) {
      loaded[tab] = true;
      if (tab === 'bracket') loadBracket();
      if (tab === 'schedule') loadSchedule();
      if (tab === 'rosters') loadRosters();
      if (tab === 'topgames') loadTopGames();
      if (tab === 'players') loadPlayers();
      if (tab === 'mvp') loadMVPTracker();
    } else if (tab === 'rosters') {
      // Re-render team list if it's empty (standings may have loaded after first visit)
      const listEl = document.getElementById('teamSelectorList');
      if (listEl && !listEl.querySelector('.team-logo-btn')) loadRosters();
    } else if (tab === 'topgames' && window._topGamesTarget) {
      setTimeout(() => focusTopGameTarget(), 50);
    }
  } catch(e) { console.error('switchTab:', e); }
}

// ── TOP GAMES ─────────────────────────────────────────────────────────────
function topGameCardHTML(game, gameScore, rank) {
  const awayTeam = game.teams.away.team;
  const homeTeam = game.teams.home.team;
  const awayMeta = TEAM_META[awayTeam.id] || { name: awayTeam.name, abbr: awayTeam.abbreviation||'?', logo: `https://www.mlbstatic.com/team-logos/${awayTeam.id}.svg` };
  const homeMeta = TEAM_META[homeTeam.id] || { name: homeTeam.name, abbr: homeTeam.abbreviation||'?', logo: `https://www.mlbstatic.com/team-logos/${homeTeam.id}.svg` };

  const awayRec = (() => { const r = game.teams.away.leagueRecord; return r ? `${r.wins}-${r.losses}` : ''; })();
  const homeRec = (() => { const r = game.teams.home.leagueRecord; return r ? `${r.wins}-${r.losses}` : ''; })();

  const gameTime = new Date(game.gameDate).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

  function spBlock(side) {
    const pp = game.teams?.[side]?.probablePitcher;
    if (!pp) return `<div style="font-size:11px;color:var(--muted);font-family:'Barlow Condensed'">SP por confirmar</div>`;
    const s = pp.stats?.find(g => g.group?.displayName === 'pitching')?.splits?.[0]?.stat;
    const forma = s ? (calcBaseScore(parseFloat(s.era), parseFloat(s.whip)) ?? '—') : '—';
    const formaColor = typeof forma === 'number' ? getDiamondPlayerColor(forma, 'pitcher') : 'var(--muted)';
    const era = s?.era || '—';
    return `<div>
      <div style="font-weight:700;font-size:13px;color:var(--text)">${pp.fullName}</div>
      <div style="font-size:11px;color:var(--muted);font-family:'Barlow Condensed'">ERA ${era} · <span style="color:${formaColor};font-weight:700">FORM ${forma}</span></div>
    </div>`;
  }

  const rankLabel = ['🥇','🥈','🥉'][rank] || `#${rank+1}`;
  const scoreRound = Math.round(gameScore);

  return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 20px;box-shadow:0 1px 6px rgba(0,0,0,.06)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <span style="font-family:'Bebas Neue';font-size:18px;letter-spacing:2px;color:var(--accent)">${rankLabel} Game of the Day</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-family:'Barlow Condensed';font-size:12px;color:var(--muted);letter-spacing:1px">${gameTime}</span>
          <span style="font-family:'Barlow Condensed';font-weight:700;font-size:11px;background:rgba(21,101,216,.08);color:var(--accent);border:1px solid rgba(21,101,216,.2);padding:2px 8px;border-radius:4px">SCORE ${scoreRound}</span>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px">
        <!-- Away team -->
        <div style="display:flex;align-items:center;gap:10px">
          <img src="${awayMeta.logo}" style="width:40px;height:40px;object-fit:contain" onerror="this.style.display='none'">
          <div>
            <div style="font-family:'Bebas Neue';font-size:20px;letter-spacing:1px">${awayMeta.name}</div>
            <div style="font-family:'Barlow Condensed';font-size:13px;color:var(--muted);font-weight:600">${awayRec}</div>
          </div>
        </div>
        <!-- VS -->
        <div style="text-align:center;font-family:'Bebas Neue';font-size:22px;color:var(--muted)">@</div>
        <!-- Home team -->
        <div style="display:flex;align-items:center;gap:10px;flex-direction:row-reverse;text-align:right">
          <img src="${homeMeta.logo}" style="width:40px;height:40px;object-fit:contain" onerror="this.style.display='none'">
          <div>
            <div style="font-family:'Bebas Neue';font-size:20px;letter-spacing:1px">${homeMeta.name}</div>
            <div style="font-family:'Barlow Condensed';font-size:13px;color:var(--muted);font-weight:600">${homeRec}</div>
          </div>
        </div>
      </div>
      <!-- Probable pitchers -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div>${spBlock('away')}</div>
        <div style="text-align:right">${spBlock('home')}</div>
      </div>
    </div>`;
}

// ── TOP GAMES ─────────────────────────────────────────────────────────────
// Accordion: AYER (colapsed) | HOY (expanded) | MAÑANA (collapsed)
// Games ordered by time. Score-based color dot: green=top15%, blue=top40%, grey=rest.

function tgToggleDay(blockId) {
  const block = document.getElementById(blockId);
  if (!block) return;
  const header = block.querySelector('.tg-day-header');
  const body   = block.querySelector('.tg-day-body');
  const chev   = block.querySelector('.tg-day-chevron');
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  header.classList.toggle('open', !isOpen);
  chev.classList.toggle('open', !isOpen);
}

function tgToggleGame(gameId) {
  const detail = document.getElementById('tgd-' + gameId);
  if (!detail) return;
  const row = document.getElementById('tgr-' + gameId);
  detail.classList.toggle('open');
  if (row) row.classList.toggle('tg-row-open');
}

// ── TOP GAMES — new lazy-load system ──────────────────────────────────────────
window._tgCurrentDay = null;
window._tgDayCache   = {};   // { ayer:{dateKey,html}, hoy:{...}, manana:{...} }

function hasCompleteMvpLists() {
  return !!(window._mvpLists?.alMVP && window._mvpLists?.nlMVP &&
    window._mvpLists?.alCY && window._mvpLists?.nlCY &&
    window._mvpLists?.alROY && window._mvpLists?.nlROY);
}

function isTopGamesDisplayableGame(game, day) {
  const status = game.status || {};
  const detailed = String(status.detailedState || '').toLowerCase();
  const abstractState = status.abstractGameState;

  if (/(cancelled|canceled)/i.test(detailed)) return false;

  if (abstractState === 'Final') {
    const awayScore = game.teams?.away?.score;
    const homeScore = game.teams?.home?.score;
    const hasLinescore = !!game.linescore?.innings?.length;
    const isScorelessNoBoxscore = (awayScore ?? 0) === 0 && (homeScore ?? 0) === 0 && !hasLinescore;
    return day === 'hoy' && (!isScorelessNoBoxscore || isPostponedLikeGame(game));
  }

  return abstractState === 'Live' || abstractState === 'Preview';
}

function isPostponedLikeGame(game) {
  const status = game.status || {};
  const detailed = String(status.detailedState || '').toLowerCase();
  const reason = String(status.reason || status.abstractGameCode || '').toLowerCase();
  return /(postponed|suspended|rescheduled)/i.test(detailed) ||
    /(postponed|suspended|rescheduled)/i.test(reason);
}

// ── Independent TOP MATCH scoring ──────────────────────────────────────────────
function calcTopMatchScore(game, pitcherFormaMap, candidatesByTeam) {
  // --- Pitcher duel axis (0-3) ---
  const awayId = game.teams?.away?.team?.id;
  const homeId = game.teams?.home?.team?.id;
  const awayAbbr = game.teams?.away?.team?.abbreviation || '';
  const homeAbbr = game.teams?.home?.team?.abbreviation || '';
  const awayP = (game.probables?.away?.id || game.probables?.away?.fullName) ? game.probables.away : null;
  const homeP = (game.probables?.home?.id || game.probables?.home?.fullName) ? game.probables.home : null;
  const awayForma = awayP ? (pitcherFormaMap[awayP.id] ?? pitcherFormaMap[awayP.fullName] ?? 0) : 0;
  const homeForma = homeP ? (pitcherFormaMap[homeP.id] ?? pitcherFormaMap[homeP.fullName] ?? 0) : 0;
  const minForma  = Math.min(awayForma, homeForma);
  const avgForma  = (awayForma + homeForma) / 2;
  let pitcherScore = 0;
  let eliteDuel = false;
  if (awayP && homeP) {
    if (minForma >= 75) { pitcherScore = 3; eliteDuel = true; }
    else if (avgForma >= 65) pitcherScore = 2;
    else if (avgForma >= 52) pitcherScore = 1;
  } else if (awayP || homeP) {
    const forma = awayP ? awayForma : homeForma;
    pitcherScore = forma >= 68 ? 1 : 0;
  }

  // --- Standings axis (0-3) ---
  const allStandings = (allData.standings || []).flatMap(r => r.teamRecords || []);
  function teamRecord(teamId, abbr) {
    return allStandings.find(r => r.team?.id === teamId) ||
      allStandings.find(r =>
        r.team?.abbreviation === abbr ||
        r.team?.name?.includes(abbr)
      ) || null;
  }
  const awayRec = teamRecord(awayId, awayAbbr);
  const homeRec = teamRecord(homeId, homeAbbr);

  // Elimination modifier
  const awayElim = awayRec ? (awayRec.eliminationNumber === 'E' || awayRec.wildCardEliminationNumber === 'E') : false;
  const homeElim = homeRec ? (homeRec.eliminationNumber === 'E' || homeRec.wildCardEliminationNumber === 'E') : false;
  let elimMod = 1.0;
  if (awayElim && homeElim) elimMod = 0;
  else if (awayElim || homeElim) elimMod = 0.5;

  // Seasonal multiplier (September onward)
  const now   = new Date();
  const month = now.getMonth(); // 0-based; August = 7, September = 8
  const seasonMult = month >= 8 ? 1.5 : 1.0;

  let standingsScore = 0;
  if (awayRec && homeRec) {
    const awayDiv = awayRec.divisionRank  || 99;
    const homeDiv = homeRec.divisionRank  || 99;
    const awayGB  = parseFloat(awayRec.divisionGamesBack) || 0;
    const homeGB  = parseFloat(homeRec.divisionGamesBack) || 0;
    const minRank = Math.min(awayDiv, homeDiv);
    const maxRank = Math.max(awayDiv, homeDiv);
    const winPctDiff = Math.abs(
      (parseFloat(awayRec.winningPercentage) || 0) -
      (parseFloat(homeRec.winningPercentage) || 0)
    );

    // Top-2 in same division face off
    if (awayRec.team?.division?.id && homeRec.team?.division?.id &&
        awayRec.team.division.id === homeRec.team.division.id &&
        minRank <= 2 && maxRank <= 2) {
      standingsScore = 3;
    }
    // Top-2 in different divisions / Wild card contenders
    else if (minRank <= 2) {
      standingsScore = winPctDiff < 0.05 ? 2 : 1.5;
    }
    else if (minRank <= 3 && winPctDiff < 0.04) {
      standingsScore = 1;
    }
    standingsScore = Math.min(4, standingsScore * elimMod * seasonMult);
  }

  // --- Award candidates axis (0-2) — only top-3 ranked (in real contention) ---
  let candScore = 0;
  if (candidatesByTeam) {
    const teamCandidates = (teamId, abbr) =>
      candidatesByTeam[String(teamId)] ||
      candidatesByTeam[TEAM_META[teamId]?.abbr] ||
      candidatesByTeam[abbr] ||
      [];
    const countTop = (teamId, abbr) => teamCandidates(teamId, abbr).filter(c => (c.rank || 99) <= 3).length;
    const topTotal = countTop(awayId, awayAbbr) + countTop(homeId, homeAbbr);
    candScore = topTotal >= 3 ? 2 : topTotal >= 1 ? 1 : 0;
  }

  const total = pitcherScore + standingsScore + candScore;
  const isTopMatch = eliteDuel || total >= 7.0;
  return { isTopMatch, eliteDuel, pitcherScore, standingsScore, candScore, total };
}

// ── Main entry: render day-selector UI ─────────────────────────────────────────
// ── Scoreboard (Wrigley-style TOP GAMES) — integrated from the standalone prototype.
// Self-contained module; only entry points are exposed on window.WB. The classic
// TOP GAMES (loadTopGamesDay/_tgLoad*/_OLD_loadTopGames below) is now dead code,
// archived at git tag `topgames-classic`. ──────────────────────────────────────
(function(){
  const API='https://statsapi.mlb.com/api/v1';
  let curDay='hoy', pollTimer=null, lastGames=[], clockStarted=false, mvpRaceTried=false;
  let topPks=new Set(), topRetry=false;
  const expanded=new Set(), ptwCache={}, starsCache={};
  const $=id=>document.getElementById(id);
  const fj=u=>fetch(u).then(r=>r.json());
  function dateFor(day){const d=new Date();if(day==='ayer')d.setDate(d.getDate()-1);if(day==='manana')d.setDate(d.getDate()+1);return d.toISOString().slice(0,10);}
  function forma(era,whip){const p=[];if(era!=null)p.push(Math.max(0,Math.min(100,(6-era)/4.5*100)));if(whip!=null)p.push(Math.max(0,Math.min(100,(2-whip)/1.2*100)));return p.length?Math.round(p.reduce((a,b)=>a+b,0)/p.length):null;}
  function tier(f){return f==null?'#9ca3af':f>=75?'#16a34a':f>=60?'#b1c882':f>=40?'#ffc000':f>=25?'#ff8100':'#ff2200';}
  function lighten(h,r){const n=parseInt(h.slice(1),16),R=(n>>16)&255,G=(n>>8)&255,B=n&255;return '#'+((1<<24)+(Math.round(R+(255-R)*r)<<16)+(Math.round(G+(255-G)*r)<<8)+Math.round(B+(255-B)*r)).toString(16).slice(1);}
  function shade(h,r){const n=parseInt(h.slice(1),16),R=Math.round(((n>>16)&255)*(1-r)),G=Math.round(((n>>8)&255)*(1-r)),B=Math.round((n&255)*(1-r));return '#'+((1<<24)+(R<<16)+(G<<8)+B).toString(16).slice(1);}
  function fmt3(x){if(x==null||x==='')return '—';const s=(+x).toFixed(3);return s.startsWith('0.')?s.slice(1):s;}
  const logo=id=>`https://www.mlbstatic.com/team-logos/team-cap-on-dark/${id}.svg`;
  const head=id=>`https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_120,q_auto:best/v1/people/${id}/headshot/silo/current`;
  const PRIMARY={108:'#BA0021',109:'#A71930',110:'#DF4601',111:'#BD3039',112:'#0E3386',113:'#C6011F',114:'#00385D',115:'#33006F',116:'#0C2340',117:'#002D62',118:'#004687',119:'#005A9C',120:'#AB0003',121:'#002D72',133:'#003831',134:'#FDB827',135:'#2F241D',136:'#0C2C56',137:'#FD5A1E',138:'#C41E3A',139:'#092C5C',140:'#003278',141:'#134A8E',142:'#002B5C',143:'#E81828',144:'#CE1141',145:'#27251F',146:'#00A3E0',147:'#003087',158:'#12284B'};
  const teamBg=id=>{const c=PRIMARY[id]||'#26324a';return `linear-gradient(145deg,${c} 0%,${shade(c,.45)} 100%)`;};

  function tickClock(){if(!$('wb-clock'))return;const n=new Date(),s=n.getSeconds(),m=n.getMinutes(),h=n.getHours()%12+m/60;
    const sh=$('wb-sh'),mh=$('wb-mh'),hh=$('wb-hh');if(sh)sh.style.transform=`rotate(${s*6}deg)`;if(mh)mh.style.transform=`rotate(${m*6}deg)`;if(hh)hh.style.transform=`rotate(${h*30}deg)`;}
  function startClock(){const c=$('wb-clock');if(c&&!c.querySelector('.wb-tick')){for(let i=0;i<12;i++){const t=document.createElement('div');t.className='wb-tick';t.style.transform=`rotate(${i*30}deg)`;c.appendChild(t);}}tickClock();if(!clockStarted){clockStarted=true;setInterval(tickClock,1000);}}

  // ── TOP GAME badge: relative pick, ~1 per day ──
  // The absolute threshold (total >= 7) is unreachable before September, when the
  // seasonal multiplier kicks in, so instead of a fixed cut we badge the day's
  // single best game by total score, as long as it clears a modest floor (a flat
  // slate gets none). An elite pitcher duel always qualifies on its own.
  const TOP_MIN_TOTAL = 3.5;
  function buildCandsByTeam(){
    const ml=window._mvpLists; if(!ml)return null;
    const flat=[...(ml.alMVP||[]),...(ml.nlMVP||[]),...(ml.alCY||[]),...(ml.nlCY||[]),...(ml.alROY||[]),...(ml.nlROY||[])];
    const by={};
    flat.forEach(c=>{[c.teamId,c.teamAbbr].filter(Boolean).map(String).forEach(k=>{(by[k]=by[k]||[]).push(c);});});
    return by;
  }
  function computeTop(games,people){
    topPks=new Set();
    if(typeof calcTopMatchScore!=='function')return;
    const fm={};
    Object.keys(people).forEach(pid=>{const p=people[pid];const f=calcBaseScore(p.era??NaN,p.whip??NaN);if(f!=null){fm[pid]=f;if(p.name)fm[p.name]=f;}});
    const cands=buildCandsByTeam();
    let best=null;
    games.forEach(g=>{
      const probables={away:g.teams.away.probablePitcher||null,home:g.teams.home.probablePitcher||null};
      let s;
      try{s=calcTopMatchScore({teams:g.teams,probables},fm,cands);}catch(e){return;}
      if(s.eliteDuel)topPks.add(g.gamePk);
      if(s.total>=TOP_MIN_TOTAL && (!best || s.total>best.s.total ||
        (s.total===best.s.total && s.pitcherScore>best.s.pitcherScore))) best={g,s};
    });
    if(best)topPks.add(best.g.gamePk);
  }

  async function loadDay(day,silent){
    curDay=day;
    document.querySelectorAll('.wb-day').forEach(b=>b.classList.toggle('wb-active',b.dataset.day===day));
    if(!$('wb-games'))return;
    if(!silent)$('wb-games').innerHTML='<div class="wb-loading">LOADING…</div>';
    let games=[];
    try{const sched=await fj(`${API}/schedule?sportId=1&date=${dateFor(day)}&hydrate=probablePitcher,linescore,team`);
      games=(sched.dates&&sched.dates[0]&&sched.dates[0].games)||[];
    }catch(e){if($('wb-games'))$('wb-games').innerHTML='<div class="wb-empty">Could not load.</div>';return;}
    const ids=new Set();
    games.forEach(g=>{['away','home'].forEach(s=>{const pp=g.teams[s].probablePitcher;if(pp&&pp.id)ids.add(pp.id);});});
    const people={};
    if(ids.size){try{
      const d=await fj(`${API}/people?personIds=${[...ids].join(',')}&hydrate=stats(group=pitching,type=season,season=${CURRENT_YEAR})`);
      (d.people||[]).forEach(p=>{let st={};(p.stats||[]).forEach(b=>{if(b.group&&b.group.displayName==='pitching'&&b.type&&b.type.displayName==='season')st=(b.splits&&b.splits[0]&&b.splits[0].stat)||{};});
        people[p.id]={num:p.primaryNumber||'',name:p.fullName,era:st.era?+st.era:null,whip:st.whip?+st.whip:null,ip:st.inningsPitched||'—',so:st.strikeOuts||0,w:st.wins||0,l:st.losses||0};});
    }catch(e){}}
    lastGames=games;
    computeTop(games,people);
    if($('wb-games')) render(games,people);
    // Award-race lists may load after first paint — recompute badges once they land.
    if(!window._mvpLists && !topRetry && typeof ensureMvpLists==='function'){
      topRetry=true;
      ensureMvpLists().then(()=>{if($('wb-games')){computeTop(games,people);render(games,people);}}).catch(()=>{});
    }
    clearTimeout(pollTimer);
    if($('wb-games') && games.some(g=>g.status.abstractGameState==='Live')) pollTimer=setTimeout(()=>loadDay(curDay,true),30000);
  }

  function plate(num){return num?`<div class="wb-plate">${num}</div>`:`<div class="wb-plate-p">?</div>`;}

  function teamRow(g,side,people){
    const t=g.teams[side], team=t.team, ls=g.linescore||{}, state=g.status.abstractGameState, live=state==='Live';
    const starterId=t.probablePitcher&&t.probablePitcher.id, sp=starterId&&people[starterId];
    let spNum=sp&&sp.num;
    if(live && ls.defense && ls.defense.pitcher){const defending=ls.isTopInning?'home':'away';if(side===defending && ls.defense.pitcher.id!==starterId) spNum=null;}
    const innings=ls.innings||[]; let cells='';
    for(let i=1;i<=9;i++){const inn=innings[i-1], r=inn&&inn[side]&&inn[side].runs;const isCur=live&&ls.currentInning===i&&(ls.isTopInning?side==='away':side==='home');cells+=`<div class="wb-inn${isCur?' wb-cur':''}">${r!=null?r:''}</div>`;}
    const started=state!=='Preview', tot=(ls.teams&&ls.teams[side])||{};
    const opp=(ls.teams&&ls.teams[side==='away'?'home':'away'])||{};
    const isFinal=state==='Final', won=isFinal&&tot.runs!=null&&opp.runs!=null&&tot.runs>opp.runs, lost=isFinal&&tot.runs!=null&&opp.runs!=null&&tot.runs<opp.runs;
    const flag=won?'<span class="wb-wl wb-w">W</span>':lost?'<span class="wb-wl wb-l">L</span>':'';
    const runs=started&&tot.runs!=null?tot.runs:'';
    return `<div class="wb-row wb-trow wb-${side}${lost?' wb-loser':''}">${plate(spNum)}<div class="wb-tm"><img src="${logo(team.id)}" onerror="this.style.display='none'"><span class="wb-nm">${(team.teamName||team.name||'').toUpperCase()}</span>${flag}</div>${cells}<div class="wb-rcol">${runs}</div></div>`;
  }

  function statusText(g){const st=g.status,state=st.abstractGameState,ls=g.linescore||{};
    if(state==='Live')return `${ls.isTopInning?'TOP':'BOT'} ${ls.currentInningOrdinal||ls.currentInning}`;
    if(state==='Final')return (st.detailedState||'FINAL').toUpperCase();
    return new Date(g.gameDate).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}

  function spCard(g,side,people){
    const t=g.teams[side], pp=t.probablePitcher, p=pp&&people[pp.id];
    const nm=(t.team.teamName||t.team.name||'').toUpperCase();
    if(!p)return `<div class="wb-sp"><div class="wb-sp-head"><div class="wb-sp-id"><div class="wb-lab">${nm}</div><div class="wb-nm">TBD</div></div></div></div>`;
    const f=forma(p.era,p.whip), c=tier(f);
    return `<div class="wb-sp" style="background:${lighten(c,0.84)};border:1px solid ${lighten(c,0.48)}"><div class="wb-sp-head"><img class="wb-sp-face" src="${head(pp.id)}" style="background:${teamBg(t.team.id)}" onerror="this.style.visibility='hidden'"><div class="wb-sp-id"><div class="wb-lab">${nm}</div><div class="wb-nm">${p.name}${p.num?`<span class="wb-num">#${p.num}</span>`:''}</div></div><div class="wb-sp-form" style="color:${shade(c,0.18)}"><div class="wb-fv">${f!=null?f:'—'}</div><div class="wb-fl">FORM</div></div></div><div class="wb-st"><b>${p.era!=null?p.era.toFixed(2):'—'}</b> ERA · <b>${p.whip!=null?p.whip.toFixed(2):'—'}</b> WHIP · ${p.w}-${p.l} · ${p.ip} IP · ${p.so} K</div></div>`;
  }

  function render(games,people){
    const el=$('wb-games'); if(!el)return;
    if(!games.length){el.innerHTML='<div class="wb-empty">No games.</div>';return;}
    el.innerHTML=games.map(g=>{
      const live=g.status.abstractGameState==='Live', open=expanded.has(g.gamePk);
      const ih=Array.from({length:9},(_,i)=>`<div class="wb-gi">${i+1}</div>`).join('')+`<div class="wb-gi wb-r">R</div>`;
      return `<div class="wb-game ${open?'wb-open':''}" data-pk="${g.gamePk}" onclick="WB.toggle(${g.gamePk})"><div class="wb-row wb-ghead"><div class="wb-gh">SP</div><div class="wb-gstatus ${live?'wb-live':''}">${statusText(g)}${topPks.has(g.gamePk)?'<span class="wb-topbadge">TOP GAME</span>':''}</div>${ih}</div>${teamRow(g,'away',people)}${teamRow(g,'home',people)}</div><div class="wb-detail ${open?'wb-open':''}" id="wbd-${g.gamePk}">${g.status.abstractGameState==='Final'?`<div class="wb-dh">Key performances</div><div id="wbstars-${g.gamePk}"><div class="wb-ptw-loading">Loading…</div></div>`:`<div class="wb-dh">${g.status.abstractGameState==='Preview'?'Probable starters':'Starting pitchers'}</div><div class="wb-sp-grid">${spCard(g,'away',people)}${spCard(g,'home',people)}</div><div class="wb-ptw" id="wbptw-${g.gamePk}"></div>`}${matchupLink(g)}</div>`;
    }).join('');
    expanded.forEach(pk=>{const g=games.find(x=>x.gamePk===pk);if(g)fillDetail(g);});
  }

  async function topHitters(teamId){
    try{
      const d=await fj(`${API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(group=hitting,type=season,season=${CURRENT_YEAR}))`);
      const hs=[];
      (d.roster||[]).forEach(e=>{if((e.position&&e.position.abbreviation)==='P')return;
        let st={};(e.person.stats||[]).forEach(b=>{if(b.group&&b.group.displayName==='hitting'&&b.type&&b.type.displayName==='season')st=(b.splits&&b.splits[0]&&b.splits[0].stat)||{};});
        const ab=+st.atBats||0;if(ab>=40)hs.push({id:e.person.id,name:e.person.fullName,avg:st.avg,hr:st.homeRuns||0,rbi:st.rbi||0,ops:+st.ops||0});});
      return hs.sort((a,b)=>b.ops-a.ops).slice(0,2);
    }catch(e){return [];}
  }
  function raceChip(pid){
    const ml=window._mvpLists; if(!ml||!pid)return '';
    const sets={MVP:[...(ml.alMVP||[]),...(ml.nlMVP||[])],CY:[...(ml.alCY||[]),...(ml.nlCY||[])],ROY:[...(ml.alROY||[]),...(ml.nlROY||[])]};
    const th={MVP:10,CY:10,ROY:5}, lab={MVP:'MVP Race',CY:'CY Race',ROY:'ROY Race'};
    for(const k of ['MVP','CY','ROY']){const f=sets[k].find(p=>p.pid===pid);if(f&&f.rank<=th[k])return `<span class="wb-race">${lab[k]}</span>`;}
    return '';
  }
  function ptwCard(p,abbr,teamId){return `<div class="wb-ptw-p"><img class="wb-ptw-face" src="${head(p.id)}" style="background:${teamBg(teamId)}" onerror="this.style.visibility='hidden'"><div style="flex:1;min-width:0"><div class="wb-ptw-nm">${p.name}<span class="wb-ptw-tm">${abbr}</span></div><div class="wb-ptw-st">${fmt3(p.avg)} AVG · ${p.hr} HR · ${p.rbi} RBI · ${fmt3(p.ops)} OPS</div></div>${raceChip(p.id)}</div>`;}
  async function fillPTW(g){
    const box=$('wbptw-'+g.gamePk); if(!box)return;
    let data=ptwCache[g.gamePk];
    if(!data){box.innerHTML='<div class="wb-ptw-loading">Loading players to watch…</div>';
      const [a,h]=await Promise.all([topHitters(g.teams.away.team.id),topHitters(g.teams.home.team.id)]);
      data={a,h,aId:g.teams.away.team.id,hId:g.teams.home.team.id,aAbbr:g.teams.away.team.abbreviation||'',hAbbr:g.teams.home.team.abbreviation||''};
      ptwCache[g.gamePk]=data;}
    if(!$('wbptw-'+g.gamePk))return;
    const all=[...data.a.map(p=>ptwCard(p,data.aAbbr,data.aId)),...data.h.map(p=>ptwCard(p,data.hAbbr,data.hId))].join('');
    box.innerHTML=all?`<div class="wb-dh">Players to watch</div><div class="wb-ptw-grid">${all}</div>`:'';
    // award-race chips need _mvpLists; if not ready yet, load once then re-render
    if(all && !window._mvpLists && !mvpRaceTried && typeof ensureMvpLists==='function'){
      mvpRaceTried=true;
      ensureMvpLists().then(()=>{ if($('wbptw-'+g.gamePk)) fillPTW(g); }).catch(()=>{});
    }
  }

  // Key performances for finished games (boxscore-scored stars; mirrors the classic ayer view)
  function ipOuts(ip){if(ip==null)return 0;const[w,f='0']=String(ip).split('.');return (+w||0)*3+(+f||0);}
  const rIdx=(v,ref)=>!ref||ref<=0?0:Math.min(200,Math.max(0,(v/ref)*100));
  const rIdxInv=(v,ref)=>!v||v<=0?200:(!ref||ref<=0?0:Math.min(200,Math.max(0,(ref/v)*100)));
  function hitScore(s){const I=k=>+s[k]||0;const ab=I('atBats'),h=I('hits'),d=I('doubles'),t=I('triples'),hr=I('homeRuns'),bb=I('baseOnBalls'),hbp=I('hitByPitch'),sf=I('sacFlies'),rbi=I('rbi'),runs=I('runs'),sb=I('stolenBases'),cs=I('caughtStealing'),so=I('strikeOuts');
    const singles=Math.max(0,h-d-t-hr),tb=singles+d*2+t*3+hr*4,pa=ab+bb+hbp+sf,tob=h+bb+hbp,obp=pa>0?tob/pa:0,slg=ab>0?tb/ab:0,ops=obp+slg,speed=sb+(cs===0&&sb>0?0.5:0);
    const raw=0.35*rIdx(ops,1.4)+0.25*rIdx(tb,4)+0.20*rIdx(rbi+runs,4)+0.10*rIdx(tob,3)+0.10*rIdx(speed,2)-Math.min(12,so*2);
    return Math.max(0,Math.min(99.9,raw*0.52));}
  function pitScore(s){const outs=ipOuts(s.inningsPitched),ip=outs/3;if(ip<=0)return 0;const I=k=>+s[k]||0;const er=I('earnedRuns'),hits=I('hits'),bb=I('baseOnBalls'),so=I('strikeOuts'),gs=I('gamesStarted');
    const qs=gs>0&&outs>=18&&er<=3?1:0,era=(er*9)/ip,whip=(hits+bb)/ip,k9=(so*9)/ip,kImpact=0.65*rIdx(so,6)+0.35*rIdx(k9,10.5),wf=Math.min(1,0.40+0.60*(ip/5));
    const raw=0.34*rIdxInv(Math.max(era,0.1),4.0)+0.24*rIdxInv(Math.max(whip,0.1),1.2)+0.14*kImpact+0.28*rIdx(ip,6.0)+(qs?8:0);
    return Math.max(0,Math.min(99.9,raw*0.50*wf));}
  function hitLine(s){const o=[],I=k=>+s[k]||0;if(I('homeRuns'))o.push(I('homeRuns')+' HR');if(I('rbi'))o.push(I('rbi')+' RBI');if(I('hits'))o.push(I('hits')+' H');if(I('doubles'))o.push(I('doubles')+' 2B');if(I('triples'))o.push(I('triples')+' 3B');if(I('stolenBases'))o.push(I('stolenBases')+' SB');if(I('runs'))o.push(I('runs')+' R');if(I('baseOnBalls'))o.push(I('baseOnBalls')+' BB');return [...new Set(o)].slice(0,3).join(' · ');}
  function pitLine(s){const o=[];if(s.inningsPitched)o.push(s.inningsPitched+' IP');o.push((+s.earnedRuns||0)+' ER');if((+s.strikeOuts||0)>0)o.push((+s.strikeOuts)+' K');return o.slice(0,3).join(' · ');}
  async function loadStars(g){
    const pk=g.gamePk; if(starsCache[pk])return starsCache[pk];
    try{
      const box=await fj(`${API}/game/${pk}/boxscore`); const stars=[];
      ['away','home'].forEach(side=>{const tb=box.teams&&box.teams[side];if(!tb)return;const tid=tb.team.id,abbr=tb.team.abbreviation||'';
        Object.values(tb.players||{}).forEach(pl=>{const pid=pl.person&&pl.person.id;if(!pid)return;
          const bat=(pl.stats&&pl.stats.batting)||{},pit=(pl.stats&&pl.stats.pitching)||{};
          if(ipOuts(pit.inningsPitched)>0){const sc=pitScore(pit);if(sc>=32)stars.push({pid,name:pl.person.fullName,tid,abbr,score:sc,line:pitLine(pit)});}
          if((+bat.hits||0)>0||(+bat.rbi||0)>0||(+bat.runs||0)>0){const sc=hitScore(bat);if(sc>=28)stars.push({pid,name:pl.person.fullName,tid,abbr,score:sc,line:hitLine(bat)});}});});
      stars.sort((a,b)=>b.score-a.score);
      starsCache[pk]=stars.slice(0,3); return starsCache[pk];
    }catch(e){return [];}
  }
  function starCard(s){return `<div class="wb-ptw-p"><img class="wb-ptw-face" src="${head(s.pid)}" style="background:${teamBg(s.tid)}" onerror="this.style.visibility='hidden'"><div style="flex:1;min-width:0"><div class="wb-ptw-nm">${s.name}<span class="wb-ptw-tm">${s.abbr}</span></div><div class="wb-ptw-st">${s.line}</div></div></div>`;}
  async function fillStars(g){
    const box=$('wbstars-'+g.gamePk); if(!box)return;
    const stars=await loadStars(g);
    if(!$('wbstars-'+g.gamePk))return;
    box.innerHTML=stars.length?`<div class="wb-ptw-grid">${stars.map(starCard).join('')}</div>`:'<div class="wb-ptw-loading">No standout performances.</div>';
  }
  // A game is two clubs, and matchup.html already compares any two on rotation,
  // bullpen and lineup. The game object carries both ids — this is a link, not a compute.
  const matchupLink = g =>
    `<a class="wb-matchup-link" href="matchup.html?a=${g.teams.away.team.id}&b=${g.teams.home.team.id}"
        onclick="event.stopPropagation()">Compare rotations, pens &amp; lineups &rarr;</a>`;

  function fillDetail(g){ if(g.status.abstractGameState==='Final') fillStars(g); else fillPTW(g); }

  function toggle(pk){
    const wasOpen=expanded.has(pk);
    if(wasOpen)expanded.delete(pk);else expanded.add(pk);
    const game=document.querySelector(`.wb-game[data-pk="${pk}"]`), d=$('wbd-'+pk);
    if(game)game.classList.toggle('wb-open',!wasOpen);
    if(d)d.classList.toggle('wb-open',!wasOpen);
    if(!wasOpen){const g=lastGames.find(x=>x.gamePk===pk);if(g)fillDetail(g);}
  }

  window.WB={ load:loadDay, day:loadDay, toggle, startClock };
})();

async function loadTopGames(){
  const el = document.getElementById('topGamesContent');
  if (!el || typeof window.WB === 'undefined') return;
  const fmtD = d => d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
  const todayD = new Date(), yD = new Date(todayD), tD = new Date(todayD);
  yD.setDate(todayD.getDate()-1); tD.setDate(todayD.getDate()+1);
  el.innerHTML = `
    <div class="wb-sb">
      <div class="wb-top"><div class="wb-clock" id="wb-clock"><div class="wb-hand wb-hh" id="wb-hh"></div><div class="wb-hand wb-mh" id="wb-mh"></div><div class="wb-hand wb-sh" id="wb-sh"></div><div class="wb-pin"></div></div></div>
      <div class="wb-days" id="wb-days">
        <button class="wb-day" data-day="ayer" onclick="WB.day('ayer')"><span class="wb-d">YESTERDAY</span><span class="wb-dt">${fmtD(yD)}</span></button>
        <button class="wb-day wb-active" data-day="hoy" onclick="WB.day('hoy')"><span class="wb-d">TODAY</span><span class="wb-dt">${fmtD(todayD)}</span></button>
        <button class="wb-day" data-day="manana" onclick="WB.day('manana')"><span class="wb-d">TOMORROW</span><span class="wb-dt">${fmtD(tD)}</span></button>
      </div>
      <div class="wb-board"><div class="wb-scroll"><div class="wb-grid"><div id="wb-games"><div class="wb-loading">LOADING…</div></div></div></div></div>
    </div>`;
  WB.startClock();
  const targetDate = window._topGamesTarget?.date;
  const yKey = yD.toISOString().split('T')[0], tKey = tD.toISOString().split('T')[0];
  const autoDay = targetDate===yKey ? 'ayer' : targetDate===tKey ? 'manana' : 'hoy';
  return WB.load(autoDay);
}

// ── Day router ──────────────────────────────────────────────────────────────────
async function loadTopGamesDay(day) {
  window._tgCurrentDay = day;
  // Update button active state
  ['ayer','hoy','manana'].forEach(d => {
    const btn = document.getElementById('tgbtn-' + d);
    if (btn) btn.classList.toggle('active', d === day);
  });

  const contentEl = document.getElementById('tg-day-content');
  if (!contentEl) return;

  const todayD     = new Date();
  const yesterdayD = new Date(todayD); yesterdayD.setDate(todayD.getDate() - 1);
  const tomorrowD  = new Date(todayD); tomorrowD.setDate(todayD.getDate() + 1);

  const dateMap = { ayer: yesterdayD, hoy: todayD, manana: tomorrowD };
  const dateD   = dateMap[day];
  const dateStr = dateD.toISOString().split('T')[0];

  // Check cache (memory first; 'ayer' is final data, so it also persists in localStorage)
  let cached = window._tgDayCache[day];
  if (!cached && day === 'ayer') {
    const stored = cacheGet('mlb_tg_day_ayer');
    if (stored && stored.dateKey === dateStr) {
      window._tgDayCache[day] = stored;
      cached = stored;
    }
  }
  if (cached && cached.dateKey === dateStr &&
      !(hasCompleteMvpLists() && !cached.hadMvpLists)) {
    contentEl.innerHTML = cached.html;
    return;
  }

  if (day === 'ayer') {
    await _tgLoadAyer(dateD, dateStr, contentEl);
  } else {
    await _tgLoadFuture(day, dateD, dateStr, contentEl);
  }
}

// ── HOY / MAÑANA loader ─────────────────────────────────────────────────────────
async function _tgLoadFuture(day, dateD, dateStr, contentEl) {
  const dayLabel = { ayer: 'YESTERDAY', hoy: 'TODAY', manana: 'TOMORROW' }[day] || day.toUpperCase();
  contentEl.innerHTML = `<div class="loading"><div class="spinner"></div><div class="loading-text">LOADING ${dayLabel}...</div></div>`;
  try {
    if (!hasCompleteMvpLists()) {
      ensureMvpLists().catch(e => console.warn('MVP lists for Top Games failed:', e));
    }

    // Fetch schedule
    const schedRes  = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,linescore,team`);
    const schedData = await schedRes.json();
    const games = (schedData.dates?.[0]?.games || []).filter(g => isTopGamesDisplayableGame(g, day));

    if (!games.length) {
      contentEl.innerHTML = `<p style="color:var(--muted);padding:20px;text-align:center">No games for this day.</p>`;
      return;
    }

    // Collect probable pitcher IDs
    const probableIds = [];
    for (const g of games) {
      const ap = g.teams?.away?.probablePitcher; if (ap?.id) probableIds.push(ap.id);
      const hp = g.teams?.home?.probablePitcher; if (hp?.id) probableIds.push(hp.id);
    }

    // Fetch pitcher season stats + career stats in parallel (forma + ERA/WHIP display + vs-career trend)
    const pitcherFormaMap  = {};  // pid → forma 0-100
    const pitcherStatsMap  = {};  // pid → { era, whip, ip, gs }
    const pitcherCareerMap = {};  // pid → prior-career summary
    if (probableIds.length) {
      try {
        const uniqueIds = [...new Set(probableIds)].join(',');
        const [statsRes, careerRes] = await Promise.all([
          fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${uniqueIds}&hydrate=stats(group=pitching,type=season)`),
          fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${uniqueIds}&hydrate=stats(group=pitching,type=yearByYear)`),
          fetchRecentPitching([...new Set(probableIds)])
        ]);
        const [statsData, careerData] = await Promise.all([statsRes.json(), careerRes.json()]);
        for (const p of (statsData.people || [])) {
          const s = p.stats?.find(st => st.group?.displayName === 'pitching' && st.type?.displayName === 'season')?.splits?.[0]?.stat || {};
          const ip   = parseFloat(s.inningsPitched) || 0;
          const forma = ip >= 5 ? (calcPitcherScoreWithRecent(s, p.id) ?? 0) : 0;
          pitcherFormaMap[p.id]       = forma;
          pitcherFormaMap[p.fullName] = forma;
          pitcherStatsMap[p.id] = { era: s.era || '—', whip: s.whip || '—', ip: s.inningsPitched || '—', gs: s.gamesStarted ?? '—' };
        }
        for (const p of (careerData.people || [])) {
          pitcherCareerMap[p.id] = pitcherCareerMap[p.id] || {};
          if (p.mlbDebutDate) pitcherCareerMap[p.id].debutYear = parseInt(p.mlbDebutDate.slice(0, 4));
          Object.assign(pitcherCareerMap[p.id], summarizePriorPitching(p));
        }
      } catch(e) { /* non-critical */ }
    }

    // Build award-candidate sets (if MVP data loaded)
    const candidatesByTeam = {};
    const spAwardMap = {};  // pid → awardKeys — for showing badges on SP cards
    if (window._mvpLists) {
      const ml = window._mvpLists;
      const flatCands = [
        ...(ml.alMVP  || []).map(c => ({...c, awardKey:'MVP'})),
        ...(ml.nlMVP  || []).map(c => ({...c, awardKey:'MVP'})),
        ...(ml.alCY   || []).map(c => ({...c, awardKey:'CY'})),
        ...(ml.nlCY   || []).map(c => ({...c, awardKey:'CY'})),
        ...(ml.alROY  || []).map(c => ({...c, awardKey:'ROY'})),
        ...(ml.nlROY  || []).map(c => ({...c, awardKey:'ROY'})),
      ];
      for (const c of flatCands) {
        const keys = [...new Set([c.teamId, c.teamAbbr].filter(Boolean).map(String))];
        if (!keys.length) continue;
        for (const key of keys) {
          if (!candidatesByTeam[key]) candidatesByTeam[key] = [];
          const dup = candidatesByTeam[key].find(x => x.pid === c.pid);
          if (dup) { if (!dup.awardKeys.includes(c.awardKey)) dup.awardKeys.push(c.awardKey); }
          else candidatesByTeam[key].push({...c, awardKeys:[c.awardKey]});
        }
        // Also index by pid for SP card lookup
        if (!spAwardMap[c.pid]) spAwardMap[c.pid] = [];
        if (!spAwardMap[c.pid].includes(c.awardKey)) spAwardMap[c.pid].push(c.awardKey);
      }
    }

    // Fetch season stats for award candidates (for Players to Watch section)
    const ptwStats = {};  // pid → {type:'hitter'|'pitcher', ...stats}
    const candPids = [...new Set(
      Object.values(candidatesByTeam).flat().map(c => c.pid).filter(Boolean)
    )];
    if (candPids.length) {
      try {
        const [hitRes, pitRes] = await Promise.all([
          fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${candPids.join(',')}&hydrate=stats(group=hitting,type=season)`),
          fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${candPids.join(',')}&hydrate=stats(group=pitching,type=season)`)
        ]);
        const [hitData, pitData] = await Promise.all([hitRes.json(), pitRes.json()]);
        for (const p of (hitData.people || [])) {
          const s = p.stats?.find(st => st.group?.displayName==='hitting' && st.type?.displayName==='season')?.splits?.[0]?.stat || {};
          if (s.atBats || s.gamesPlayed) ptwStats[p.id] = { type:'hitter', ...s };
        }
        for (const p of (pitData.people || [])) {
          const s = p.stats?.find(st => st.group?.displayName==='pitching' && st.type?.displayName==='season')?.splits?.[0]?.stat || {};
          if (s.inningsPitched) {
            if (!ptwStats[p.id]) ptwStats[p.id] = { type:'pitcher', ...s };
          }
        }
        await fetchRecentPitching(Object.entries(ptwStats).filter(([, s]) => s.type === 'pitcher').map(([pid]) => Number(pid)));
      } catch(e) { /* non-critical */ }
    }

    // ── Self-contained row renderers ───────────────────────────────────────
    function _fSpCard(pitcher, teamMeta, state) {
      const spLabel = (state==='Live'||state==='Final') ? 'STARTING PITCHER' : 'PROBABLE SP';
      const teamPill = teamMeta ? `<div style="display:flex;align-items:center;gap:5px;margin-bottom:6px">
        <img src="${teamMeta.logo}" style="width:16px;height:16px;object-fit:contain" onerror="this.style.display='none'">
        <span style="font-family:'Barlow Condensed';font-weight:700;font-size:11px;color:var(--muted)">${teamMeta.abbr}</span>
      </div>` : '';
      if (!pitcher) {
        return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:10px 12px;width:100%">
          ${teamPill}
          <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">${spLabel}</div>
          <div style="font-family:'Barlow Condensed';font-weight:700;font-size:14px;color:var(--muted)">TBD</div>
        </div>`;
      }
      const pid   = pitcher.id;
      const name  = pitcher.fullName || '?';
      const forma = pitcherFormaMap[pid] ?? 0;
      const ps    = pitcherStatsMap[pid] || {};
      const color = getDiamondPlayerColor(forma, 'pitcher');
      let bg = 'var(--surface2)', bdr = 'var(--border)', lc = 'var(--muted)';
      if (pid) {
        bg  = `${color}17`;            // ~9% tint of the form color
        bdr = `${color}47`;            // ~28% border of the form color
        lc  = statTextColor(color);    // readable label matching the form value
      }
      const photoUrl = siloHeadshot(pid); const photoBg = teamPhotoBg(teamMeta);
      const barW = Math.min(100, Math.round((forma/100)*100));
      const career = pitcherCareerMap[pid];
      const isRookiePitcher = pid && (isRookieCareerEligible(pid, career, 'pitcher') || (spAwardMap[pid]||[]).includes('ROY'));
      const spTrend = (!isRookiePitcher && career?.formaScore != null) ? trendFormaHTML(forma, career.formaScore) : '';
      const rookieBadge = isRookiePitcher ? `<span class="rookie-badge">R</span>` : '';
      return `<div style="background:${bg};border:1px solid ${bdr};border-radius:7px;padding:10px 12px;width:100%">
        ${teamPill}
        <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:${lc};text-transform:uppercase;margin-bottom:6px">${spLabel}</div>
        <div style="display:grid;grid-template-columns:1fr 52px;gap:8px;align-items:start">
          <div class="impact-row-left" style="grid-column:1;grid-row:1/3">
            <img class="impact-photo" src="${photoUrl}" style="background:${photoBg}"
              onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
            <div class="impact-name-block">
              <div class="impact-name" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name} ${rookieBadge}</div>
              <div class="impact-stats-line">ERA ${ps.era||'—'} · WHIP ${ps.whip||'—'}</div>
              <div class="impact-stats-line">IP ${ps.ip||'—'} · GS ${ps.gs??'—'}</div>
              ${(spAwardMap[pid]||[]).length ? `<div style="margin-top:5px;display:flex;gap:4px;flex-wrap:wrap">${(spAwardMap[pid]||[]).map(k => `<span class="mvp-award-badge" style="cursor:pointer" onclick="event.stopPropagation();goToMVPFromTopGames('${k}')">${{MVP:'MVP RACE',CY:'CY RACE',ROY:'ROY RACE'}[k]||k}</span>`).join('')}</div>` : ''}
            </div>
          </div>
          <div class="impact-bar-val-wrap">
            <span class="impact-bar-label">FORM</span>
            <span class="impact-bar-val" style="color:${statTextColor(color)};font-size:20px">${Math.round(Math.max(0,forma))}</span>
            <div class="impact-bar-block" style="grid-column:auto;grid-row:auto;height:4px;width:100%;margin:3px 0 0 auto">
              <div class="impact-bar-bg"><div class="impact-bar-fill" style="width:${barW}%;background:${color}"></div></div>
            </div>
            ${spTrend ? `<div style="margin-top:3px;text-align:right">${spTrend}</div>` : ''}
          </div>
        </div>
      </div>`;
    }

    function _fPtwCard(c, teamMeta) {
      const pid    = c.pid;
      const stats  = ptwStats[pid] || {};
      const keys   = c.awardKeys || [c.awardKey].filter(Boolean);
      const isPitcher = stats.type === 'pitcher' || keys.includes('CY');
      const rookieBadge = keys.includes('ROY') ? `<span class="rookie-badge">R</span>` : '';
      const forma  = isPitcher ? (calcPitcherScoreWithRecent(stats, pid) ?? 0) : 0;
      const opsVal = isPitcher ? 0 : (parseFloat(stats.ops) || 0);
      const color  = isPitcher ? getDiamondPlayerColor(forma, 'pitcher') : getDiamondPlayerColor(opsVal, 'hitter');
      const photoUrl = siloHeadshot(pid); const photoBg = teamPhotoBg(teamMeta);
      const teamPill = teamMeta ? `<span style="display:inline-flex;align-items:center;gap:3px;flex-shrink:0">
        <img src="${teamMeta.logo}" style="width:14px;height:14px;object-fit:contain" onerror="this.style.display='none'">
        <span style="font-family:'Barlow Condensed';font-weight:700;font-size:11px;color:var(--muted)">${teamMeta.abbr}</span>
      </span>` : '';
      const labelMap = {MVP:'MVP RACE',CY:'CY RACE',ROY:'ROY RACE'};
      const order    = {MVP:0,CY:1,ROY:2};
      const threshold = {MVP:10,CY:10,ROY:5};
      // Use live rank from _mvpLists if available; fall back to cached rank on the candidate
      const effectiveLabels = [];
      if (window._mvpLists) {
        const ml = window._mvpLists;
        const listsMap = {
          MVP: [...(ml.alMVP||[]), ...(ml.nlMVP||[])],
          CY:  [...(ml.alCY||[]),  ...(ml.nlCY||[])],
          ROY: [...(ml.alROY||[]), ...(ml.nlROY||[])],
        };
        for (const [key, list] of Object.entries(listsMap)) {
          const found = list.find(p => p.pid === pid);
          if (found) effectiveLabels.push({key, rank:found.rank});
        }
      } else {
        for (const key of keys) effectiveLabels.push({key, rank: c.rank || 99});
      }
      const badges = effectiveLabels
        .filter(e => e.rank <= (threshold[e.key]??0))
        .sort((a,b) => (order[a.key]??99)-(order[b.key]??99)||a.rank-b.rank)
        .map(e => `<span class="mvp-award-badge" style="cursor:pointer" onclick="event.stopPropagation();goToMVPFromTopGames('${e.key}')">${labelMap[e.key]||e.key}</span>`)
        .join(' ');
      let statsLine = '';
      if (isPitcher && stats.era) statsLine = `ERA ${stats.era} · WHIP ${stats.whip||'—'} · IP ${stats.inningsPitched||'—'}`;
      else if (!isPitcher && stats.avg) statsLine = `AVG ${stats.avg} · HR ${stats.homeRuns??'—'} · RBI ${stats.rbi??'—'}`;
      return `<div class="impact-row">
        <div class="impact-row-left">
          <img class="impact-photo" src="${photoUrl}" style="background:${photoBg}"
            onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
          <div class="impact-name-block">
            <div class="impact-name">${c.name||'?'} ${rookieBadge} ${teamPill}</div>
            ${statsLine ? `<div class="impact-stats-line">${statsLine}</div>` : ''}
            ${badges ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">${badges}</div>` : ''}
          </div>
        </div>
      </div>`;
    }

    function _ftrRow(g, gIdx, isTopMatch) {
      const away = g.teams.away, home = g.teams.home;
      const tid_a = away.team.id, tid_h = home.team.id;
      const mA = (typeof TEAM_META!=='undefined'&&TEAM_META[tid_a]) || { abbr:away.team.abbreviation||'?', logo:`https://www.mlbstatic.com/team-logos/${tid_a}.svg` };
      const mH = (typeof TEAM_META!=='undefined'&&TEAM_META[tid_h]) || { abbr:home.team.abbreviation||'?', logo:`https://www.mlbstatic.com/team-logos/${tid_h}.svg` };
      const state = g.status?.abstractGameState;
      const isPostponed = isPostponedLikeGame(g);
      const gdate = new Date(g.gameDate);
      const timeStr = gdate.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
      const inningLabel = g.linescore?.currentInningOrdinal || 'LIVE';
      const statusText  = isPostponed ? 'POSTPONED' : state==='Live' ? `● ${inningLabel}` : state==='Final' ? 'FINAL' : timeStr;
      const statusStyle = isPostponed
        ? "padding:0;font-size:11px;letter-spacing:.5px;color:var(--loss)"
        : state==='Live'
        ? "padding:0;font-size:11px;letter-spacing:.5px;color:var(--win);animation:pulse 1.5s infinite"
        : "padding:0;font-size:11px;letter-spacing:.5px;color:var(--muted)";
      const aScore = (!isPostponed && (state==='Live'||state==='Final')) ? (away.score??'0') : '';
      const hScore = (!isPostponed && (state==='Live'||state==='Final')) ? (home.score??'0') : '';
      const aWon = state==='Final' && typeof away.score==='number' && typeof home.score==='number' && away.score > home.score;
      const hWon = state==='Final' && typeof home.score==='number' && typeof away.score==='number' && home.score > away.score;
      const sA = aWon ? 'font-weight:800;color:var(--text)' : state==='Final' ? 'color:var(--muted)' : '';
      const sH = hWon ? 'font-weight:800;color:var(--text)' : state==='Final' ? 'color:var(--muted)' : '';
      const scoreHTML = aScore !== ''
        ? `<span class="tg-score" style="${sA}">${aScore}</span><span class="tg-sep">-</span><span class="tg-score" style="${sH}">${hScore}</span>`
        : `<span class="tg-sep" style="padding:0 2px">@</span>`;
      const topBadge = isTopMatch
        ? `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:3px;background:rgba(22,163,74,.15);color:#16a34a;border:1px solid rgba(22,163,74,.3);letter-spacing:.5px">TOP MATCH</span>`
        : '';
      const gameId   = `${dateStr}-${gIdx}`;
      const venue    = g.venue?.name || '';
      const awayP    = away.probablePitcher || null;
      const homeP    = home.probablePitcher || null;
      const awayAbbr = away.team?.abbreviation || '';
      const homeAbbr = home.team?.abbreviation || '';
      const sameDivision = away.team?.division?.id && away.team?.division?.id === home.team?.division?.id;
      const _notSp = (c) => {
        if (c.pid === awayP?.id || c.pid === homeP?.id) return false; // already in SP card
        const st = ptwStats[c.pid];
        if (st?.type === 'pitcher' && parseInt(st.gamesStarted || 0) >= 2) return false; // starter
        return true;
      };
      const teamCandidates = (teamId, abbr, metaAbbr) =>
        candidatesByTeam[String(teamId)] ||
        candidatesByTeam[metaAbbr] ||
        candidatesByTeam[abbr] ||
        [];
      const awayCands  = teamCandidates(tid_a, awayAbbr, mA.abbr).filter(_notSp);
      const homeCands  = teamCandidates(tid_h, homeAbbr, mH.abbr).filter(_notSp);
      const allCands   = [...awayCands.map(c=>({...c,tm:mA})), ...homeCands.map(c=>({...c,tm:mH}))]
        .sort((a,b) => (a.rank||99)-(b.rank||99)).slice(0, 4);
      return `<div class="tg-game-card">
        <div class="tg-game-row" id="tgr-${gameId}" data-gamepk="${g.gamePk}" onclick="tgToggleGame('${gameId}')">
          <div class="tg-teams">
            <img class="tg-team-logo" src="${mA.logo}" onerror="this.style.display='none'" alt="">
            <span class="tg-abbr" style="${sA}">${mA.abbr}</span>
            ${scoreHTML}
            <span class="tg-abbr" style="${sH}">${mH.abbr}</span>
            <img class="tg-team-logo" src="${mH.logo}" onerror="this.style.display='none'" alt="">
          </div>
          <div class="tg-badges">${topBadge}</div>
          <div style="text-align:right;flex-shrink:0;padding-left:10px">
            <div class="tg-time" style="${statusStyle}">${statusText}</div>
            ${venue ? `<div style="font-family:'Barlow Condensed';font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;margin-top:1px">${venue}</div>` : ''}
          </div>
        </div>
        <div class="tg-detail" id="tgd-${gameId}">
          ${sameDivision ? `<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><span style="font-size:10px;font-weight:700;padding:2px 7px;background:rgba(234,179,8,.15);color:#b45309;border-radius:3px;letter-spacing:.5px">DIVISIONAL</span></div>` : ''}
          <div class="tg-detail-inner">
            <div class="tg-detail-col">${_fSpCard(awayP, mA, state)}</div>
            <div class="tg-detail-col">${_fSpCard(homeP, mH, state)}</div>
          </div>
          ${allCands.length ? `<div class="impact-detail-card" style="margin-top:10px">
            <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--accent);text-transform:uppercase;margin-bottom:6px">PLAYERS TO WATCH</div>
            ${allCands.map(c => _fPtwCard(c, c.tm)).join('')}
          </div>` : ''}
        </div>
      </div>`;
    }
    // ── End row renderers ──────────────────────────────────────────────────

    // Compute scores & render
    let html = '';
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const gameProbables = {
        ...g,
        probables: { away: g.teams?.away?.probablePitcher || null, home: g.teams?.home?.probablePitcher || null }
      };
      const tms = calcTopMatchScore(gameProbables, pitcherFormaMap, candidatesByTeam);
      html += _ftrRow(g, i, tms.isTopMatch);
    }

    contentEl.innerHTML = html || `<p style="color:var(--muted);padding:20px;text-align:center">No featured games.</p>`;

    window._tgDayCache[day] = {
      dateKey: dateStr,
      html: contentEl.innerHTML,
      hadMvpLists: hasCompleteMvpLists()
    };
    // If MVP data wasn't loaded yet, schedule a refresh for when it arrives
    if (!hasCompleteMvpLists()) window._tgNeedsRefresh = true;
  } catch(e) {
    contentEl.innerHTML = errorStateHTML(`loadTopGamesDay('${day}')`);
    console.error('_tgLoadFuture error:', e);
  }
}

// ── AYER loader (progressive) ──────────────────────────────────────────────────
async function _tgLoadAyer(dateD, dateStr, contentEl) {
  // ── Self-contained helpers ────────────────────────────────────────────────
  function _aIntStat(v) { return parseInt(v, 10) || 0; }
  function _aParseIp(ip) {
    if (!ip && ip !== 0) return 0;
    const [w, f = '0'] = String(ip).split('.');
    return (parseInt(w, 10) || 0) * 3 + (parseInt(f, 10) || 0);
  }
  function _aRatioIdx(val, ref) {
    if (!ref || ref <= 0) return 0;
    return Math.min(200, Math.max(0, (val / ref) * 100));
  }
  function _aRatioIdxInv(val, ref) {
    if (!val || val <= 0) return 200;
    if (!ref || ref <= 0) return 0;
    return Math.min(200, Math.max(0, (ref / val) * 100));
  }
  function _aHitterScore(s) {
    const ab = _aIntStat(s.atBats), h = _aIntStat(s.hits);
    const d = _aIntStat(s.doubles), t = _aIntStat(s.triples), hr = _aIntStat(s.homeRuns);
    const bb = _aIntStat(s.baseOnBalls), hbp = _aIntStat(s.hitByPitch), sf = _aIntStat(s.sacFlies);
    const rbi = _aIntStat(s.rbi), runs = _aIntStat(s.runs), sb = _aIntStat(s.stolenBases);
    const cs = _aIntStat(s.caughtStealing), so = _aIntStat(s.strikeOuts);
    const singles = Math.max(0, h - d - t - hr);
    const tb = singles + d*2 + t*3 + hr*4;
    const pa = ab + bb + hbp + sf;
    const tob = h + bb + hbp;
    const obp = pa > 0 ? tob/pa : 0;
    const slg = ab > 0 ? tb/ab : 0;
    const ops = obp + slg;
    const speed = sb + (cs === 0 && sb > 0 ? 0.5 : 0);
    const raw = 0.35*_aRatioIdx(ops,1.4) + 0.25*_aRatioIdx(tb,4) + 0.20*_aRatioIdx(rbi+runs,4) + 0.10*_aRatioIdx(tob,3) + 0.10*_aRatioIdx(speed,2) - Math.min(12,so*2);
    return Math.max(0, Math.min(99.9, raw*0.52));
  }
  function _aPitcherScore(s) {
    const outs = _aParseIp(s.inningsPitched);
    const ip = outs/3;
    if (ip <= 0) return 0;
    const er = _aIntStat(s.earnedRuns), hits = _aIntStat(s.hits);
    const bb = _aIntStat(s.baseOnBalls), so = _aIntStat(s.strikeOuts);
    const gs = _aIntStat(s.gamesStarted);
    const qs = gs > 0 && outs >= 18 && er <= 3 ? 1 : 0;
    const era = (er*9)/ip, whip = (hits+bb)/ip, k9 = (so*9)/ip;
    const kImpact = 0.65*_aRatioIdx(so,6) + 0.35*_aRatioIdx(k9,10.5);
    const wf = Math.min(1, 0.40 + 0.60*(ip/5));
    const raw = 0.34*_aRatioIdxInv(Math.max(era,0.1),4.0) + 0.24*_aRatioIdxInv(Math.max(whip,0.1),1.2) + 0.14*kImpact + 0.28*_aRatioIdx(ip,6.0) + (qs?8:0);
    return Math.max(0, Math.min(99.9, raw*0.50*wf));
  }
  function _aHitterTopStats(s) {
    const out = [];
    if (_aIntStat(s.homeRuns) > 0)  out.push(`${_aIntStat(s.homeRuns)} HR`);
    if (_aIntStat(s.rbi) > 0)       out.push(`${_aIntStat(s.rbi)} RBI`);
    if (_aIntStat(s.hits) > 0)      out.push(`${_aIntStat(s.hits)} H`);
    if (_aIntStat(s.doubles) > 0)   out.push(`${_aIntStat(s.doubles)} 2B`);
    if (_aIntStat(s.triples) > 0)   out.push(`${_aIntStat(s.triples)} 3B`);
    if (_aIntStat(s.stolenBases) > 0) out.push(`${_aIntStat(s.stolenBases)} SB`);
    if (_aIntStat(s.baseOnBalls) > 0) out.push(`${_aIntStat(s.baseOnBalls)} BB`);
    if (_aIntStat(s.runs) > 0)      out.push(`${_aIntStat(s.runs)} R`);
    return [...new Set(out)].slice(0, 3);
  }
  function _aPitcherTopStats(s) {
    const out = [];
    if (s.inningsPitched) out.push(`${s.inningsPitched} IP`);
    out.push(`${_aIntStat(s.earnedRuns)} ER`);
    if (_aIntStat(s.strikeOuts) > 0) out.push(`${_aIntStat(s.strikeOuts)} K`);
    else if (_aIntStat(s.baseOnBalls) === 0) out.push('0 BB');
    return out.slice(0, 3);
  }
  function _aSpecialBadgeHTML(label) {
    return `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:3px;background:rgba(168,85,247,.15);color:#a855f7;border:1px solid rgba(168,85,247,.3);letter-spacing:.5px">${label}</span>`;
  }
  function _aIsExtraInnings(g) {
    if (g.status?.abstractGameState !== 'Final') return false;
    const scheduled = g.linescore?.scheduledInnings || 9;
    const current = g.linescore?.currentInning || 0;
    const innings = g.linescore?.innings?.length || 0;
    return current > scheduled || innings > scheduled;
  }
  function _aDetectNoHitTag(g, box) {
    if (g.status?.abstractGameState !== 'Final') return null;
    const ls = g.linescore;
    if (!ls) return null;
    const awayHits = ls.teams?.away?.hits ?? null;
    const homeHits = ls.teams?.home?.hits ?? null;
    if (awayHits === null || homeHits === null) return null;

    let noHitSide = null;
    if (awayHits === 0) noHitSide = 'away';
    else if (homeHits === 0) noHitSide = 'home';
    if (!noHitSide) return null;

    const pitchingSide = noHitSide === 'away' ? 'home' : 'away';
    const isCombined = (box?.teams?.[pitchingSide]?.pitchers?.length ?? 1) > 1;
    const bat = box?.teams?.[noHitSide]?.teamStats?.batting || {};
    const walks = bat.baseOnBalls ?? 1;
    const hbp = bat.hitByPitch ?? 0;
    const errorsByPitchingTeam = ls.teams?.[pitchingSide]?.errors ?? 1;
    const isPerfect = walks === 0 && hbp === 0 && errorsByPitchingTeam === 0;

    if (isPerfect && isCombined) return 'COMBINED PERFECT GAME';
    if (isPerfect) return 'PERFECT GAME';
    if (isCombined) return 'COMBINED NO-HITTER';
    return 'NO-HITTER';
  }
  function _aHasCompleteGame(box) {
    if (!box?.teams) return false;
    return ['away','home'].some(side =>
      Object.values(box.teams?.[side]?.players || {}).some(player =>
        _aParseIp(player.stats?.pitching?.inningsPitched) >= 27
      )
    );
  }
  function _aDetectWalkoffTag(g, feed) {
    if (g.status?.abstractGameState !== 'Final') return null;
    const awayScore = g.teams?.away?.score;
    const homeScore = g.teams?.home?.score;
    if (typeof awayScore !== 'number' || typeof homeScore !== 'number' || homeScore <= awayScore) return null;

    const plays = feed?.liveData?.plays?.allPlays || [];
    const lastPlay = plays[plays.length - 1];
    if (!lastPlay || lastPlay.about?.halfInning !== 'bottom') return null;

    const event = `${lastPlay.result?.eventType || ''} ${lastPlay.result?.event || ''}`.toLowerCase();
    return event.includes('home_run') || event.includes('home run') ? 'WALK-OFF HR' : 'WALK-OFF';
  }
  function _aGameTagsHTML(g, box, feed) {
    const tags = [];
    const noHitTag = _aDetectNoHitTag(g, box);
    const walkoffTag = _aDetectWalkoffTag(g, feed);
    if (noHitTag) tags.push(noHitTag);
    if (_aHasCompleteGame(box)) tags.push('COMPLETE GAME');
    if (_aIsExtraInnings(g)) tags.push('EXTRA INNINGS');
    if (walkoffTag) tags.push(walkoffTag);
    return tags.map(_aSpecialBadgeHTML).join('');
  }

  function _aSelectStars(box) {
    const hitters = [], pitchers = [];
    if (!box?.teams) return [];
    ['away','home'].forEach(side => {
      const teamBox = box.teams[side];
      const teamId  = teamBox?.team?.id;
      if (!teamId) return;
      const teamMeta = (typeof TEAM_META !== 'undefined' && TEAM_META[teamId]) || {
        abbr: teamBox.team?.abbreviation || '?',
        logo: `https://www.mlbstatic.com/team-logos/${teamId}.svg`
      };
      Object.values(teamBox.players || {}).forEach(player => {
        const pid  = player.person?.id;
        const name = player.person?.fullName || '?';
        if (!pid) return;
        const gamePos = (player.allPositions?.[0]?.abbreviation) || player.position?.abbreviation || '';
        const bat = player.stats?.batting  || {};
        const pit = player.stats?.pitching || {};
        const pa  = _aIntStat(bat.atBats) + _aIntStat(bat.baseOnBalls) + _aIntStat(bat.hitByPitch) + _aIntStat(bat.sacFlies);
        const hasBat = pa > 0 || _aIntStat(bat.hits) > 0 || _aIntStat(bat.rbi) > 0 || _aIntStat(bat.runs) > 0;
        const hasPit = _aParseIp(pit.inningsPitched) > 0 || _aIntStat(pit.battersFaced) > 0;
        if (hasBat) hitters.push({ pid, name, teamMeta, type:'hitter', displayRole: gamePos && gamePos!=='P' && gamePos!=='TWP' ? gamePos : '', score:_aHitterScore(bat), topStats:_aHitterTopStats(bat), photoUrl:siloHeadshot(pid) });
        if (hasPit) pitchers.push({ pid, name, teamMeta, type:'pitcher', displayRole:'PITCHER', score:_aPitcherScore(pit), topStats:_aPitcherTopStats(pit), photoUrl:siloHeadshot(pid) });
      });
    });
    hitters.sort((a,b) => b.score-a.score);
    pitchers.sort((a,b) => b.score-a.score);
    const used = new Set();
    const next = (arr) => arr.find(p => !used.has(p.pid)) || null;
    const MIN_H = 28, MIN_P = 32, ELITE_P = 72, STRONG_P2 = 64;
    const bestH = next(hitters), bestP = next(pitchers);
    let selected = [];
    if (!bestP || bestP.score < MIN_P) {
      if (bestH && bestH.score >= MIN_H) { selected.push(bestH); used.add(bestH.pid); }
      const h2 = next(hitters); if (h2 && h2.score >= MIN_H) { selected.push(h2); used.add(h2.pid); }
      if (selected.length < 2 && bestP && bestP.score >= MIN_P) selected.push(bestP);
    } else {
      used.add(bestP.pid);
      const bestP2 = next(pitchers);
      if (bestP && bestP2 && bestP.score >= ELITE_P && bestP2.score >= STRONG_P2) {
        selected = [bestP, bestP2];
      } else {
        used.delete(bestP.pid);
        if (bestH && bestH.score >= MIN_H) { selected.push(bestH); used.add(bestH.pid); }
        if (bestP && bestP.score >= MIN_P && !used.has(bestP.pid)) { selected.push(bestP); used.add(bestP.pid); }
        if (selected.length < 2) {
          const fb = next(bestH ? pitchers : hitters);
          if (fb) { const ok = fb.type==='pitcher' ? fb.score>=MIN_P : fb.score>=MIN_H; if(ok) selected.push(fb); }
        }
      }
    }
    return selected.filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,2);
  }

  function _aIsRookie(pid, type) {
    if (NON_ROOKIE_OVERRIDES.has(pid)) return false;
    const career = careerStatsCache[pid];
    if (!career) return false;
    if (type === 'pitcher') return isRookieEligible(pid, 'pitcher');
    return isRookieEligible(pid, 'hitter');
  }

  function _aStarRowHTML(p) {
    const teamPill = `<span style="display:inline-flex;align-items:center;gap:3px;flex-shrink:0"><img src="${p.teamMeta.logo}" style="width:14px;height:14px;object-fit:contain" onerror="this.style.display='none'"><span style="font-family:'Barlow Condensed';font-weight:700;font-size:11px;color:var(--muted)">${p.teamMeta.abbr}</span></span>`;
    const roleBadge = p.displayRole ? `<span class="sec-pos-badge">${p.displayRole}</span>` : '';
    const rookieBadge = p.isRookie ? `<span class="rookie-badge">R</span>` : '';
    const statsLine = p.topStats.join(' · ') || (p.type==='pitcher' ? '0 ER' : '1 H');
    return `<div class="impact-row">
      <div class="impact-row-left">
        <img class="impact-photo" src="${p.photoUrl}" style="background:${teamPhotoBg(p.teamMeta)}" onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
        <div class="impact-name-block">
          <div class="impact-name">${p.name} ${roleBadge} ${rookieBadge} ${teamPill}</div>
          <div class="impact-stats-line">${statsLine}</div>
        </div>
      </div>
    </div>`;
  }

  async function _aKeyPlayersHTML(box) {
    const sel = _aSelectStars(box);
    if (!sel.length) return '';
    await fetchCareerStats(sel.map(p => p.pid).filter(Boolean)).catch(() => {});
    sel.forEach(p => { p.isRookie = _aIsRookie(p.pid, p.type); });
    return `<div class="impact-detail-card" style="background:#fff;border-color:#dfe6f2;box-shadow:0 1px 4px rgba(15,25,35,.04)">
      <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--accent);text-transform:uppercase;margin-bottom:6px">Key Performances</div>
      ${sel.map(p => _aStarRowHTML(p)).join('')}
    </div>`;
  }

  function _aBasicRowHTML(g, idx) {
    const away = g.teams.away, home = g.teams.home;
    const tid_a = away.team.id, tid_h = home.team.id;
    const mA = (typeof TEAM_META!=='undefined'&&TEAM_META[tid_a]) || { abbr:away.team.abbreviation||'?', logo:`https://www.mlbstatic.com/team-logos/${tid_a}.svg` };
    const mH = (typeof TEAM_META!=='undefined'&&TEAM_META[tid_h]) || { abbr:home.team.abbreviation||'?', logo:`https://www.mlbstatic.com/team-logos/${tid_h}.svg` };
    const aScore = away.score ?? '—', hScore = home.score ?? '—';
    const aWon = typeof aScore==='number' && typeof hScore==='number' && aScore > hScore;
    const hWon = typeof hScore==='number' && typeof aScore==='number' && hScore > aScore;
    const sA = aWon ? 'font-weight:800;color:var(--text)' : 'color:var(--muted)';
    const sH = hWon ? 'font-weight:800;color:var(--text)' : 'color:var(--muted)';
    const gameId = `ayer-${idx}`;
    const venue  = g.venue?.name || '';
    const status = g.status?.detailedState === 'Final' ? 'FINAL' : g.status?.detailedState || '';
    return `<div class="tg-game-card">
      <div class="tg-game-row" id="tgr-${gameId}" data-gamepk="${g.gamePk}" onclick="tgToggleGame('${gameId}')">
        <div class="tg-teams">
          <img class="tg-team-logo" src="${mA.logo}" onerror="this.style.display='none'" alt="">
          <span class="tg-abbr" style="${sA}">${mA.abbr}</span>
          <span class="tg-score" style="${sA}">${aScore}</span>
          <span class="tg-sep">-</span>
          <span class="tg-score" style="${sH}">${hScore}</span>
          <span class="tg-abbr" style="${sH}">${mH.abbr}</span>
          <img class="tg-team-logo" src="${mH.logo}" onerror="this.style.display='none'" alt="">
        </div>
        <div class="tg-badges" id="tgbadges-${g.gamePk}">${_aIsExtraInnings(g) ? _aSpecialBadgeHTML('EXTRA INNINGS') : ''}</div>
        <div style="text-align:right;flex-shrink:0;padding-left:10px">
          <div class="tg-time" style="padding:0;font-size:11px;letter-spacing:.5px;color:var(--muted)">${status}</div>
          ${venue ? `<div style="font-family:'Barlow Condensed';font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;margin-top:1px">${venue}</div>` : ''}
        </div>
      </div>
      <div class="tg-detail" id="tgd-${gameId}">
        <div id="tgstars-${g.gamePk}" style="font-family:'Barlow Condensed';font-size:13px;color:var(--muted)">Loading key performances...</div>
      </div>
    </div>`;
  }
  // ── End helpers ────────────────────────────────────────────────────────────

  contentEl.innerHTML = `<div class="loading"><div class="spinner"></div><div class="loading-text">LOADING YESTERDAY...</div></div>`;
  try {
    const schedRes  = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=linescore,decisions,probables,team`);
    const schedData = await schedRes.json();
    const games     = schedData.dates?.[0]?.games || [];

    if (!games.length) {
      contentEl.innerHTML = `<p style="color:var(--muted);padding:20px;text-align:center">No games for this day.</p>`;
      return;
    }

    // Render all rows immediately with loading placeholders
    contentEl.innerHTML = games.map((g, i) => _aBasicRowHTML(g, i)).join('');

    // Progressive: start all data requests immediately, then let each row update as soon as it can.
    const gameDataTasks = games.map(g => {
      const gId = g.gamePk;
      const boxPromise = fetch(`https://statsapi.mlb.com/api/v1/game/${gId}/boxscore?fields=${TG_BOXSCORE_FIELDS}`).then(r => r.json());
      const feedPromise = fetch(`https://statsapi.mlb.com/api/v1.1/game/${gId}/feed/live?fields=liveData,plays,allPlays,result,event,eventType,about,halfInning`).then(r => r.json()).catch(() => null);
      return { g, gId, boxPromise, feedPromise };
    });

    await Promise.all(gameDataTasks.map(async ({ g, gId, boxPromise, feedPromise }) => {
      const placeholder = document.getElementById('tgstars-' + gId);
      try {
        const [box, feed] = await Promise.all([boxPromise, feedPromise]);
        const badgesEl = document.getElementById('tgbadges-' + gId);
        if (badgesEl) badgesEl.innerHTML = _aGameTagsHTML(g, box, feed);

        if (!placeholder) return;
        const starsHtml = await _aKeyPlayersHTML(box);
        placeholder.outerHTML = starsHtml ||
          `<div style="font-family:'Barlow Condensed';font-size:13px;color:var(--muted)">No key performances.</div>`;
      } catch(e) {
        if (placeholder) placeholder.outerHTML = '';
      }
    }));

    // Cache final state
    window._tgDayCache['ayer'] = {
      dateKey: dateStr,
      html: contentEl.innerHTML,
      hadMvpLists: !!window._mvpLists
    };
    cacheSet('mlb_tg_day_ayer', window._tgDayCache['ayer']);
  } catch(e) {
    contentEl.innerHTML = errorStateHTML("loadTopGamesDay('ayer')");
    console.error('_tgLoadAyer error:', e);
  }
}

async function _OLD_loadTopGames() {
  const el = document.getElementById('topGamesContent');
  const todayKey = new Date().toISOString().split('T')[0];
  const cache = window._topGamesCache;
  if (cache?.dateKey === todayKey && !(window._mvpLists && !cache.hadMvpLists)) {
    el.innerHTML = cache.html;
    return;
  }
  el.innerHTML = `<div class="loading"><div class="spinner"></div><div class="loading-text">LOADING TOP GAMES...</div></div>`;
  try {
    const todayD = new Date();
    const yesterdayD = new Date(todayD); yesterdayD.setDate(todayD.getDate() - 1);
    const tomorrowD  = new Date(todayD); tomorrowD.setDate(todayD.getDate() + 1);
    const fmt = d => d.toISOString().split('T')[0];

    const [yData, todayData, tmrData] = await Promise.all([
      fetchWithTimeout(`${MLB_API}/schedule?sportId=1&date=${fmt(yesterdayD)}&gameType=R&hydrate=team,linescore`).then(r=>r.json()).catch(()=>({dates:[]})),
      fetchWithTimeout(`${MLB_API}/schedule?sportId=1&date=${fmt(todayD)}&gameType=R&hydrate=probablePitcher,team,linescore`).then(r=>r.json()).catch(()=>({dates:[]})),
      fetchWithTimeout(`${MLB_API}/schedule?sportId=1&date=${fmt(tomorrowD)}&gameType=R&hydrate=probablePitcher,team,linescore`).then(r=>r.json()).catch(()=>({dates:[]})),
    ]);

    const yesterdayGames = (yData.dates?.[0]?.games || []);
    const todayGames     = (todayData.dates?.[0]?.games || []).slice().sort((a,b) => new Date(a.gameDate) - new Date(b.gameDate));
    const tomorrowGames  = (tmrData.dates?.[0]?.games  || []).slice().sort((a,b) => new Date(a.gameDate) - new Date(b.gameDate));
    const yesterdayBoxscores = await Promise.all(
      yesterdayGames.map(g =>
        fetchWithTimeout(`${MLB_API}/game/${g.gamePk}/boxscore`)
          .then(r => r.json())
          .catch(() => null)
      )
    );
    const yesterdayPlayerIds = new Set();
    yesterdayBoxscores.forEach(box => {
      ['away', 'home'].forEach(side => {
        Object.values(box?.teams?.[side]?.players || {}).forEach(player => {
          if (player?.person?.id) yesterdayPlayerIds.add(player.person.id);
        });
      });
    });

    // Fetch pitcher stats for probable pitchers (today + tomorrow only)
    const pitcherIds = new Set();
    [...todayGames, ...tomorrowGames].forEach(g => {
      const ap = g.teams.away.probablePitcher?.id;
      const hp = g.teams.home.probablePitcher?.id;
      if (ap) pitcherIds.add(ap);
      if (hp) pitcherIds.add(hp);
    });
    const pitcherForma = {};
    const pitcherStats = {};
    if (pitcherIds.size) {
      const ids = [...pitcherIds];
      for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i+20).join(',');
        await fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=season,group=pitching,season=${CURRENT_YEAR})`)
          .then(r=>r.json()).then(d=>{
            (d.people||[]).forEach(p => {
              const s = p.stats?.find(g=>g.group?.displayName==='pitching')?.splits?.[0]?.stat;
              if (s) { pitcherStats[p.id]=s; pitcherForma[p.id]=calcPitcherScore(s)??0; }
            });
          }).catch(()=>{});
      }
      await fetchRecentPitching(ids);
      ids.forEach(pid => {
        if (pitcherStats[pid]) pitcherForma[pid] = calcPitcherScoreWithRecent(pitcherStats[pid], pid) ?? pitcherForma[pid] ?? 0;
      });
    }

    // ── Get or compute MVP/CY/ROY candidate sets ──────────────────────────
    // Reuse from global if MVP tab already loaded, otherwise fetch independently.
    // We build a flat Set of {pid, teamId, labels[]} for fast lookup by teamId.
    let candidatesByTeam = {}; // teamId → [{pid, name, labels:[{key, rank}], rank, position}]

    async function buildCandidateSets() {
      const MVP_LIMIT = 30;
      const CY_LIMIT = 10;
      const ROY_LIMIT = 5;
      let lists = window._mvpLists;
      if (!lists) {
        // MVP tab not visited yet — fetch minimal data independently
        try {
          await fetchLeagueTeamStats();
          const lgMap = leagueTeamStatsCache || {};
          const lgAvg = lgMap._leagueAvg || {};
          const lgPitch = lgMap._leaguePitch || {};
          const [hitData, pitchData] = await Promise.all([
            fetchWithTimeout(`${MLB_API}/stats?stats=season&season=${CURRENT_YEAR}&group=hitting&gameType=R&sportId=1&limit=800`)
              .then(r=>r.json()).catch(()=>({stats:[]})),
            fetchWithTimeout(`${MLB_API}/stats?stats=season&season=${CURRENT_YEAR}&group=pitching&gameType=R&sportId=1&limit=800`)
              .then(r=>r.json()).catch(()=>({stats:[]})),
          ]);
          const cachedMvp = (() => {
            try {
              const raw = localStorage.getItem(`mvp_cache_${CURRENT_YEAR}_v2`);
              if (!raw) return null;
              const parsed = JSON.parse(raw);
              if (!parsed?.expiry || Date.now() > parsed.expiry) return null;
              return parsed.data || null;
            } catch(e) { return null; }
          })();
          const positionMap = cachedMvp?.positionMap || {};
          const careerMap = cachedMvp?.careerStatsCache ? { ...cachedMvp.careerStatsCache } : {};
          const rawH = (hitData.stats?.[0]?.splits||[]).map(sp=>({ pid:sp.player?.id, name:sp.player?.fullName||'?', teamId:sp.team?.id, leagueId:sp.team?.id?getTeamLeagueId(sp.team.id):null, position: positionMap[sp.player?.id] || '', s:sp.stat })).filter(p=>p.pid);
          const rawP = (pitchData.stats?.[0]?.splits||[]).map(sp=>({ pid:sp.player?.id, name:sp.player?.fullName||'?', teamId:sp.team?.id, leagueId:sp.team?.id?getTeamLeagueId(sp.team.id):null, s:sp.stat })).filter(p=>p.pid);
          const maxPA = Math.max(1,...rawH.map(p=>parseInt(p.s?.plateAppearances||0)));
          const maxIP = Math.max(1,...rawP.map(p=>parseFloat(p.s?.inningsPitched||0)));
          const minPA = Math.max(50, Math.round(maxPA*0.40));
          const minIP = Math.max(15, Math.round(maxIP*0.40));
          let totRBI=0,totRuns=0,totSB=0,totCS=0,totPA=0;
          rawH.forEach(p=>{const pa=parseInt(p.s?.plateAppearances||0);if(pa<30)return;totRBI+=parseInt(p.s?.rbi||0);totRuns+=parseInt(p.s?.runs||0);totSB+=parseInt(p.s?.stolenBases||0);totCS+=parseInt(p.s?.caughtStealing||0);totPA+=pa;});
          const lg = { ops:(lgAvg.obp||.315)+(lgAvg.slg||.405), obp:lgAvg.obp||.315, slg:lgAvg.slg||.405, hrPA:lgAvg.hrPA||.032, rbiPA:totPA>0?totRBI/totPA:.055, runsPA:totPA>0?totRuns/totPA:.055, sbEff:(totSB+totCS)>0?totSB/(totSB+totCS):.72, paShare:maxPA*.75, era:lgPitch.era||4.10, whip:lgPitch.whip||1.28, k9:lgPitch.k9||8.5, bb9:lgPitch.bb9||3.2 };
          // Simplified score functions (same as MVP tab)
          const mvpScoreSimple = p => {
            const s=p.s; const pa=parseInt(s?.plateAppearances||0); if(pa<minPA) return null;
            const idx=(v,r)=>r?Math.min(200,Math.max(0,(v/r)*100)):100;
            const hits=parseInt(s?.hits||0), ab=parseInt(s?.atBats||1);
            const h1=hits-(parseInt(s?.doubles||0)+parseInt(s?.triples||0)+parseInt(s?.homeRuns||0));
            const tb=h1+2*parseInt(s?.doubles||0)+3*parseInt(s?.triples||0)+4*parseInt(s?.homeRuns||0);
            const obp=ab>0?parseFloat(s?.obp||0):0, slg=ab>0?(tb/ab):0, ops=obp+slg;
            const hr=parseInt(s?.homeRuns||0), rbi=parseInt(s?.rbi||0), runs=parseInt(s?.runs||0);
            const sb=parseInt(s?.stolenBases||0), cs=parseInt(s?.caughtStealing||0);
            const sbEff=(sb+cs)>0?sb/(sb+cs):0;
            const raw=0.30*idx(ops,lg.ops)+0.15*idx(obp,lg.obp)+0.10*idx(slg,lg.slg)
              +0.15*idx(hr/Math.max(pa,1),lg.hrPA)+0.10*idx(rbi/Math.max(pa,1),lg.rbiPA)
              +0.05*idx(runs/Math.max(pa,1),lg.runsPA)+0.05*((sb+cs)>=3?idx(sbEff,lg.sbEff):100)
              +0.10*idx(pa,lg.paShare);
            return Math.min(99.9, raw*0.58);
          };
          const cyScoreSimple = p => {
            const s=p.s; const gs=parseInt(s?.gamesStarted||0); const ip=parseFloat(s?.inningsPitched||0);
            if(gs<1||ip<minIP) return null;
            const era=parseFloat(s?.era||99),whip=parseFloat(s?.whip||99);
            const idxInv=(v,r)=>r&&v?Math.min(200,Math.max(0,(r/v)*100)):100;
            const idx=(v,r)=>r?Math.min(200,Math.max(0,(v/r)*100)):100;
            const k=parseInt(s?.strikeOuts||0),k9=ip>0?(k/ip)*9:0;
            return Math.min(99.9,(0.40*idxInv(era,lg.era)+0.25*idxInv(whip,lg.whip)+0.20*idx(k9,lg.k9)+0.15*idx(ip,maxIP))*0.56);
          };
          const ensureCareerMap = async () => {
            const missingIds = [...new Set([...rawH, ...rawP].map(p => p.pid).filter(pid => !(pid in careerMap)))];
            if (!missingIds.length) return;
            await fetchCareerStats(missingIds);
            missingIds.forEach(pid => { careerMap[pid] = { ...(careerStatsCache[pid] || {}) }; });
          };
          const buildROYSimple = (leagueId) => {
            const royHitters = rawH
              .filter(p => p.leagueId === leagueId)
              .filter(p => !NON_ROOKIE_OVERRIDES.has(p.pid))
              .filter(p => parseInt(p.s?.plateAppearances || 0) >= 20)
              .filter(p => (careerMap[p.pid]?.careerAB ?? 0) < ROOKIE_AB_LIMIT)
              .map(p => ({ ...p, sc: mvpScoreSimple(p), isPitcher: false }))
              .filter(p => p.sc !== null);
            const royPitchers = rawP
              .filter(p => p.leagueId === leagueId)
              .filter(p => !NON_ROOKIE_OVERRIDES.has(p.pid))
              .filter(p => parseFloat(p.s?.inningsPitched || 0) >= 5)
              .filter(p => {
                const c = careerMap[p.pid];
                if (!c) return true;
                if (c.debutYear && c.debutYear < CURRENT_YEAR - 1) return false;
                return (c.careerIP ?? 0) < ROOKIE_IP_LIMIT;
              })
              .map(p => ({ ...p, sc: cyScoreSimple(p), isPitcher: true, position: 'P' }))
              .filter(p => p.sc !== null);
            const merged = [...royHitters, ...royPitchers].sort((a,b) => b.sc - a.sc).slice(0, ROY_LIMIT);
            return merged;
          };
          const buildList=(arr,scoreFn,leagueId,limit)=>arr.filter(p=>(!leagueId||p.leagueId===leagueId)).map(p=>({...p,sc:scoreFn(p)})).filter(p=>p.sc!==null).sort((a,b)=>b.sc-a.sc).slice(0,limit);
          await ensureCareerMap();
          lists = {
            alMVP: buildList(rawH,mvpScoreSimple,103,MVP_LIMIT),
            nlMVP: buildList(rawH,mvpScoreSimple,104,MVP_LIMIT),
            alCY:  buildList(rawP,cyScoreSimple,103,CY_LIMIT),
            nlCY:  buildList(rawP,cyScoreSimple,104,CY_LIMIT),
            alROY: buildROYSimple(103),
            nlROY: buildROYSimple(104),
          };
          window._tgNeedsRefresh = true; // simplified formula used; refresh when _mvpLists loads
        } catch(e) { lists = { alMVP:[], nlMVP:[], alCY:[], nlCY:[], alROY:[], nlROY:[] }; }
      }

      // Flatten into candidatesByTeam: teamId → [{pid, name, labels:[{key, rank}], rank}]
      const addList = (arr, label, limit) => {
        arr.slice(0, limit).forEach((p, i) => {
          if (!p.teamId) return;
          if (!candidatesByTeam[p.teamId]) candidatesByTeam[p.teamId] = [];
          const existing = candidatesByTeam[p.teamId].find(c => c.pid === p.pid);
          if (existing) {
            if (!existing.labels.some(l => l.key === label)) existing.labels.push({ key: label, rank: i + 1 });
            existing.rank = Math.min(existing.rank, i + 1);
            if (!existing.position && (p.position || label === 'CY')) existing.position = p.position || 'P';
          } else {
            candidatesByTeam[p.teamId].push({
              pid: p.pid,
              name: p.name,
              labels: [{ key: label, rank: i + 1 }],
              rank: i + 1,
              position: p.position || (label === 'CY' ? 'P' : '')
            });
          }
        });
      };
      addList(lists.alMVP, 'MVP', MVP_LIMIT); addList(lists.nlMVP, 'MVP', MVP_LIMIT);
      addList(lists.alCY,  'CY',  CY_LIMIT);  addList(lists.nlCY,  'CY',  CY_LIMIT);
      addList(lists.alROY||[], 'ROY', ROY_LIMIT); addList(lists.nlROY||[], 'ROY', ROY_LIMIT);
    }

    // Fetch rosters (hitters + key relievers/closers) for all teams playing today+tomorrow
    // to build "Players to Watch" per game. Cache by teamId.
    const tgRosterCache = {}; // teamId → {hitterPids: Set, pitcherPids: Set, ilPids: Set}
    async function fetchTGRoster(teamId) {
      if (tgRosterCache[teamId]) return tgRosterCache[teamId];
      try {
        const [activeData, ilData] = await Promise.all([
          fetchWithTimeout(`${MLB_API}/teams/${teamId}/roster?rosterType=active&season=${CURRENT_YEAR}`)
            .then(r=>r.json()).catch(()=>({roster:[]})),
          fetchWithTimeout(`${MLB_API}/teams/${teamId}/roster?rosterType=40Man&season=${CURRENT_YEAR}`)
            .then(r=>r.json()).catch(()=>({roster:[]})),
        ]);
        const activeIds = new Set((activeData.roster||[]).map(p=>p.person?.id));
        const IL_STATUSES = new Set(['7-Day Injured List','10-Day Injured List','15-Day Injured List','60-Day Injured List']);
        const ilPids = new Set((ilData.roster||[])
          .filter(p => !activeIds.has(p.person?.id) && IL_STATUSES.has(p.status?.description||''))
          .map(p => p.person?.id).filter(Boolean));
        const hitterPids = new Set();
        const pitcherPids = new Set();
        (activeData.roster||[]).forEach(p => {
          const pos = p.position?.abbreviation;
          const pid = p.person?.id;
          if (!pid) return;
          if (pos === 'P' || pos === 'TWP') pitcherPids.add(pid);
          else hitterPids.add(pid);
        });
        // Track which pitchers are starters vs relievers
        // We use pitcherApps from the main roster fetch — here we use a simple heuristic:
        // fetch season stats to classify SPs (GS > 0 and GS/GP > 0.4)
        const spPids = new Set();
        // We'll populate spPids after stat fetch — store all pitcher pids for now
        tgRosterCache[teamId] = { hitterPids, pitcherPids, ilPids, spPids };
        return tgRosterCache[teamId];
      } catch(e) { return { hitterPids: new Set(), pitcherPids: new Set(), ilPids: new Set() }; }
    }

    // Build "Players to Watch" for a team in a game
    // Excludes: IL players, starting pitchers (they won't appear twice)
    function playersToWatch(teamId, excludeIlPids, excludeSpPids) {
      const candidates = candidatesByTeam[teamId] || [];
      return candidates
        .filter(c => !excludeIlPids.has(c.pid))
        .filter(c => !(excludeSpPids && excludeSpPids.has(c.pid)))
        .slice(0, 3);
    }

    function candidateEntry(pid, teamId) {
      return (candidatesByTeam[teamId] || []).find(c => c.pid === pid) || null;
    }

    // Run candidate build + roster fetches in parallel (non-blocking to main render)
    const allGameTeamIds = new Set();
    [...todayGames, ...tomorrowGames].forEach(g => {
      allGameTeamIds.add(g.teams.away.team.id);
      allGameTeamIds.add(g.teams.home.team.id);
    });
    await Promise.all([
      buildCandidateSets(),
      ...[...allGameTeamIds].map(id => fetchTGRoster(id)),
    ]);

    // Fetch season stats for all PTW candidates (hitters + pitchers) — batched
    const ptwPids = new Set();
    [...allGameTeamIds].forEach(tid => {
      (candidatesByTeam[tid] || []).forEach(c => ptwPids.add(c.pid));
    });
    [...yesterdayPlayerIds].forEach(pid => ptwPids.add(pid));
    // Also fetch stats for probable pitchers if not already in pitcherStats
    [...todayGames, ...tomorrowGames].forEach(g => {
      [g.teams.away.probablePitcher?.id, g.teams.home.probablePitcher?.id].forEach(id => { if(id) ptwPids.add(id); });
    });
    const ptwHitStats  = {};  // pid → hitting stat
    const ptwPitchStats = {}; // pid → pitching stat (supplement pitcherStats)
    const ptwCareer    = {};  // pid → { ops, formaScore }
    const missingPtwPids = [...ptwPids];
    if (missingPtwPids.length) {
      for (let i = 0; i < missingPtwPids.length; i += 20) {
        const chunk = missingPtwPids.slice(i, i+20).join(',');
        await Promise.all([
          fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=season,group=hitting,season=${CURRENT_YEAR})`)
            .then(r=>r.json()).then(d=>{
              (d.people||[]).forEach(p=>{ const s=p.stats?.find(g=>g.group?.displayName==='hitting')?.splits?.[0]?.stat; if(s) ptwHitStats[p.id]=s; });
            }).catch(()=>{}),
          fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=season,group=pitching,season=${CURRENT_YEAR})`)
            .then(r=>r.json()).then(d=>{
              (d.people||[]).forEach(p=>{ const s=p.stats?.find(g=>g.group?.displayName==='pitching')?.splits?.[0]?.stat; if(s){ ptwPitchStats[p.id]=s; if(!pitcherStats[p.id]) pitcherStats[p.id]=s; if(!(p.id in pitcherForma)) pitcherForma[p.id]=calcPitcherScore(s)??0; } });
            }).catch(()=>{}),
          fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=yearByYear,group=hitting)`)
            .then(r=>r.json()).then(d=>{
              (d.people||[]).forEach(p=>{
                ptwCareer[p.id]=ptwCareer[p.id]||{};
                if (p.mlbDebutDate) ptwCareer[p.id].debutYear = parseInt(p.mlbDebutDate.slice(0,4));
                Object.assign(ptwCareer[p.id], summarizePriorHitting(p));
              });
            }).catch(()=>{}),
          fetchWithTimeout(`${MLB_API}/people?personIds=${chunk}&hydrate=stats(type=yearByYear,group=pitching)`)
            .then(r=>r.json()).then(d=>{
              (d.people||[]).forEach(p=>{
                ptwCareer[p.id]=ptwCareer[p.id]||{};
                if (p.mlbDebutDate) ptwCareer[p.id].debutYear = parseInt(p.mlbDebutDate.slice(0,4));
                Object.assign(ptwCareer[p.id], summarizePriorPitching(p));
              });
            }).catch(()=>{})
        ]);
      }
      await fetchCareerStats(missingPtwPids);
      missingPtwPids.forEach(pid => { ptwCareer[pid] = { ...(ptwCareer[pid] || {}), ...(careerStatsCache[pid] || {}) }; });
      const ptwPitcherIds = Object.keys(ptwPitchStats).map(Number);
      await fetchRecentPitching(ptwPitcherIds);
      ptwPitcherIds.forEach(pid => {
        const s = ptwPitchStats[pid] || pitcherStats[pid];
        if (s) pitcherForma[pid] = calcPitcherScoreWithRecent(s, pid) ?? pitcherForma[pid] ?? 0;
      });
    }

    // Classify SPs in each team's roster cache using fetched pitch stats
    [...allGameTeamIds].forEach(tid => {
      const rc = tgRosterCache[tid];
      if (!rc) return;
      rc.pitcherPids.forEach(pid => {
        const ps = ptwPitchStats[pid] || pitcherStats[pid];
        if (!ps) return;
        const gs = parseInt(ps.gamesStarted||0);
        const gp = parseInt(ps.gamesPitched||0);
        if (gs >= 1 && gp > 0 && (gs/gp) >= 0.4) rc.spPids.add(pid);
      });
    });

    function isTopGamesRookie(pid, type) {
      return isRookieCareerEligible(pid, ptwCareer[pid], type === 'pitcher' ? 'pitcher' : 'hitter');
    }

    // Score a game — now includes MVP/CY candidate bonus
    function scoreGame(g) {
      const away = g.teams.away, home = g.teams.home;
      const awayPct = (away.leagueRecord?.wins||0) / Math.max((away.leagueRecord?.wins||0)+(away.leagueRecord?.losses||0),1);
      const homePct = (home.leagueRecord?.wins||0) / Math.max((home.leagueRecord?.wins||0)+(home.leagueRecord?.losses||0),1);
      const recordScore = ((awayPct+homePct)/2)*100;
      const balance = 100 - Math.abs(awayPct-homePct)*100;
      const awayF = pitcherForma[g.teams.away.probablePitcher?.id] ?? 50;
      const homeF = pitcherForma[g.teams.home.probablePitcher?.id] ?? 50;
      const pitcherScore = Math.min(awayF,homeF)*0.6 + ((awayF+homeF)/2)*0.4;
      const divBonus = (away.team?.division?.id && away.team?.division?.id===home.team?.division?.id) ? 10 : 0;
      // Award candidate bonus: each candidate in game adds points, weighted by rank
      const awardBonus = (() => {
        const awayC = candidatesByTeam[away.team.id] || [];
        const homeC = candidatesByTeam[home.team.id] || [];
        const allC = [...awayC, ...homeC];
        if (!allC.length) return 0;
        // Top-ranked candidates score more: rank 1 = 10pts, rank 20 = 1pt
        const pts = allC.reduce((sum, c) => sum + Math.max(1, 11 - Math.floor(c.rank / 2)), 0);
        return Math.min(pts, 25); // cap at 25 bonus points
      })();
      // Weights: 35% pitchers · 25% record · 15% balance · 10% rivalry · 15% award candidates
      return pitcherScore*0.35 + recordScore*0.25 + balance*0.15 + divBonus*0.10 + awardBonus*0.15;
    }

    // Assign color tier based on score percentile within the day
    function scoreTiers(games) {
      const scored = games.map(g => scoreGame(g));
      const sorted = [...scored].sort((a,b)=>b-a);
      const n = sorted.length;
      return scored.map(s => {
        if (n === 0) return 'grey';
        const rank = sorted.indexOf(s); // 0 = best
        const pct = rank / Math.max(n-1, 1);
        if (pct <= 0.15) return 'green';
        if (pct <= 0.40) return 'blue';
        return 'grey';
      });
    }
    const DOT_COLOR = { green: 'var(--win)', blue: 'var(--accent)', grey: 'var(--border)' };

    function parseIpToOuts(ip) {
      if (!ip && ip !== 0) return 0;
      const [whole, frac = '0'] = String(ip).split('.');
      return (parseInt(whole, 10) || 0) * 3 + (parseInt(frac, 10) || 0);
    }

    function intStat(v) {
      return parseInt(v, 10) || 0;
    }

    function ratioIdx(val, ref) {
      if (!ref || ref <= 0) return 0;
      return Math.min(200, Math.max(0, (val / ref) * 100));
    }

    function ratioIdxInv(val, ref) {
      if (!val || val <= 0) return 200;
      if (!ref || ref <= 0) return 0;
      return Math.min(200, Math.max(0, (ref / val) * 100));
    }

    function hitterGameScore(s) {
      const ab = intStat(s.atBats);
      const h = intStat(s.hits);
      const doubles = intStat(s.doubles);
      const triples = intStat(s.triples);
      const hr = intStat(s.homeRuns);
      const bb = intStat(s.baseOnBalls);
      const hbp = intStat(s.hitByPitch);
      const sf = intStat(s.sacFlies);
      const rbi = intStat(s.rbi);
      const runs = intStat(s.runs);
      const sb = intStat(s.stolenBases);
      const cs = intStat(s.caughtStealing);
      const so = intStat(s.strikeOuts);
      const singles = Math.max(0, h - doubles - triples - hr);
      const tb = singles + doubles * 2 + triples * 3 + hr * 4;
      const pa = ab + bb + hbp + sf;
      const timesOnBase = h + bb + hbp;
      const obp = pa > 0 ? timesOnBase / pa : 0;
      const slg = ab > 0 ? tb / ab : 0;
      const ops = obp + slg;
      const production = rbi + runs;
      const speed = sb + (cs === 0 && sb > 0 ? 0.5 : 0);

      const raw =
        0.35 * ratioIdx(ops, 1.400) +
        0.25 * ratioIdx(tb, 4) +
        0.20 * ratioIdx(production, 4) +
        0.10 * ratioIdx(timesOnBase, 3) +
        0.10 * ratioIdx(speed, 2) -
        Math.min(12, so * 2);

      return Math.max(0, Math.min(99.9, raw * 0.52));
    }

    function pitcherGameScore(s) {
      const outs = parseIpToOuts(s.inningsPitched);
      const ip = outs / 3;
      const gs = intStat(s.gamesStarted);
      const er = intStat(s.earnedRuns);
      const hits = intStat(s.hits);
      const bb = intStat(s.baseOnBalls);
      const so = intStat(s.strikeOuts);
      const qs = gs > 0 && outs >= 18 && er <= 3 ? 1 : 0;
      if (ip <= 0) return 0;
      const gameEra = (er * 9) / ip;
      const gameWhip = (hits + bb) / ip;
      const k9 = (so * 9) / ip;
      const strikeoutImpact = 0.65 * ratioIdx(so, 6) + 0.35 * ratioIdx(k9, 10.5);
      const workloadFactor = Math.min(1, 0.40 + 0.60 * (ip / 5));

      const raw =
        0.34 * ratioIdxInv(Math.max(gameEra, 0.1), 4.00) +
        0.24 * ratioIdxInv(Math.max(gameWhip, 0.1), 1.20) +
        0.14 * strikeoutImpact +
        0.28 * ratioIdx(ip, 6.0) +
        (qs ? 8 : 0);

      return Math.max(0, Math.min(99.9, raw * 0.50 * workloadFactor));
    }

    function hitterTopStats(s) {
      const stats = [];
      const hr = intStat(s.homeRuns);
      const rbi = intStat(s.rbi);
      const hits = intStat(s.hits);
      const sb = intStat(s.stolenBases);
      const bb = intStat(s.baseOnBalls);
      const runs = intStat(s.runs);
      const doubles = intStat(s.doubles);
      const triples = intStat(s.triples);

      if (hr > 0) stats.push(`${hr} HR`);
      if (rbi > 0) stats.push(`${rbi} RBI`);
      if (hits > 0) stats.push(`${hits} H`);
      if (doubles > 0) stats.push(`${doubles} 2B`);
      if (triples > 0) stats.push(`${triples} 3B`);
      if (sb > 0) stats.push(`${sb} SB`);
      if (bb > 0) stats.push(`${bb} BB`);
      if (runs > 0) stats.push(`${runs} R`);

      const unique = [];
      stats.forEach(stat => {
        if (!unique.includes(stat)) unique.push(stat);
      });

      return unique.slice(0, 3);
    }

    function pitcherTopStats(s) {
      const stats = [];
      if (s.inningsPitched) stats.push(`${s.inningsPitched} IP`);
      stats.push(`${intStat(s.earnedRuns)} ER`);
      if (intStat(s.strikeOuts) > 0) stats.push(`${intStat(s.strikeOuts)} K`);
      else if (intStat(s.baseOnBalls) === 0) stats.push('0 BB');
      return stats.slice(0, 3);
    }

    function yesterdayStarColor(p) {
      if (p.type === 'pitcher') {
        if (p.score >= 70) return 'var(--win)';
        if (p.score >= 54) return 'var(--accent-blue)';
        return 'var(--muted)';
      }
      if (p.score >= 62) return 'var(--accent-blue)';
      if (p.score >= 48) return '#2563eb';
      return 'var(--muted)';
    }

    function selectYesterdayStarsFromBox(box) {
      const hitters = [];
      const pitchers = [];
      if (!box?.teams) return [];

      ['away', 'home'].forEach(side => {
        const teamBox = box.teams?.[side];
        const teamId = teamBox?.team?.id;
        if (!teamId) return;
        const teamMeta = TEAM_META[teamId] || {
          abbr: teamBox.team?.abbreviation || '?',
          logo: `https://www.mlbstatic.com/team-logos/${teamId}.svg`
        };

        Object.values(teamBox.players || {}).forEach(player => {
          const pid = player.person?.id;
          const name = player.person?.fullName || '?';
          if (!pid) return;
          const gamePos = (player.allPositions && player.allPositions[0]?.abbreviation) || player.position?.abbreviation || '';

          const bat = player.stats?.batting || {};
          const pit = player.stats?.pitching || {};
          const pa =
            intStat(bat.atBats) +
            intStat(bat.baseOnBalls) +
            intStat(bat.hitByPitch) +
            intStat(bat.sacFlies) +
            intStat(bat.sacBunts);
          const hasBattingLine = pa > 0 || intStat(bat.hits) > 0 || intStat(bat.rbi) > 0 || intStat(bat.runs) > 0;
          const outs = parseIpToOuts(pit.inningsPitched);
          const hasPitchingLine = outs > 0 || intStat(pit.battersFaced) > 0 || intStat(pit.strikeOuts) > 0;

          if (hasBattingLine) {
            const seasonHit = ptwHitStats[pid] || {};
            const career = ptwCareer[pid];
            const seasonOps = parseFloat(seasonHit.ops) || 0;
            const isRookie = !career || isTopGamesRookie(pid, 'hitter');
            hitters.push({
              pid,
              name,
              teamId,
              teamMeta,
              type: 'hitter',
              displayRole: gamePos && gamePos !== 'P' && gamePos !== 'TWP' ? gamePos : '',
              score: hitterGameScore(bat),
              stats: bat,
              topStats: hitterTopStats(bat),
              isRookie,
              photoUrl: siloHeadshot(pid)
            });
          }

          if (hasPitchingLine) {
            const seasonPitch = ptwPitchStats[pid] || pitcherStats[pid] || {};
            const career = ptwCareer[pid];
            const isRookie = !career || isTopGamesRookie(pid, 'pitcher');
            pitchers.push({
              pid,
              name,
              teamId,
              teamMeta,
              type: 'pitcher',
              displayRole: 'PITCHER',
              score: pitcherGameScore(pit),
              stats: pit,
              topStats: pitcherTopStats(pit),
              isRookie,
              photoUrl: siloHeadshot(pid)
            });
          }
        });
      });

      hitters.sort((a, b) => b.score - a.score);
      pitchers.sort((a, b) => b.score - a.score);

      const MIN_HITTER_SCORE = 28;
      const nextDistinct = (arr, used) => arr.find(p => !used.has(p.pid)) || null;
      const used = new Set();
      const bestH = nextDistinct(hitters, used);
      const bestP = nextDistinct(pitchers, used);

      const MIN_PITCHER_SCORE = 32;
      const ELITE_PITCHER_SCORE = 72;
      const STRONG_SECOND_PITCHER = 64;

      let selected = [];

      if (!bestP || (bestP.score < MIN_PITCHER_SCORE && bestH)) {
        if (bestH && bestH.score >= MIN_HITTER_SCORE) { selected.push(bestH); used.add(bestH.pid); }
        const secondH = nextDistinct(hitters, used);
        if (secondH && secondH.score >= MIN_HITTER_SCORE) { selected.push(secondH); used.add(secondH.pid); }
        if (selected.length < 2 && bestP && bestP.score >= MIN_PITCHER_SCORE && !used.has(bestP.pid)) selected.push(bestP);
      } else {
        const secondP = nextDistinct(pitchers, new Set(bestP ? [bestP.pid] : []));
        if (bestP && secondP && bestP.score >= ELITE_PITCHER_SCORE && secondP.score >= STRONG_SECOND_PITCHER) {
          selected = [bestP, secondP];
        } else {
          if (bestH && bestH.score >= MIN_HITTER_SCORE) { selected.push(bestH); used.add(bestH.pid); }
          if (bestP && bestP.score >= MIN_PITCHER_SCORE && !used.has(bestP.pid)) { selected.push(bestP); used.add(bestP.pid); }
          if (selected.length < 2) {
            const fallback = nextDistinct(bestH ? pitchers : hitters, used);
            if (fallback) {
              const meetsFloor = fallback.type === 'pitcher'
                ? fallback.score >= MIN_PITCHER_SCORE
                : fallback.score >= MIN_HITTER_SCORE;
              if (meetsFloor) selected.push(fallback);
            }
          }
        }
      }

      return selected
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
    }

    function yesterdayStarRowHTML(p) {
      const teamPill = `<span style="display:inline-flex;align-items:center;gap:3px;flex-shrink:0">
        <img src="${p.teamMeta.logo}" style="width:14px;height:14px;object-fit:contain" onerror="this.style.display='none'">
        <span style="font-family:'Barlow Condensed';font-weight:700;font-size:11px;color:var(--muted)">${p.teamMeta.abbr}</span>
      </span>`;
      const rookieBadge = p.isRookie ? `<span class="rookie-badge">R</span>` : '';
      const roleBadge = p.displayRole ? `<span class="sec-pos-badge">${p.displayRole}</span>` : '';
      const statsLine = p.topStats.join(' · ') || (p.type === 'pitcher' ? '0 ER' : '1 H');
      return `<div class="impact-row">
        <div class="impact-row-left">
          <img class="impact-photo" src="${p.photoUrl}" style="background:${teamPhotoBg(p.teamMeta)}"
            onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
          <div class="impact-name-block">
            <div class="impact-name">${p.name} ${roleBadge} ${rookieBadge} ${teamPill}</div>
            <div class="impact-stats-line">${statsLine}</div>
          </div>
        </div>
      </div>`;
    }

    function yesterdayKeyPlayersHTML(box) {
      const selected = selectYesterdayStarsFromBox(box);
      if (!selected.length) return '';
      return `<div class="impact-detail-card" style="background:#fff;border-color:#dfe6f2;box-shadow:0 1px 4px rgba(15,25,35,.04)">
        <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--accent);text-transform:uppercase;margin-bottom:6px">Key Performances</div>
        ${selected.map(p => yesterdayStarRowHTML(p)).join('')}
      </div>`;
    }

    function detectSpecialGame(g, box) {
      if (g.status?.abstractGameState !== 'Final') return null;
      const ls = g.linescore;
      if (!ls) return null;
      const awayHits = ls.teams?.away?.hits ?? null;
      const homeHits = ls.teams?.home?.hits ?? null;
      if (awayHits === null || homeHits === null) return null;
      let noHitSide = null;
      if (awayHits === 0) noHitSide = 'away';
      else if (homeHits === 0) noHitSide = 'home';
      if (!noHitSide) return null;
      const pitchingSide = noHitSide === 'away' ? 'home' : 'away';
      const isCombined = (box?.teams?.[pitchingSide]?.pitchers?.length ?? 1) > 1;
      const bat = box?.teams?.[noHitSide]?.teamStats?.batting || {};
      const walks = bat.baseOnBalls ?? 1;
      const hbp = bat.hitByPitch ?? 0;
      const errors = ls.teams?.[noHitSide]?.errors ?? 1;
      const isPerfect = walks === 0 && hbp === 0 && errors === 0;
      if (isPerfect && isCombined) return 'COMBINED PERFECT GAME';
      if (isPerfect) return 'PERFECT GAME';
      if (isCombined) return 'COMBINED NO-HITTER';
      return 'NO-HITTER';
    }

    function yesterdayRowHTML(g, idx) {
      const away = g.teams.away, home = g.teams.home;
      const awayMeta = TEAM_META[away.team.id] || { abbr: away.team.abbreviation||'?', logo:`https://www.mlbstatic.com/team-logos/${away.team.id}.svg` };
      const homeMeta = TEAM_META[home.team.id] || { abbr: home.team.abbreviation||'?', logo:`https://www.mlbstatic.com/team-logos/${home.team.id}.svg` };
      const awayScore = away.score ?? '—';
      const homeScore = home.score ?? '—';
      const awayWon = typeof awayScore === 'number' && typeof homeScore === 'number' && awayScore > homeScore;
      const homeWon = typeof homeScore === 'number' && typeof awayScore === 'number' && homeScore > awayScore;
      const boldA = awayWon ? 'font-weight:800;color:var(--text)' : 'color:var(--muted)';
      const boldH = homeWon ? 'font-weight:800;color:var(--text)' : 'color:var(--muted)';
      const gameId = `ayer-${idx}`;
      const venueName = g.venue?.name || '';
      const detailHTML = yesterdayKeyPlayersHTML(yesterdayBoxscores[idx]);
      const specialGame = detectSpecialGame(g, yesterdayBoxscores[idx]);
      const specialBadge = specialGame ? `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:3px;background:rgba(168,85,247,.15);color:#a855f7;border:1px solid rgba(168,85,247,.3);letter-spacing:.5px">${specialGame}</span>` : '';
      return `<div>
        <div class="tg-game-row" id="tgr-${gameId}" data-gamepk="${g.gamePk}" onclick="tgToggleGame('${gameId}')">
          <div class="tg-teams">
            <img class="tg-team-logo" src="${awayMeta.logo}" onerror="this.style.display='none'" alt="">
            <span class="tg-abbr" style="${boldA}">${awayMeta.abbr}</span>
            <span class="tg-score" style="${boldA}">${awayScore}</span>
            <span class="tg-sep">-</span>
            <span class="tg-score" style="${boldH}">${homeScore}</span>
            <span class="tg-abbr" style="${boldH}">${homeMeta.abbr}</span>
            <img class="tg-team-logo" src="${homeMeta.logo}" onerror="this.style.display='none'" alt="">
          </div>
          <div class="tg-badges">${specialBadge}</div>
          <div style="text-align:right;flex-shrink:0;padding-left:10px">
            <div class="tg-time" style="padding:0;font-size:11px;letter-spacing:.5px;color:var(--muted)">${g.status?.detailedState==='Final'?'FINAL':g.status?.detailedState||''}</div>
            ${venueName ? `<div style="font-family:'Barlow Condensed';font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;margin-top:1px">${venueName}</div>` : ''}
          </div>
        </div>
        <div class="tg-detail" id="tgd-${gameId}">
          ${detailHTML || `<div style="font-family:'Barlow Condensed';font-size:13px;color:var(--muted)">No key players found for this game.</div>`}
        </div>
      </div>`;
    }

    // ── TODAY / TOMORROW: row + expandable detail ─────────────────────────────
    function futureRowHTML(g, gIdx, dayKey, tier) {
      const away = g.teams.away, home = g.teams.home;
      const awayMeta = TEAM_META[away.team.id] || { abbr: away.team.abbreviation||'?', logo:`https://www.mlbstatic.com/team-logos/${away.team.id}.svg` };
      const homeMeta = TEAM_META[home.team.id] || { abbr: home.team.abbreviation||'?', logo:`https://www.mlbstatic.com/team-logos/${home.team.id}.svg` };
      const gdate = new Date(g.gameDate);
      const timeStr = gdate.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
      const dotColor = DOT_COLOR[tier];
      const gameId = `${dayKey}-${gIdx}`;

      // Determine if game is live/final for today
      const state = g.status?.abstractGameState;
      const inningLabel = g.linescore?.currentInningOrdinal || 'LIVE';
      const statusText = state === 'Live' ? `● ${inningLabel}` : state === 'Final' ? 'FINAL' : timeStr;
      const statusStyle = state === 'Live'
        ? "padding:0;font-size:11px;letter-spacing:.5px;color:var(--win);animation:pulse 1.5s infinite"
        : state === 'Final'
          ? "padding:0;font-size:11px;letter-spacing:.5px;color:var(--muted)"
          : "padding:0";

      // Scores if live/final
      const awayScoreStr = (state==='Live'||state==='Final') ? (away.score??'0') : '';
      const homeScoreStr = (state==='Live'||state==='Final') ? (home.score??'0') : '';
      const awayWon = state === 'Final' && typeof away.score === 'number' && typeof home.score === 'number' && away.score > home.score;
      const homeWon = state === 'Final' && typeof home.score === 'number' && typeof away.score === 'number' && home.score > away.score;
      const awayStyle = awayWon ? 'font-weight:800;color:var(--text)' : state === 'Final' ? 'color:var(--muted)' : '';
      const homeStyle = homeWon ? 'font-weight:800;color:var(--text)' : state === 'Final' ? 'color:var(--muted)' : '';
      const scoreHTML = awayScoreStr !== ''
        ? `<span class="tg-score" style="${awayStyle}">${awayScoreStr}</span><span class="tg-sep">-</span><span class="tg-score" style="${homeStyle}">${homeScoreStr}</span>`
        : `<span class="tg-sep" style="padding:0 2px">@</span>`;

      // Tier badges on the row
      let tierBadge = '';
      if (tier === 'green') tierBadge = `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:3px;background:rgba(22,163,74,.15);color:#16a34a;border:1px solid rgba(22,163,74,.3);letter-spacing:.5px">TOP MATCH</span>`;
      else if (tier === 'blue') tierBadge = `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:3px;background:rgba(21,101,216,.15);color:#1565d8;border:1px solid rgba(21,101,216,.3);letter-spacing:.5px">TOP MATCH</span>`;

      // Detail panel
      const awayPid = away.probablePitcher?.id;
      const homePid = home.probablePitcher?.id;
      const awayPName = away.probablePitcher?.fullName || null;
      const homePName = home.probablePitcher?.fullName || null;
      const awayF = awayPid ? (pitcherForma[awayPid]??null) : null;
      const homeF = homePid ? (pitcherForma[homePid]??null) : null;
      const awayS = awayPid ? (pitcherStats[awayPid]||null) : null;
      const homeS = homePid ? (pitcherStats[homePid]||null) : null;
      const sameDivision = away.team?.division?.id && away.team?.division?.id===home.team?.division?.id;
      const venueName = g.venue?.name || '';

      // Label: "STARTING PITCHER" if game is live or final, "PROBABLE SP" otherwise
      const spLabel = (state === 'Live' || state === 'Final') ? 'STARTING PITCHER' : 'PROBABLE SP';

      // Rich pitcher card
      function spMini(pid, name, forma, stat, teamMeta, teamId) {
        const isTBD = !name;
        const awardEntry = pid && teamId ? candidateEntry(pid, teamId) : null;
        const hasRoyLabel = awardEntry?.labels?.some(e => e.key === 'ROY') ?? false;
        const isRookie = pid ? (isTopGamesRookie(pid, 'pitcher') || hasRoyLabel) : false;
        const rookieBadge = isRookie ? `<span class="rookie-badge">R</span>` : '';
        const spAwardBadges = awardEntry?.labels?.length
          ? awardEntry.labels
              .filter(entry => entry.key === 'CY' || entry.key === 'ROY')
              .sort((a, b) => (a.key === 'CY' ? 0 : 1) - (b.key === 'CY' ? 0 : 1) || a.rank - b.rank)
              .map(entry => {
                const label = entry.key === 'CY' ? 'CY RACE' : 'ROY RACE';
                return `<span class="mvp-award-badge" style="cursor:pointer" onclick="event.stopPropagation();goToMVPFromTopGames('${entry.key}')">${label}</span>`;
              })
              .join(' ')
          : '';
        const color = forma !== null ? getDiamondPlayerColor(forma, 'pitcher') : 'var(--muted)';
        let bg = 'var(--surface2)', border = 'var(--border)', labelColor = 'var(--muted)';
        if (!isTBD && forma !== null) {
          bg         = `${color}17`;            // ~9% tint of the form color
          border     = `${color}47`;            // ~28% border of the form color
          labelColor = statTextColor(color);    // readable label matching the form value
        }
        // Team pill
        const teamPill = teamMeta ? `<div style="display:flex;align-items:center;gap:5px;margin-bottom:6px">
          <img src="${teamMeta.logo}" style="width:16px;height:16px;object-fit:contain" onerror="this.style.display='none'">
          <span style="font-family:'Barlow Condensed';font-weight:700;font-size:11px;color:var(--muted)">${teamMeta.abbr}</span>
        </div>` : '';
        if (isTBD) return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:10px 12px;width:100%">
          ${teamPill}
          <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:${labelColor};text-transform:uppercase;margin-bottom:3px">${spLabel}</div>
          <div style="font-family:'Barlow Condensed';font-weight:700;font-size:14px;color:var(--muted)">TBD</div>
        </div>`;
        const photoUrl = siloHeadshot(pid); const photoBg = teamPhotoBg(teamMeta);
        const ps = stat || ptwPitchStats[pid] || {};
        const era = ps.era||'—', whip = ps.whip||'—', ip = ps.inningsPitched||'—', gs = ps.gamesStarted??'—';
        const statsLine1 = `ERA ${era} · WHIP ${whip}`;
        const statsLine2 = `IP ${ip} · GS ${gs}`;
        const barW = forma !== null ? Math.min(100, Math.round((forma/100)*100)) : 0;
        const career = ptwCareer[pid];
        const trendHtml = (!isRookie && career?.formaScore != null && forma != null) ? trendFormaHTML(forma, career.formaScore) : '';
        return `<div style="background:${bg};border:1px solid ${border};border-radius:7px;padding:10px 12px;width:100%">
          ${teamPill}
          <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:${labelColor};text-transform:uppercase;margin-bottom:6px">${spLabel}</div>
          <div style="display:grid;grid-template-columns:1fr 52px;gap:8px;align-items:start">
            <div class="impact-row-left" style="grid-column:1;grid-row:1/3">
              <img class="impact-photo" src="${photoUrl}" style="background:${photoBg}"
                onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
              <div class="impact-name-block">
                <div class="impact-name" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name} ${rookieBadge}</div>
                <div class="impact-stats-line">${statsLine1}</div>
                <div class="impact-stats-line">${statsLine2}</div>
                ${spAwardBadges ? `<div style="margin-top:5px;display:flex;gap:4px;flex-wrap:wrap">${spAwardBadges}</div>` : ''}
              </div>
            </div>
            <div class="impact-bar-val-wrap">
              <span class="impact-bar-label">FORM</span>
              <span class="impact-bar-val" style="color:${statTextColor(color)};font-size:20px">${Math.max(0,forma??0)}</span>
              <div class="impact-bar-block" style="grid-column:auto;grid-row:auto;height:4px;width:100%;margin:3px 0 0 auto"><div class="impact-bar-bg"><div class="impact-bar-fill" style="width:${barW}%;background:${color}"></div></div></div>
              ${trendHtml ? `<div style="margin-top:3px;text-align:right">${trendHtml}</div>` : ''}
            </div>
          </div>
        </div>`;
      }

      // Players to Watch — merged, sorted by score, with team badge
      const awayRoster = tgRosterCache[away.team.id] || { hitterPids: new Set(), pitcherPids: new Set(), ilPids: new Set(), spPids: new Set() };
      const homeRoster = tgRosterCache[home.team.id] || { hitterPids: new Set(), pitcherPids: new Set(), ilPids: new Set(), spPids: new Set() };
      // Exclude starters from Players to Watch; starters already have their own SP cards.
      const gameExcludeAway = new Set([awayPid].filter(Boolean));
      const gameExcludeHome = new Set([homePid].filter(Boolean));
      // Also exclude IL
      const awayExclude = new Set([...awayRoster.ilPids, ...gameExcludeAway]);
      const homeExclude = new Set([...homeRoster.ilPids, ...gameExcludeHome]);
      const awayWatch = playersToWatch(away.team.id, awayExclude, awayRoster.spPids).map(c => ({...c, teamMeta: awayMeta}));
      const homeWatch = playersToWatch(home.team.id, homeExclude, homeRoster.spPids).map(c => ({...c, teamMeta: homeMeta}));

      // Merge and sort by mvp score (rank is 1-20, lower = better, so sort ascending)
      const allWatch = [...awayWatch, ...homeWatch].sort((a, b) => a.rank - b.rank).slice(0, 4);

      function ptwPlayerCard(c, badgeFn) {
        const photoUrl = siloHeadshot(c.pid); const photoBg = teamPhotoBg(c.teamMeta);
        const hs = ptwHitStats[c.pid];
        const ps = ptwPitchStats[c.pid];
        const awardKeys = (c.labels || []).map(l => l.key);
        const isPitcher = awardKeys.includes('CY') || (ps && (!hs || (parseInt(ps.gamesStarted||0)+parseInt(ps.gamesPitched||0)) > parseInt(hs.gamesPlayed||0)));
        const isRookie = isTopGamesRookie(c.pid, isPitcher ? 'pitcher' : 'hitter');
        const rookieBadge = awardKeys.includes('ROY') ? `<span class="rookie-badge">R</span>` : '';
        const pos = c.position || (isPitcher ? 'P' : '');
        // Team pill
        const tm = c.teamMeta;
        const teamPill = tm ? `<span style="display:inline-flex;align-items:center;gap:3px;flex-shrink:0">
          <img src="${tm.logo}" style="width:14px;height:14px;object-fit:contain" onerror="this.style.display='none'">
          <span style="font-family:'Barlow Condensed';font-weight:700;font-size:11px;color:var(--muted)">${tm.abbr}</span>
        </span>` : '';
        // Position badge — same style as TEAMS tab sec-pos-badge
        const posBadge = pos ? `<span class="sec-pos-badge">${pos}</span>` : '';

        // Shared layout: photo | name+pos+team / stats | bar+val+trend
        // Exactly mirrors playerDetailHTML from TEAMS tab
        if (isPitcher && ps) {
          const forma = Math.max(0, calcPitcherScoreWithRecent(ps, c.pid) ?? 0);
          const color = getDiamondPlayerColor(forma, 'pitcher');
          const barW = Math.min(100, Math.round((forma/100)*100));
          const career = ptwCareer[c.pid];
          const trendHtml = !isRookie && career?.formaScore != null ? trendFormaHTML(forma, career.formaScore) : '';
          const statsLine = `ERA ${ps.era||'—'} · WHIP ${ps.whip||'—'} · IP ${ps.inningsPitched||'—'} · GS ${ps.gamesStarted??'—'}`;
          return `<div class="impact-row">
            <div class="impact-row-left">
              <img class="impact-photo" src="${photoUrl}" style="background:${photoBg}"
                onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
              <div class="impact-name-block">
                <div class="impact-name">${c.name} ${posBadge} ${rookieBadge} ${teamPill}</div>
                <div class="impact-stats-line">${statsLine}</div>
                ${badgeFn ? badgeFn(c) : ''}
              </div>
            </div>
            <div class="impact-bar-block">
              <div class="impact-bar-bg"><div class="impact-bar-fill" style="width:${barW}%;background:${color}"></div></div>
            </div>
            <div class="impact-bar-val-wrap">
              <span class="impact-bar-label">FORM</span>
              <span class="impact-bar-val" style="color:${statTextColor(color)}">${forma}</span>
              ${trendHtml ? `<div style="margin-top:3px;text-align:right">${trendHtml}</div>` : ''}
            </div>
          </div>`;
        } else if (hs) {
          const ops = parseFloat(hs.ops)||0;
          const color = getDiamondPlayerColor(ops, 'hitter');
          const barW = Math.min(100, Math.round((ops/1.2)*100));
          const career = ptwCareer[c.pid];
          const trendHtml = !isRookie && career?.ops && ops ? trendBadgeHTML(ops, career.ops, 'ops') : '';
          const statsLine  = `AVG ${hs.avg||'.---'} · HR ${hs.homeRuns??'—'}`;
          const statsLine2 = `RBI ${hs.rbi??'—'} · SB ${hs.stolenBases??'—'}`;
          return `<div class="impact-row">
            <div class="impact-row-left">
              <img class="impact-photo" src="${photoUrl}" style="background:${photoBg}"
                onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
              <div class="impact-name-block">
                <div class="impact-name">${c.name} ${posBadge} ${rookieBadge} ${teamPill}</div>
                <div class="impact-stats-line">${statsLine}</div>
                <div class="impact-stats-line">${statsLine2}</div>
                ${badgeFn ? badgeFn(c) : ''}
              </div>
            </div>
            <div class="impact-bar-block">
              <div class="impact-bar-bg"><div class="impact-bar-fill" style="width:${barW}%;background:${color}"></div></div>
            </div>
            <div class="impact-bar-val-wrap">
              <span class="impact-bar-label">OPS</span>
              <span class="impact-bar-val" style="color:${statTextColor(color)}">${ops>0?ops.toFixed(3):'—'}</span>
              ${trendHtml ? `<div style="margin-top:3px;text-align:right">${trendHtml}</div>` : ''}
            </div>
          </div>`;
        }
        // No stats yet
        return `<div class="impact-row">
          <div class="impact-row-left">
            <img class="impact-photo" src="${photoUrl}" style="background:${photoBg}"
              onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
            <div class="impact-name-block">
              <div class="impact-name">${c.name} ${posBadge} ${teamPill}</div>
            </div>
          </div>
        </div>`;
      }

      // Award candidacy badges for PTW players.
      // Uses live _mvpLists ranks when available; falls back to cached labels from buildCandidateSets.
      function awardCandidacyBadge(c) {
        if (!c.labels?.length) return '';
        const labelMap = { MVP: 'MVP RACE', CY: 'CY RACE', ROY: 'ROY RACE' };
        const order = { MVP: 0, CY: 1, ROY: 2 };
        const badgeThreshold = { MVP: 10, CY: 10, ROY: 5 };
        let effectiveLabels = c.labels;
        if (window._mvpLists) {
          const ml = window._mvpLists;
          const liveLookup = {
            MVP: [...(ml.alMVP||[]), ...(ml.nlMVP||[])],
            CY:  [...(ml.alCY||[]),  ...(ml.nlCY||[])],
            ROY: [...(ml.alROY||[]), ...(ml.nlROY||[])],
          };
          const live = [];
          for (const [key, list] of Object.entries(liveLookup)) {
            const found = list.find(p => p.pid === c.pid);
            if (found) live.push({ key, rank: found.rank });
          }
          effectiveLabels = live; // empty = not in any live list → no badges
        }
        if (!effectiveLabels.length) return '';
        return effectiveLabels
          .slice()
          .sort((a, b) => (order[a.key] ?? 99) - (order[b.key] ?? 99) || a.rank - b.rank)
          .filter(entry => entry.rank <= (badgeThreshold[entry.key] ?? 0))
          .map(entry => {
            const label = labelMap[entry.key] || entry.key;
            return `<span class="mvp-award-badge" style="cursor:pointer" onclick="event.stopPropagation();goToMVPFromTopGames('${entry.key}')">${label}</span>`;
          })
          .join(' ');
      }

      const detailHTML = `<div class="tg-detail" id="tgd-${gameId}">
        ${sameDivision ? `<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><span style="font-size:10px;font-weight:700;padding:2px 7px;background:rgba(234,179,8,.15);color:#b45309;border-radius:3px;letter-spacing:.5px">DIVISIONAL</span></div>` : ''}
        <div class="tg-detail-inner">
          <div class="tg-detail-col">
            ${spMini(awayPid, awayPName, awayF, awayS, awayMeta, away.team.id)}
          </div>
          <div class="tg-detail-col">
            ${spMini(homePid, homePName, homeF, homeS, homeMeta, home.team.id)}
          </div>
        </div>
        ${allWatch.length ? `<div class="impact-detail-card" style="margin-top:10px">
          <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--accent);text-transform:uppercase;margin-bottom:6px">PLAYERS TO WATCH</div>
          ${allWatch.map(p => ptwPlayerCard(p, awardCandidacyBadge)).join('')}
        </div>` : ''}
      </div>`;

      return `<div>
        <div class="tg-game-row" id="tgr-${gameId}" data-gamepk="${g.gamePk}" onclick="tgToggleGame('${gameId}')">
            <div class="tg-teams">
            <img class="tg-team-logo" src="${awayMeta.logo}" onerror="this.style.display='none'" alt="">
            <span class="tg-abbr" style="${awayStyle}">${awayMeta.abbr}</span>
            ${scoreHTML}
            <span class="tg-abbr" style="${homeStyle}">${homeMeta.abbr}</span>
            <img class="tg-team-logo" src="${homeMeta.logo}" onerror="this.style.display='none'" alt="">
          </div>
          <div class="tg-badges">${tierBadge}</div>
          <div style="text-align:right;flex-shrink:0;padding-left:10px">
            <div class="tg-time" style="${statusStyle}">${statusText}</div>
            ${venueName ? `<div style="font-family:'Barlow Condensed';font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;margin-top:1px">${venueName}</div>` : ''}
          </div>
        </div>
        ${detailHTML}
      </div>`;
    }

    // ── Build accordion blocks ─────────────────────────────────────────────
    function dayBlock(blockId, title, countStr, isOpen, bodyHTML) {
      return `<div class="tg-day-block" id="${blockId}">
        <div class="tg-day-header ${isOpen?'open':''}" onclick="tgToggleDay('${blockId}')">
          <span class="tg-day-title">${title}</span>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="tg-day-count">${countStr}</span>
            <svg class="tg-day-chevron ${isOpen?'open':''}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
        <div class="tg-day-body ${isOpen?'open':''}">${bodyHTML}</div>
      </div>`;
    }

    const fmtDate = d => d.toLocaleDateString('en-US', { weekday:'short', day:'numeric', month:'short' }).toUpperCase();

    // AYER
    const yBody = yesterdayGames.length
      ? yesterdayGames.map((g, i) => yesterdayRowHTML(g, i)).join('')
      : `<div style="padding:16px 18px;color:var(--muted);font-family:'Barlow Condensed';font-size:13px;letter-spacing:1px">No games yesterday.</div>`;

    // HOY
    const todayTiers = scoreTiers(todayGames);
    const todayBody = todayGames.length
      ? todayGames.map((g,i) => futureRowHTML(g, i, 'today', todayTiers[i])).join('')
      : `<div style="padding:16px 18px;color:var(--muted);font-family:'Barlow Condensed';font-size:13px;letter-spacing:1px">No games today.</div>`;

    // MAÑANA
    const tmrTiers = scoreTiers(tomorrowGames);
    const tmrBody = tomorrowGames.length
      ? tomorrowGames.map((g,i) => futureRowHTML(g, i, 'tmr', tmrTiers[i])).join('')
      : `<div style="padding:16px 18px;color:var(--muted);font-family:'Barlow Condensed';font-size:13px;letter-spacing:1px">No games tomorrow.</div>`;

    el.innerHTML =
      dayBlock('tg-yday', `YESTERDAY — ${fmtDate(yesterdayD)}`, `${yesterdayGames.length} games`, false, yBody) +
      dayBlock('tg-today',  `TODAY — ${fmtDate(todayD)}`,      `${todayGames.length} games`,     true,  todayBody) +
      dayBlock('tg-tmr',  `TOMORROW — ${fmtDate(tomorrowD)}`,`${tomorrowGames.length} games`,  false, tmrBody);

    window._topGamesCache = { html: el.innerHTML, dateKey: todayKey, hadMvpLists: !!window._mvpLists };

  } catch(e) {
    el.innerHTML = errorStateHTML('loadTopGames()');
  }
}

// ── PLAYERS TAB ───────────────────────────────────────────────────────────────
// Fetches league-wide individual player stats and ranks them by narrative category.
// Uses the MLB Stats API /stats endpoint (league-wide, type=season).

const playersCache = {};  // category → [{player, teamId, statVal}]

const BADGE_SKILL_COLOR = '#2563eb';
const BADGE_DESC_COLOR = '#2563eb';
const HITTER_BADGE_TONES = {
  'Power Hitter': 'skill',
  'Contact Hitter': 'skill',
  'Patient Hitter': 'skill',
  'Base Stealer': 'skill',
  'Speed Threat': 'descriptor',
  'Table Setter': 'descriptor',
  'All-or-Nothing': 'descriptor',
  'Complete Hitter': 'descriptor',
  'Empty Average': 'descriptor',
  'Undisciplined': 'descriptor',
  'Clutch Hitter': 'descriptor',
  'On Fire': 'descriptor',
  'Strikeout Artist': 'skill',
  'Control Specialist': 'skill',
  'Ace': 'descriptor',
  'Quality Starter': 'descriptor',
  'Workhorse': 'descriptor',
  'Elite Closer': 'descriptor',
  'Reliable Closer': 'descriptor',
  'Lockdown Closer': 'descriptor',
  'Setup Man': 'descriptor',
  'Swing Man': 'descriptor',
  'Vulnerable': 'descriptor',
  'Shaky': 'descriptor',
};

function ratePct(num, den) {
  return den > 0 ? `${((num / den) * 100).toFixed(1)}%` : '—';
}

const PLAYER_CATEGORIES = [

  // ── BATEADORES ──────────────────────────────────────────────────────────────

  {
    key: 'power', label: 'Power Hitter',
    desc: 'Hits for power',
    type: 'hitter', statColor: BADGE_SKILL_COLOR,
    displayStat: s => `${s.homeRuns ?? '—'} HR · ${ratePct(parseInt(s.homeRuns)||0, parseInt(s.plateAppearances||s.atBats)||0)} HR/PA`,
    filter: (s, lg) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const hr = parseInt(s.homeRuns)||0;
      const hrPA = pa > 0 ? hr/pa : 0;
      return pa >= 60 && hrPA >= (lg.hrPA||0.032) * 1.15;
    },
    score: s => {
      const pa = parseInt(s.plateAppearances||s.atBats)||1;
      return (parseInt(s.homeRuns)||0)/pa;
    },
  },

  {
    key: 'contact', label: 'Contact Hitter',
    desc: 'Hits for contact',
    type: 'hitter', statColor: BADGE_SKILL_COLOR,
    displayStat: s => `.${(parseFloat(s.avg)||0).toFixed(3).slice(2)} AVG · ${s.hits ?? '—'} H`,
    filter: (s, lg) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const avg = parseFloat(s.avg)||0;
      return pa >= 75 && avg >= (lg.avg||0.245) + 0.025;
    },
    score: s => parseFloat(s.avg)||0,
  },

  {
    key: 'patient', label: 'Patient Hitter',
    desc: 'Plate discipline',
    type: 'hitter', statColor: BADGE_SKILL_COLOR,
    displayStat: s => `${ratePct(parseInt(s.walks ?? s.baseOnBalls)||0, parseInt(s.plateAppearances||s.atBats)||0)} BB/PA · .${(parseFloat(s.obp)||0).toFixed(3).slice(2)} OBP`,
    filter: (s, lg) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const obp = parseFloat(s.obp)||0;
      const bb = parseInt(s.walks ?? s.baseOnBalls)||0;
      const bbPA = pa > 0 ? bb/pa : 0;
      return pa >= 60 && bbPA >= (lg.bbPA||0.085) * 1.25 && obp >= (lg.obp||0.315) + 0.020;
    },
    score: s => {
      const pa = parseInt(s.plateAppearances||s.atBats)||1;
      return (parseInt(s.walks ?? s.baseOnBalls)||0)/pa;
    },
  },

  {
    key: 'basestealer', label: 'Base Stealer',
    desc: 'Steals bases efficiently',
    type: 'hitter', statColor: BADGE_SKILL_COLOR,
    displayStat: s => `${s.stolenBases ?? '—'} SB · ${s.caughtStealing ?? '—'} CS`,
    filter: (s, lg) => {
      const sb = parseInt(s.stolenBases)||0;
      const cs = parseInt(s.caughtStealing)||0;
      const sbAtt = sb + cs;
      return sbAtt >= 4 && cs/Math.max(sbAtt,1) <= 0.25;
    },
    score: s => {
      const sb = parseInt(s.stolenBases)||0;
      const cs = parseInt(s.caughtStealing)||0;
      const sbAtt = sb + cs;
      return sbAtt ? sb/sbAtt : 0;
    },
  },

  {
    key: 'speed', label: 'Speed Threat',
    desc: 'A constant threat on the bases',
    type: 'hitter', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${(parseInt(s.stolenBases)||0) + (parseInt(s.caughtStealing)||0)} ATT · ${s.stolenBases ?? '—'} SB`,
    filter: (s, lg) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const sb = parseInt(s.stolenBases)||0;
      const cs = parseInt(s.caughtStealing)||0;
      const sbAtt = sb + cs;
      const sbAttPA = pa > 0 ? sbAtt/pa : 0;
      return pa >= 40 && sbAtt >= 4 && sbAttPA >= (lg.sbAttPA||0.010) * 2.5;
    },
    score: s => (parseInt(s.stolenBases)||0) + (parseInt(s.caughtStealing)||0),
  },

  {
    key: 'tablesetter', label: 'Table Setter',
    desc: 'Sets the table on offense',
    type: 'hitter', statColor: BADGE_DESC_COLOR,
    displayStat: s => `.${(parseFloat(s.obp)||0).toFixed(3).slice(2)} OBP · ${s.walks ?? s.baseOnBalls ?? '—'} BB`,
    filter: (s, lg) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const obp = parseFloat(s.obp)||0;
      const hrPA = pa > 0 ? (parseInt(s.homeRuns)||0)/pa : 0;
      return pa >= 60 && obp >= (lg.obp||0.315) + 0.030 && hrPA <= (lg.hrPA||0.032) * 0.65;
    },
    score: s => parseFloat(s.obp)||0,
  },

  {
    key: 'allornothing', label: 'All-or-Nothing',
    desc: 'Extreme outcomes: homer or strikeout',
    type: 'hitter', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.homeRuns ?? '—'} HR · ${s.strikeOuts ?? '—'} K`,
    filter: (s, lg) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const so = parseInt(s.strikeOuts)||0;
      const hr = parseInt(s.homeRuns)||0;
      return pa >= 75 && pa > 0
        && (so/pa) >= (lg.soPA||0.225) * 1.15
        && (hr/pa) >= (lg.hrPA||0.032) * 1.05;
    },
    score: s => {
      const pa = parseInt(s.plateAppearances||s.atBats)||1;
      return ((parseInt(s.strikeOuts)||0) + (parseInt(s.homeRuns)||0)*3) / pa;
    },
  },

  {
    key: 'complete', label: 'Complete Hitter',
    desc: 'Combines contact, power and discipline',
    type: 'hitter', statColor: BADGE_DESC_COLOR,
    displayStat: s => `.${(parseFloat(s.avg)||0).toFixed(3).slice(2)} AVG · .${(parseFloat(s.ops)||0).toFixed(3).slice(2)} OPS`,
    filter: (s, lg) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const avg = parseFloat(s.avg)||0;
      const hrPA = pa > 0 ? (parseInt(s.homeRuns)||0)/pa : 0;
      const bbPA = pa > 0 ? (parseInt(s.walks ?? s.baseOnBalls)||0)/pa : 0;
      return pa >= 75
        && avg >= (lg.avg||0.245) + 0.020
        && hrPA >= (lg.hrPA||0.032) * 1.10
        && bbPA >= (lg.bbPA||0.085) * 1.10;
    },
    score: s => parseFloat(s.ops)||0,
  },

  {
    key: 'emptyavg', label: 'Empty Average',
    desc: 'High average, little impact',
    type: 'hitter', statColor: BADGE_DESC_COLOR,
    displayStat: s => `.${(parseFloat(s.avg)||0).toFixed(3).slice(2)} AVG · .${(parseFloat(s.slg)||0).toFixed(3).slice(2)} SLG`,
    filter: (s, lg) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const avg = parseFloat(s.avg)||0;
      const slg = parseFloat(s.slg)||0;
      return pa >= 80 && avg >= (lg.avg||0.245) + 0.025 && slg <= (lg.slg||0.405);
    },
    score: s => parseFloat(s.avg)||0,
  },

  {
    key: 'undisciplined', label: 'Undisciplined',
    desc: 'Poor control at the plate',
    type: 'hitter', statColor: BADGE_DESC_COLOR,
    displayStat: s => {
      const bb = parseInt(s.baseOnBalls||s.walks)||0;
      const so = parseInt(s.strikeOuts)||0;
      const ratio = bb > 0 ? (so/bb).toFixed(1) : '∞';
      return `${so} K / ${bb} BB (${ratio})`;
    },
    filter: (s, lg) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const so = parseInt(s.strikeOuts)||0;
      const bb = parseInt(s.baseOnBalls||s.walks)||0;
      const avg = parseFloat(s.avg)||0;
      const obp = parseFloat(s.obp)||0;
      return pa >= 60 && (obp < avg + 0.025 || (bb > 0 && so/bb >= 2.8));
    },
    score: s => {
      const bb = parseInt(s.baseOnBalls||s.walks)||1;
      const so = parseInt(s.strikeOuts)||0;
      return so/bb;
    },
  },

  {
    key: 'clutch', label: 'Clutch Hitter',
    desc: 'Steps up in key moments',
    type: 'hitter', statColor: BADGE_DESC_COLOR,
    displayStat: s => {
      const risp = parseFloat(s.avgWithRISP||s.rISP||0)||0;
      return risp > 0
        ? `.${risp.toFixed(3).slice(2)} RISP · .${(parseFloat(s.avg)||0).toFixed(3).slice(2)} AVG`
        : `.${(parseFloat(s.avg)||0).toFixed(3).slice(2)} AVG · ${s.rbi ?? '—'} RBI`;
    },
    filter: (s, lg) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const avg = parseFloat(s.avg)||0;
      const risp = parseFloat(s.avgWithRISP||s.rISP||0)||0;
      return pa >= 100 && risp > 0 && risp >= avg + 0.035;
    },
    score: s => {
      const risp = parseFloat(s.avgWithRISP||s.rISP||0)||0;
      return risp;
    },
  },

  {
    key: 'onfire', label: 'On Fire',
    desc: 'On a recent hot streak',
    type: 'hitter', statColor: BADGE_DESC_COLOR,
    displayStat: (s, p) => {
      const recentOps = p?.recentOps;
      return recentOps != null
        ? `.${recentOps.toFixed(3).slice(2)} 30D OPS · .${(parseFloat(s.ops)||0).toFixed(3).slice(2)} OPS`
        : `.${(parseFloat(s.ops)||0).toFixed(3).slice(2)} OPS`;
    },
    filter: (s, lg, p) => {
      const pa = parseInt(s.plateAppearances||s.atBats)||0;
      const ops = parseFloat(s.ops)||0;
      const recentOps = p?.recentOps;
      return pa >= 60 && recentOps != null && ops > 0 && recentOps - ops >= 0.095;
    },
    score: (s, p) => (p?.recentOps ?? 0) - (parseFloat(s.ops)||0),
  },

  // ── PITCHERS ────────────────────────────────────────────────────────────────

  {
    key: 'strikeoutartist', label: 'Strikeout Artist',
    desc: 'Racks up strikeouts',
    type: 'pitcher', statColor: BADGE_SKILL_COLOR,
    displayStat: s => {
      const ip = parseFloat(s.inningsPitched)||1;
      return `${((parseInt(s.strikeOuts)||0)/ip*9).toFixed(1)} K/9 · ${s.strikeOuts ?? '—'} K`;
    },
    filter: (s, lg) => {
      const gp = parseInt(s.gamesPitched)||0;
      const ip = parseFloat(s.inningsPitched)||0;
      const k9 = ip > 0 ? (parseInt(s.strikeOuts)||0)/ip*9 : 0;
      return gp >= 3 && ip >= 5 && k9 >= (lg.pitchK9||8.5) * 1.10;
    },
    score: s => {
      const ip = parseFloat(s.inningsPitched)||1;
      return (parseInt(s.strikeOuts)||0)/ip*9;
    },
  },

  {
    key: 'control', label: 'Control Specialist',
    desc: 'Limits walks',
    type: 'pitcher', statColor: BADGE_SKILL_COLOR,
    displayStat: s => {
      const ip = parseFloat(s.inningsPitched)||1;
      return `${((parseInt(s.baseOnBalls)||0)/ip*9).toFixed(1)} BB/9 · ${s.baseOnBalls ?? '—'} BB`;
    },
    filter: (s, lg) => {
      const gp = parseInt(s.gamesPitched)||0;
      const ip = parseFloat(s.inningsPitched)||0;
      const bb9 = ip > 0 ? (parseInt(s.baseOnBalls)||0)/ip*9 : 99;
      return gp >= 3 && ip >= 5 && bb9 <= (lg.pitchBb9||3.2) * 0.80;
    },
    score: s => {
      const ip = parseFloat(s.inningsPitched)||1;
      return -((parseInt(s.baseOnBalls)||0)/ip*9);
    },
  },

  {
    key: 'ace', label: 'Ace',
    desc: 'Elite starter in performance and volume',
    type: 'pitcher', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.era ?? '—'} ERA · ${s.whip ?? '—'} WHIP`,
    filter: (s, lg) => {
      const gs = parseInt(s.gamesStarted)||0;
      const ip = parseFloat(s.inningsPitched)||0;
      const era = parseFloat(s.era)||0;
      const whip = parseFloat(s.whip)||0;
      const ipPS = gs > 0 ? ip/gs : 0;
      return gs >= 2 && ip > 0 && era > 0
        && era <= (lg.pitchEra||4.10) * 0.85
        && whip <= (lg.pitchWhip||1.28) * 0.90
        && ipPS >= 5.8;
    },
    score: s => -(parseFloat(s.era)||99),
  },

  {
    key: 'qualitystarter', label: 'Quality Starter',
    desc: 'Solid starter, above average',
    type: 'pitcher', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.era ?? '—'} ERA · ${s.whip ?? '—'} WHIP`,
    filter: (s, lg) => {
      const gs = parseInt(s.gamesStarted)||0;
      const ip = parseFloat(s.inningsPitched)||0;
      const era = parseFloat(s.era)||0;
      const whip = parseFloat(s.whip)||0;
      const ipPS = gs > 0 ? ip/gs : 0;
      return gs >= 2 && ip > 0 && era > 0
        && era <= (lg.pitchEra||4.10) * 0.95
        && whip <= (lg.pitchWhip||1.28) * 0.95
        && ipPS >= 5.2;
    },
    score: s => -(parseFloat(s.era)||99),
  },

  {
    key: 'workhorse', label: 'Workhorse',
    desc: 'Pitches deep into games',
    type: 'pitcher', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.inningsPitched ?? '—'} IP · ${s.gamesStarted ?? '—'} GS`,
    filter: (s, lg) => {
      const gs = parseInt(s.gamesStarted)||0;
      const ip = parseFloat(s.inningsPitched)||0;
      return gs >= 2 && (ip/Math.max(gs,1)) >= 6.2;
    },
    score: s => parseFloat(s.inningsPitched)||0,
  },

  {
    key: 'elitecloser', label: 'Elite Closer',
    desc: 'Dominant closer',
    type: 'pitcher', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.saves ?? '—'} SV · ${s.saveOpportunities ?? '—'} SVO · ${s.era ?? '—'} ERA`,
    filter: (s, lg) => {
      const gp = parseInt(s.gamesPitched)||0;
      const sv = parseInt(s.saves)||0;
      const svo = parseInt(s.saveOpportunities)||0;
      const era = parseFloat(s.era)||0;
      const svPct = svo > 0 ? sv/svo : 0;
      return gp >= 3 && svo >= 1 && era > 0 && era <= (lg.pitchEra||4.10) * 0.85 && svPct >= 0.85;
    },
    score: s => parseInt(s.saves)||0,
  },

  {
    key: 'reliablecloser', label: 'Reliable Closer',
    desc: 'Consistent closer',
    type: 'pitcher', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.saves ?? '—'} SV · ${s.saveOpportunities ?? '—'} SVO · ${s.era ?? '—'} ERA`,
    filter: (s, lg) => {
      const gp = parseInt(s.gamesPitched)||0;
      const sv = parseInt(s.saves)||0;
      const svo = parseInt(s.saveOpportunities)||0;
      const era = parseFloat(s.era)||0;
      const svPct = svo > 0 ? sv/svo : 0;
      return gp >= 3 && svo >= 1 && era > 0 && era <= (lg.pitchEra||4.10) && svPct >= 0.75;
    },
    score: s => {
      const sv = parseInt(s.saves)||0;
      const svo = parseInt(s.saveOpportunities)||1;
      return sv/svo;
    },
  },

  {
    key: 'lockdowncloser', label: 'Lockdown Closer',
    desc: 'Highly dominant closer',
    type: 'pitcher', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.era ?? '—'} ERA · ${s.whip ?? '—'} WHIP`,
    filter: (s, lg) => {
      const gp = parseInt(s.gamesPitched)||0;
      const sv = parseInt(s.saves)||0;
      const era = parseFloat(s.era)||0;
      const whip = parseFloat(s.whip)||0;
      return gp >= 3 && sv >= 1 && era > 0
        && era <= (lg.pitchEra||4.10) * 0.75
        && whip <= (lg.pitchWhip||1.28) * 0.85;
    },
    score: s => -(parseFloat(s.whip)||99),
  },

  {
    key: 'setupman', label: 'Setup Man',
    desc: 'High-end setup reliever',
    type: 'pitcher', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.holds ?? '—'} HLD · ${s.era ?? '—'} ERA · ${s.whip ?? '—'} WHIP`,
    filter: (s, lg) => {
      const gp = parseInt(s.gamesPitched)||0;
      const hld = parseInt(s.holds)||0;
      const era = parseFloat(s.era)||0;
      return gp >= 5 && hld >= 2 && era > 0 && era <= (lg.pitchEra||4.10) * 0.95;
    },
    score: s => parseInt(s.holds)||0,
  },

  {
    key: 'swingman', label: 'Swing Man',
    desc: 'Versatile multi-inning reliever',
    type: 'pitcher', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.inningsPitched ?? '—'} IP · ${s.gamesPitched ?? '—'} GP`,
    filter: (s, lg) => {
      const gp = parseInt(s.gamesPitched)||0;
      const gs = parseInt(s.gamesStarted)||0;
      const ip = parseFloat(s.inningsPitched)||0;
      const ipPerApp = gp > 0 ? ip/gp : 0;
      return gp >= 5 && gs <= 2 && ipPerApp >= (lg.pitchIpPerApp||1.30) * 1.20;
    },
    score: s => {
      const gp = parseInt(s.gamesPitched)||1;
      return (parseFloat(s.inningsPitched)||0)/gp;
    },
  },

  {
    key: 'vulnerable', label: 'Vulnerable',
    desc: 'Allows too many runs',
    type: 'pitcher', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.era ?? '—'} ERA · ${s.whip ?? '—'} WHIP`,
    filter: (s, lg) => {
      const gs = parseInt(s.gamesStarted)||0;
      const gp = parseInt(s.gamesPitched)||0;
      const ip = parseFloat(s.inningsPitched)||0;
      const era = parseFloat(s.era)||0;
      return ip > 0 && era >= (lg.pitchEra||4.10) * 1.15 && (gs >= 3 || gp >= 8);
    },
    score: s => parseFloat(s.era)||0,
  },

  {
    key: 'shaky', label: 'Shaky',
    desc: 'Unreliable in relief',
    type: 'pitcher', statColor: BADGE_DESC_COLOR,
    displayStat: s => `${s.era ?? '—'} ERA · ${s.whip ?? '—'} WHIP`,
    filter: (s, lg) => {
      const gp = parseInt(s.gamesPitched)||0;
      const gs = parseInt(s.gamesStarted)||0;
      const ip = parseFloat(s.inningsPitched)||0;
      const era = parseFloat(s.era)||0;
      const whip = parseFloat(s.whip)||0;
      return gp >= 5 && gs <= 1 && ip > 0
        && era >= (lg.pitchEra||4.10) * 1.10
        && whip >= (lg.pitchWhip||1.28) * 1.10;
    },
    score: s => (parseFloat(s.era)||0) + (parseFloat(s.whip)||0),
  },

];

async function loadPlayers() {
  const el = document.getElementById('playersContent');
  el.innerHTML = `<div class="loading"><div class="spinner"></div><div class="loading-text">LOADING PLAYERS...</div></div>`;

  try {
    // Fetch league stats + league averages in parallel
    await fetchLeagueTeamStats();
    const lgMap = leagueTeamStatsCache || {};
    const lgAvg = lgMap._leagueAvg || {};
    const lgPitch = lgMap._leaguePitch || {};

    const lg = {
      avg: lgAvg.avg || 0.245,
      obp: lgAvg.obp || 0.315,
      slg: lgAvg.slg || 0.405,
      hrPA: lgAvg.hrPA || 0.032,
      sbPA: lgAvg.sbPA || 0.008,
      sbAttPA: lgAvg.sbAttPA || 0.010,
      soPA: lgAvg.soPA || 0.225,
      bbPA: lgAvg.bbPA || 0.085,
      pitchEra: lgPitch.era || 4.10,
      pitchWhip: lgPitch.whip || 1.28,
      pitchK9: lgPitch.k9 || 8.5,
      pitchBb9: lgPitch.bb9 || 3.2,
      pitchIpPerApp: lgPitch.ipPerApp || 1.30,
    };

    // Fetch all MLB hitters and pitchers season stats
    const [hitData, pitchData] = await Promise.all([
      fetchWithTimeout(`${MLB_API}/stats?stats=season&season=${CURRENT_YEAR}&group=hitting&gameType=R&sportId=1&limit=500&offset=0`)
        .then(r => r.json()).catch(() => ({ stats: [] })),
      fetchWithTimeout(`${MLB_API}/stats?stats=season&season=${CURRENT_YEAR}&group=pitching&gameType=R&sportId=1&limit=500&offset=0`)
        .then(r => r.json()).catch(() => ({ stats: [] })),
    ]);

    const hitters = (hitData.stats?.[0]?.splits || []).map(sp => ({
      pid: sp.player?.id,
      name: sp.player?.fullName || '?',
      teamId: sp.team?.id,
      teamAbbr: (sp.team?.id && TEAM_META[sp.team.id]?.abbr) || sp.team?.abbreviation || '?',
      stats: sp.stat,
    })).filter(p => p.pid);

    await fetchRecentHitting(hitters.map(p => p.pid));
    hitters.forEach(p => { p.recentOps = recentHittingCache[p.pid]; });

    const pitchers = (pitchData.stats?.[0]?.splits || []).map(sp => ({
      pid: sp.player?.id,
      name: sp.player?.fullName || '?',
      teamId: sp.team?.id,
      teamAbbr: (sp.team?.id && TEAM_META[sp.team.id]?.abbr) || sp.team?.abbreviation || '?',
      stats: sp.stat,
    })).filter(p => p.pid);

    // Build each category's top 10
    function buildCategory(cat) {
      const pool = cat.type === 'hitter' ? hitters : pitchers;
      return pool
        .filter(p => cat.filter(p.stats, lg, p))
        .sort((a, b) => cat.score(b.stats, b) - cat.score(a.stats, a))
        .slice(0, 10)
        .map((p, i) => ({ ...p, rank: i + 1 }));
    }

    // Render
    const hitterCats = PLAYER_CATEGORIES.filter(c => c.type === 'hitter');
    const pitcherCats = PLAYER_CATEGORIES.filter(c => c.type === 'pitcher');

    function cardHTML(p, cat) {
      const photoUrl = siloHeadshot(p.pid);
      const teamMeta = TEAM_META[p.teamId];
      const teamLogo = teamMeta ? `<img src="${teamMeta.logo}" style="width:14px;height:14px;object-fit:contain;vertical-align:middle;margin-right:3px" onerror="this.style.display='none'">` : '';
      return `<div class="player-rank-card">
        <div class="player-rank-num${p.rank <= 3 ? ' top3' : ''}">${p.rank}</div>
        <img class="player-rank-photo" src="${photoUrl}" style="background:${teamPhotoBg(p.teamId)}" alt="${p.name}"
          onerror="this.src='https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_213,q_auto:best/v1/people/0/headshot/silo/current'">
        <div class="player-rank-info">
          <div class="player-rank-name">${p.name}</div>
          <div class="player-rank-team">${teamLogo}${p.teamAbbr}</div>
        </div>
        <div class="player-rank-stat">
          <span class="player-rank-stat-val" style="color:${cat.statColor}">${cat.displayStat(p.stats, p)}</span>
          <span class="player-rank-stat-lbl">${cat.label}</span>
        </div>
      </div>`;
    }

    function sectionHTML(cat, players) {
      if (!players.length) return '';
      return `<div>
        <div class="players-section-header">
          <span class="players-section-title">${cat.label}</span>
          <span class="players-section-desc">"${cat.desc}"</span>
        </div>
        <div class="players-grid">
          ${players.map(p => cardHTML(p, cat)).join('')}
        </div>
      </div>`;
    }

    const hitterSections = hitterCats.map(c => sectionHTML(c, buildCategory(c))).filter(Boolean).join('');
    const pitcherSections = pitcherCats.map(c => sectionHTML(c, buildCategory(c))).filter(Boolean).join('');

    el.innerHTML = `<div class="players-layout">
      <div class="section-title">⚾ HITTERS</div>
      ${hitterSections || '<div style="color:var(--muted);font-family:Barlow Condensed;padding:20px 0">Not enough data yet.</div>'}
      <div class="section-title">🎯 PITCHERS</div>
      ${pitcherSections || '<div style="color:var(--muted);font-family:Barlow Condensed;padding:20px 0">Not enough data yet.</div>'}
    </div>`;

  } catch(e) {
    el.innerHTML = errorStateHTML('loadPlayers()');
  }
}

// ── PAST AWARD WINNERS ────────────────────────────────────────────────────
// Active players only. Format: pid -> { mvp: [years], cy: [years] }
// Player IDs from MLB Stats API
const PAST_AWARDS = {
  // ── MVP winners (active) ──
  547989: { mvp: [2017] },              // José Altuve
  592450: { mvp: [2022, 2024, 2025] },  // Aaron Judge
  660271: { mvp: [2021, 2023, 2024, 2025] }, // Shohei Ohtani
  545361: { mvp: [2014, 2016, 2019] },  // Mike Trout
  605141: { mvp: [2018] },              // Mookie Betts
  592885: { mvp: [2018] },              // Christian Yelich
  592518: { mvp: [2019] },              // Cody Bellinger
  547180: { mvp: [2015, 2021] },        // Bryce Harper
  457705: { mvp: [2020] },              // Freddie Freeman
  502671: { mvp: [2022] },              // Paul Goldschmidt
  660670: { mvp: [2023] },              // Ronald Acuña Jr.
  592102: { mvp: [2016] },              // Kris Bryant
  571448: { mvp: [2017] },              // Giancarlo Stanton
  457727: { mvp: [2013] },              // Andrew McCutchen
  547963: { mvp: [2020] },              // José Abreu
  // ── Cy Young winners (active) ──
  434378: { cy: [2011, 2019, 2022] },   // Justin Verlander
  453286: { cy: [2013, 2016, 2017] },   // Max Scherzer
  605483: { cy: [2018, 2023] },         // Blake Snell
  594798: { cy: [2018, 2019] },         // Jacob deGrom
  669456: { cy: [2020] },               // Shane Bieber
  592662: { cy: [2021] },               // Robbie Ray
  669203: { cy: [2021] },               // Corbin Burnes
  645261: { cy: [2022] },               // Sandy Alcántara
  543037: { cy: [2023] },               // Gerrit Cole
  519242: { cy: [2024] },               // Chris Sale
  669373: { cy: [2024, 2025] },         // Tarik Skubal
  694973: { cy: [2025] },               // Paul Skenes
  545333: { cy: [2020] },               // Trevor Bauer
};
// Verlander also won MVP 2011
if (PAST_AWARDS[434378]) PAST_AWARDS[434378].mvp = [2011];

function awardsBadgeHTML(pid, type) {
  const a = PAST_AWARDS[pid];
  if (!a) return '';
  const years = type === 'mvp' ? a.mvp : a.cy;
  if (!years || !years.length) return '';
  const label = type === 'mvp' ? 'MVP' : 'CY';
  const yrText = years.length === 1 ? years[0] : years.join(', ');
  return `<span class="mvp-award-badge" title="Ganador ${label}: ${yrText}">🏆 ${label} ${yrText}</span>`;
}

// ── MVP TRACKER ───────────────────────────────────────────────────────────────
let mvpActiveTracker = 'all'; // 'all' | 'mvp' | 'cy'
let mvpTrackerPromise = null;

function ensureMvpLists() {
  if (hasCompleteMvpLists()) return Promise.resolve(window._mvpLists);
  return loadMVPTracker().then(() => window._mvpLists || null);
}

async function loadMVPTracker() {
  if (mvpTrackerPromise) return mvpTrackerPromise;
  mvpTrackerPromise = _loadMVPTracker().catch(e => {
    mvpTrackerPromise = null;
    throw e;
  });
  return mvpTrackerPromise;
}

async function _loadMVPTracker() {
  const el = document.getElementById('mvpContent');
  el.innerHTML = `<div class="loading"><div class="spinner"></div><div class="loading-text">CALCULATING SCORES...</div></div>`;

  // ── Daily cache: expires at 09:00 UTC (= 01:00 PT) ──────────────────────
  const CACHE_KEY = `mvp_cache_${CURRENT_YEAR}_v2`;
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (Date.now() > cached.expiry) { localStorage.removeItem(CACHE_KEY); return null; }
      return cached.data;
    } catch(e) { return null; }
  }
  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ expiry: getCacheExpiry(), storedAt: Date.now(), data }));
    } catch(e) {}
  }

  try {
    await fetchLeagueTeamStats();
    const lgMap = leagueTeamStatsCache || {};
    const lgAvg = lgMap._leagueAvg || {};
    const lgPitch = lgMap._leaguePitch || {};

    // Try loading from cache first
    let cached = loadCache();
    let rawHitters, rawPitchers, positionMap, careerLoaded;

    if (cached) {
      // Restore from cache — skip all the heavy fetches
      rawHitters   = cached.rawHitters;
      rawPitchers  = cached.rawPitchers;
      positionMap  = cached.positionMap;
      // Restore career stats into the module-level cache
      Object.assign(careerStatsCache, cached.careerStatsCache);
      if (cached.seasonHistoryCache) Object.assign(seasonHistoryCache, cached.seasonHistoryCache);
      careerLoaded = true;
    } else {
      careerLoaded = false;
    }

    if (!cached) {
    // Fetch hitters and pitchers in parallel
    const [hitData, pitchData] = await Promise.all([
      fetchWithTimeout(`${MLB_API}/stats?stats=season&season=${CURRENT_YEAR}&group=hitting&gameType=R&sportId=1&limit=800&offset=0`)
        .then(r => r.json()).catch(() => ({ stats: [] })),
      fetchWithTimeout(`${MLB_API}/stats?stats=season&season=${CURRENT_YEAR}&group=pitching&gameType=R&sportId=1&limit=800&offset=0`)
        .then(r => r.json()).catch(() => ({ stats: [] })),
    ]);

    rawHitters = (hitData.stats?.[0]?.splits || []).map(sp => ({
      pid: sp.player?.id, name: sp.player?.fullName || '?',
      teamId: sp.team?.id,
      teamAbbr: (sp.team?.id && TEAM_META[sp.team.id]?.abbr) || sp.team?.abbreviation || '?',
      leagueId: sp.team?.id ? getTeamLeagueId(sp.team.id) : null,
      s: sp.stat,
    })).filter(p => p.pid);

    rawPitchers = (pitchData.stats?.[0]?.splits || []).map(sp => ({
      pid: sp.player?.id, name: sp.player?.fullName || '?',
      teamId: sp.team?.id,
      teamAbbr: (sp.team?.id && TEAM_META[sp.team.id]?.abbr) || sp.team?.abbreviation || '?',
      leagueId: sp.team?.id ? getTeamLeagueId(sp.team.id) : null,
      s: sp.stat,
    })).filter(p => p.pid);

    // TWP fallback: if Ohtani isn't in the general pitching leaderboard (e.g. early season
    // or low IP), fetch his pitching stats directly and inject him into rawPitchers so
    // the Cy Young tracker can evaluate him.
    const OHTANI_PID = 660271;
    // Mark Ohtani as TWP if already in rawPitchers (came from general leaderboard)
    const ohtaniInList = rawPitchers.find(p => p.pid === OHTANI_PID);
    if (ohtaniInList) {
      ohtaniInList.isTWP = true;
    } else {
      // Not in leaderboard (low IP early season) — fetch directly and inject
      try {
        const od = await fetchWithTimeout(
          `${MLB_API}/people/${OHTANI_PID}?hydrate=stats(group=[pitching],type=season,season=${CURRENT_YEAR})`
        ).then(r => r.json()).catch(() => null);
        const op = od?.people?.[0];
        const os = op?.stats?.find(g => g.group?.displayName === 'pitching')?.splits?.[0]?.stat;
        if (op && os && parseFloat(os.inningsPitched || 0) > 0) {
          const teamId = op.currentTeam?.id || 119; // 119 = Dodgers fallback
          rawPitchers.push({
            pid: OHTANI_PID,
            name: op.fullName || 'Shohei Ohtani',
            teamId,
            teamAbbr: (teamId && TEAM_META[teamId]?.abbr) || op.currentTeam?.abbreviation || 'LAD',
            leagueId: teamId ? getTeamLeagueId(teamId) : 104,
            isTWP: true,
            s: os,
          });
        }
      } catch(e) {}
    }

    // Fetch primary positions for hitters (needed for displaying "1B", "SS", etc.)
    const hitterPids = rawHitters.map(p => p.pid).slice(0, 200); // top 200 by PA-ish
    positionMap = {};
    try {
      // chunk into groups of 100 for the people endpoint
      const chunks = [];
      for (let i = 0; i < hitterPids.length; i += 100) chunks.push(hitterPids.slice(i, i+100));
      await Promise.all(chunks.map(chunk =>
        fetchWithTimeout(`${MLB_API}/people?personIds=${chunk.join(',')}`)
          .then(r => r.json())
          .then(d => (d.people || []).forEach(p => {
            const pos = p.primaryPosition?.abbreviation;
            if (pos) positionMap[p.id] = pos === 'TWP' ? 'DH' : pos;
          }))
          .catch(() => {})
      ));
    } catch(e) {}

    } // end if(!cached)

    rawHitters.forEach(p => { p.position = positionMap[p.pid] || ''; });

    await fetchMvpPitcherQS(
      rawPitchers
        .filter(p => (parseInt(p.s?.gamesStarted || 0) || 0) > 0)
        .map(p => p.pid)
    );
    rawPitchers.forEach(p => {
      const computedQs = mvpPitcherQSCache[p.pid];
      if (computedQs != null) p.s.qualityStarts = computedQs;
    });

    // --- PA leader to set min threshold dynamically
    const maxPA = Math.max(1, ...rawHitters.map(p => parseInt(p.s?.plateAppearances||0)));
    const minPA = Math.max(50, Math.round(maxPA * 0.40));
    const maxIP = Math.max(1, ...rawPitchers.map(p => parseFloat(p.s?.inningsPitched||0)));
    const minIP = Math.max(15, Math.round(maxIP * 0.40));
    const minGS = 3;

    // Compute rbiPA, runsPA, sbEff from the actual splits (team-level API doesn't have these)
    let totRBI=0, totRuns=0, totSB=0, totCS=0, totPA=0, totN=0;
    rawHitters.forEach(p => {
      const pa = parseInt(p.s?.plateAppearances||0);
      if (pa < 30) return;
      totRBI  += parseInt(p.s?.rbi||0);
      totRuns += parseInt(p.s?.runs||0);
      totSB   += parseInt(p.s?.stolenBases||0);
      totCS   += parseInt(p.s?.caughtStealing||0);
      totPA   += pa;
      totN++;
    });
    const lg = {
      ops:   (lgAvg.obp||0.315) + (lgAvg.slg||0.405),
      obp:   lgAvg.obp || 0.315,
      slg:   lgAvg.slg || 0.405,
      hrPA:  lgAvg.hrPA || 0.032,
      rbiPA: totPA > 0 ? totRBI/totPA  : 0.055,
      runsPA:totPA > 0 ? totRuns/totPA : 0.055,
      sbEff: (totSB+totCS) > 0 ? totSB/(totSB+totCS) : 0.72,
      paShare: maxPA * 0.75,
      era:   lgPitch.era  || 4.10,
      whip:  lgPitch.whip || 1.28,
      k9:    lgPitch.k9   || 8.5,
      bb9:   lgPitch.bb9  || 3.2,
    };

    function ordinal(n) {
      if (!n) return '';
      const mod10 = n % 10, mod100 = n % 100;
      if (mod10 === 1 && mod100 !== 11) return `${n}st`;
      if (mod10 === 2 && mod100 !== 12) return `${n}nd`;
      if (mod10 === 3 && mod100 !== 13) return `${n}rd`;
      return `${n}th`;
    }

    // League-wide stat rank → player color scale (readable text variants).
    // Thresholds tuned for "how notable", not 1-30: top 10 elite, etc.
    function rankSummaryColor(rank) {
      if (rank <= 10) return '#16a34a';   // verde: elite
      if (rank <= 30) return '#7d9440';   // verde claro
      if (rank <= 75) return '#c29200';   // amarillo
      return '#e06f00';                    // naranja
    }

    function buildRankMap(players, valueFn, { desc = true, filter = () => true } = {}) {
      const ranked = players
        .filter(filter)
        .map(p => ({ pid: p.pid, value: valueFn(p) }))
        .filter(x => x.value != null && isFinite(x.value))
        .sort((a, b) => desc ? (b.value - a.value) : (a.value - b.value));
      const map = {};
      let lastValue = null;
      let lastRank = 0;
      ranked.forEach((item, idx) => {
        if (lastValue === null || item.value !== lastValue) lastRank = idx + 1;
        map[item.pid] = lastRank;
        lastValue = item.value;
      });
      return map;
    }

    const hitterRankMaps = {
      ops: buildRankMap(rawHitters, p => (parseFloat(p.s?.obp) || 0) + (parseFloat(p.s?.slg) || 0), { filter: p => parseInt(p.s?.plateAppearances || 0) >= 20 }),
      hr: buildRankMap(rawHitters, p => parseInt(p.s?.homeRuns || 0), { filter: p => parseInt(p.s?.plateAppearances || 0) >= 20 }),
      rbi: buildRankMap(rawHitters, p => parseInt(p.s?.rbi || 0), { filter: p => parseInt(p.s?.plateAppearances || 0) >= 20 }),
      sb: buildRankMap(rawHitters, p => parseInt(p.s?.stolenBases || 0), { filter: p => parseInt(p.s?.plateAppearances || 0) >= 20 }),
    };
    const pitcherRankMaps = {
      era: buildRankMap(rawPitchers, p => parseFloat(p.s?.era || 99), { desc: false, filter: p => parseFloat(p.s?.inningsPitched || 0) >= 10 && parseInt(p.s?.gamesStarted || 0) > 0 }),
      whip: buildRankMap(rawPitchers, p => parseFloat(p.s?.whip || 99), { desc: false, filter: p => parseFloat(p.s?.inningsPitched || 0) >= 10 && parseInt(p.s?.gamesStarted || 0) > 0 }),
      qs: buildRankMap(rawPitchers, p => parseInt(p.s?.qualityStarts || 0), { filter: p => parseInt(p.s?.gamesStarted || 0) > 0 }),
      k: buildRankMap(rawPitchers, p => parseInt(p.s?.strikeOuts || 0), { filter: p => parseFloat(p.s?.inningsPitched || 0) >= 10 }),
    };

    function trackerRankSummary(p, isPitcher) {
      if (isPitcher) {
        const candidates = [
          { label: 'ERA', rank: pitcherRankMaps.era[p.pid], ok: (parseFloat(p.s?.era || 99) < 90) },
          { label: 'WHIP', rank: pitcherRankMaps.whip[p.pid], ok: (parseFloat(p.s?.whip || 99) < 90) },
          { label: 'QS', rank: pitcherRankMaps.qs[p.pid], ok: (parseInt(p.s?.qualityStarts || 0) > 0) },
          { label: 'K', rank: pitcherRankMaps.k[p.pid], ok: (parseInt(p.s?.strikeOuts || 0) > 0) },
        ]
          .filter(x => x.ok && x.rank)
          .sort((a, b) => a.rank - b.rank)
          .slice(0, 3);
        return candidates.length ? candidates.map(x =>
          `<span style="color:${rankSummaryColor(x.rank)}">${ordinal(x.rank)} in ${x.label}</span>`
        ).join(' · ') : '';
      }
      const candidates = [
        { label: 'OPS', rank: hitterRankMaps.ops[p.pid], ok: (((parseFloat(p.s?.obp) || 0) + (parseFloat(p.s?.slg) || 0)) > 0) },
        { label: 'HR', rank: hitterRankMaps.hr[p.pid], ok: (parseInt(p.s?.homeRuns || 0) > 0) },
        { label: 'RBI', rank: hitterRankMaps.rbi[p.pid], ok: (parseInt(p.s?.rbi || 0) > 0) },
        { label: 'SB', rank: hitterRankMaps.sb[p.pid], ok: (parseInt(p.s?.stolenBases || 0) > 0) },
      ]
        .filter(x => x.ok && x.rank)
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 3);
      return candidates.length ? candidates.map(x =>
        `<span style="color:${rankSummaryColor(x.rank)}">${ordinal(x.rank)} in ${x.label}</span>`
      ).join(' · ') : '';
    }

    // --- Helper: normalize a stat value vs league average (returns index 0–200)
    function idx(val, ref) {
      if (!ref || ref === 0) return 100;
      return Math.min(200, Math.max(0, (val / ref) * 100));
    }
    function idxInv(val, ref) {
      if (!val || val === 0) return 200;
      return Math.min(200, Math.max(0, (ref / val) * 100));
    }

    // --- MVP Hitter Score
    function mvpScore(p) {
      const s = p.s;
      const pa = parseInt(s?.plateAppearances||0);
      if (pa < minPA) return null;
      const hits = parseInt(s?.hits||0);
      const ab = parseInt(s?.atBats||1);
      const h1 = hits - (parseInt(s?.doubles||0) + parseInt(s?.triples||0) + parseInt(s?.homeRuns||0));
      const tb = h1 + 2*(parseInt(s?.doubles||0)) + 3*(parseInt(s?.triples||0)) + 4*(parseInt(s?.homeRuns||0));
      const obp = ab > 0 ? parseFloat(s?.obp||0) : 0;
      const slg = ab > 0 ? (tb / ab) : 0;
      const ops = obp + slg;
      const hr = parseInt(s?.homeRuns||0);
      const rbi = parseInt(s?.rbi||0);
      const runs = parseInt(s?.runs||0);
      const sb = parseInt(s?.stolenBases||0);
      const cs = parseInt(s?.caughtStealing||0);
      const sbEff = (sb+cs) > 0 ? sb/(sb+cs) : 0;

      const opsIdx    = idx(ops,   lg.ops);
      const obpIdx    = idx(obp,   lg.obp);
      const slgIdx    = idx(slg,   lg.slg);
      const hrIdx     = idx(hr/Math.max(pa,1), lg.hrPA);
      const rbiIdx    = idx(rbi/Math.max(pa,1), lg.rbiPA);
      const runsIdx   = idx(runs/Math.max(pa,1), lg.runsPA);
      const sbEffIdx  = (sb+cs) >= 3 ? idx(sbEff, lg.sbEff) : 100;
      const paIdx     = idx(pa, lg.paShare);

      const raw =
        0.30 * opsIdx +
        0.15 * obpIdx +
        0.10 * slgIdx +
        0.15 * hrIdx  +
        0.10 * rbiIdx +
        0.05 * runsIdx +
        0.05 * sbEffIdx +
        0.10 * paIdx;

      return Math.min(99.9, raw * 0.58); // scale to ~0-100
    }

    // --- Cy Young Starter Score
    function cyScore(p) {
      const s = p.s;
      const gs = parseInt(s?.gamesStarted||0);
      const ip = parseFloat(s?.inningsPitched||0);
      const sv = parseInt(s?.saves||0);
      const svo = parseInt(s?.saveOpportunities||0);
      const era = parseFloat(s?.era||99);
      const isReliever = gs === 0 || (sv + svo > gs * 3); // more save activity than starts

      // ── RELIEVER path: strict elite thresholds required ──────────────────
      // ERA < 2.00, save% ≥ 90%, > 40 saves. Only truly dominant closers qualify.
      if (isReliever) {
        const savePct = svo > 0 ? sv / svo : 0;
        if (era >= 2.00 || savePct < 0.90 || sv <= 40 || ip < 40) return null;
        const whip  = parseFloat(s?.whip||99);
        const k     = parseInt(s?.strikeOuts||0);
        const bb    = parseInt(s?.baseOnBalls||0);
        const k9    = ip > 0 ? (k/ip)*9 : 0;
        const bb9   = ip > 0 ? (bb/ip)*9 : 0;
        const eraIdx  = idxInv(era,  lg.era);
        const whipIdx = idxInv(whip, lg.whip);
        const k9Idx   = idx(k9,  lg.k9);
        const bb9Idx  = idxInv(bb9, lg.bb9);
        const svPctIdx = idx(savePct, 0.85); // 85% = solid closer baseline
        const raw =
          0.30 * eraIdx +
          0.20 * whipIdx +
          0.20 * k9Idx  +
          0.10 * bb9Idx +
          0.20 * svPctIdx;
        // Cap at 75 so a reliever only displaces starters when the league is weak
        return Math.min(70, raw * 0.56);
      }

      // ── STARTER path ──────────────────────────────────────────────────────
      // TWP (Ohtani): use a lower bar — at least 1 start and 5 IP to be considered.
      // The ipIdx metric will naturally penalize him vs. full-season starters.
      const gsMin = p.isTWP ? 1  : minGS;
      const ipMin = p.isTWP ? 5  : minIP;
      if (gs < gsMin || ip < ipMin) return null;

      const whip = parseFloat(s?.whip||99);
      const k    = parseInt(s?.strikeOuts||0);
      const bb   = parseInt(s?.baseOnBalls||0);
      const k9   = ip > 0 ? (k/ip)*9 : 0;
      const bb9  = ip > 0 ? (bb/ip)*9 : 0;
      const qs   = parseInt(s?.qualityStarts||0);

      const eraIdx  = idxInv(era,  lg.era);
      const whipIdx = idxInv(whip, lg.whip);
      const k9Idx   = idx(k9,  lg.k9);
      const bb9Idx  = idxInv(bb9, lg.bb9);
      const ipIdx   = idx(ip, maxIP);
      const qsIdx   = gs > 0 ? idx(qs/gs, 0.60) : 100;

      const raw =
        0.28 * eraIdx +
        0.20 * whipIdx +
        0.18 * k9Idx  +
        0.12 * bb9Idx +
        0.12 * ipIdx  +
        0.10 * qsIdx;

      return Math.min(99.9, raw * 0.56);
    }

    // --- Stat chip helper: wraps a value in a color class based on how it compares to league
    // dir: 'hi' = higher is better (OPS, HR, SB), 'lo' = lower is better (ERA, WHIP, BB9)
    function chip(label, val, ref, dir, decimals=0) {
      const ratio = dir === 'hi' ? val / ref : ref / val;
      const cls = ratio >= 1.20 ? 'sw' : ratio >= 1.05 ? 'sb' : ratio >= 0.88 ? 'sg' : 'sr';
      const formatted = decimals > 0 ? val.toFixed(decimals) : val;
      return `<span class="${cls}">${label} ${formatted}</span>`;
    }

    // --- Why string for MVP hitter
    function mvpWhy(p) {
      const s = p.s;
      const parts = [];
      const pa  = parseInt(s?.plateAppearances||0);
      const ops = (parseFloat(s?.obp||0) + parseFloat(s?.slg||0));
      const hr  = parseInt(s?.homeRuns||0);
      const rbi = parseInt(s?.rbi||0);
      const sb  = parseInt(s?.stolenBases||0);
      const hrPerPA = pa > 0 ? hr/pa : 0;
      if (ops > 0)  parts.push(chip('OPS', ops, lg.ops, 'hi', 3));
      if (hrPerPA >= lg.hrPA * 0.9) parts.push(chip('HR', hr, lg.hrPA * pa, 'hi', 0));
      if (rbi >= 20) parts.push(chip('RBI', rbi, lg.rbiPA * pa, 'hi', 0));
      // SB reference scales with season progress so early-season leaders aren't penalized.
      // Full-season baseline: ~15 SB = solid. Scaled by PA share vs. full season (~600 PA).
      const sbRef = Math.max(3, 15 * (Math.min(pa, 600) / 600));
      if (sb >= 5)  parts.push(chip('SB', sb, sbRef, 'hi', 0));
      if (!parts.length) parts.push(`<span class="sg">${s?.avg||'—'} AVG</span>`);
      return parts.slice(0,3).join('<span class="sg"> · </span>');
    }

    // --- Why string for Cy Young
    function cyWhy(p) {
      const s = p.s;
      const parts = [];
      const era  = parseFloat(s?.era||99);
      const whip = parseFloat(s?.whip||99);
      const ip   = parseFloat(s?.inningsPitched||0);
      const k    = parseInt(s?.strikeOuts||0);
      const k9   = ip > 0 ? (k/ip)*9 : 0;
      // Always show ERA and WHIP if available
      if (era < 90) parts.push(chip('ERA', era, lg.era, 'lo', 2));
      if (whip < 90) parts.push(chip('WHIP', whip, lg.whip, 'lo', 2));
      // K/9 only if noteworthy (≥ 90% of league avg)
      if (k9 >= lg.k9 * 0.90) parts.push(chip('K/9', k9, lg.k9, 'hi', 1));
      // Fallback: IP workload if nothing else (rare in top 10)
      if (!parts.length) parts.push(chip('IP', ip, maxIP * 0.6, 'hi', 1));
      return parts.slice(0,3).join('<span class="sg"> · </span>');
    }

    // --- MVP score trend (based on recent form vs. season)
    // Uses the same data that powered HOT/STEADY/COLD: recent OPS for hitters
    // (last 10 days, min 10 ABs) and recent ERA for pitchers (last 15 days, min 6 IP).
    // Translates the same thresholds into ↑ / → / ↓ arrows.
    //
    // Why arrows instead of HOT/COLD badges: an MVP-tier player whose OPS drops
    // 70 pts isn't "cold" — they're regressing toward the mean from elite levels.
    // ↓ correctly says "trending down" without the misleading temperature framing.

    // Returns {delta, kind, source} or null if no comparable recent data.
    // kind: 'up' | 'flat' | 'down'
    // source: 'hitting' | 'pitching'
    function getMvpTrend(p, awardType) {
      if (awardType === 'mvp') {
        const recent = mvpHeatHittingCache[p.pid];
        const seasonOps = (parseFloat(p.s?.obp) || 0) + (parseFloat(p.s?.slg) || 0);
        if (recent && recent.ab >= 10 && seasonOps !== 0) {
          const delta = recent.ops - seasonOps;
          let kind;
          if (delta >=  0.080) kind = 'up';
          else if (delta <= -0.060) kind = 'down';
          else kind = 'flat';
          return { delta, kind, source: 'hitting', sampleSize: recent.ab };
        }
        const fallbackOps = recentHittingCache[p.pid];
        if (fallbackOps == null || seasonOps === 0) return null;
        const delta = fallbackOps - seasonOps;
        let kind;
        if (delta >=  0.080) kind = 'up';
        else if (delta <= -0.060) kind = 'down';
        else kind = 'flat';
        return { delta, kind, source: 'hitting', sampleSize: null };
      } else {
        const recent = mvpHeatPitchingCache[p.pid];
        const seasonEra = parseFloat(p.s?.era) || 99;
        if (recent && recent.era && recent.ip >= 6) {
          const delta = seasonEra - recent.era;  // positive = recent ERA better
          let kind;
          if (delta >=  1.00) kind = 'up';
          else if (delta <= -0.80) kind = 'down';
          else kind = 'flat';
          return { delta, kind, source: 'pitching', sampleSize: recent.ip };
        }
        const fallback = recentPitchingCache[p.pid];
        if (!fallback || !fallback.era) return null;
        const delta = seasonEra - fallback.era;
        let kind;
        if (delta >=  1.00) kind = 'up';
        else if (delta <= -0.80) kind = 'down';
        else kind = 'flat';
        return { delta, kind, source: 'pitching', sampleSize: fallback.ip || null };
      }
    }

    function trendArrow(trend, rank) {
      if (!trend) return '→';
      if (trend.kind === 'up')   return '↑';
      // Rank 1: never show down arrow — cap at flat
      if (trend.kind === 'down' && rank === 1) return '→';
      if (trend.kind === 'down') return '↓';
      return '→';
    }
    function trendColor(trend, rank) {
      if (!trend) return 'color:var(--muted);opacity:.4';
      if (trend.kind === 'up')   return 'color:var(--win)';
      // Rank 1: down trend shows as muted (not red) — could lose lead but still #1
      if (trend.kind === 'down' && rank === 1) return 'color:var(--muted)';
      if (trend.kind === 'down') return 'color:var(--loss)';
      return 'color:var(--muted)';
    }
    function trendTitle(trend) {
      if (!trend) return 'Muestra reciente insuficiente';
      if (trend.source === 'hitting') {
        const sign = trend.delta >= 0 ? '+' : '−';
        const abs = Math.abs(trend.delta).toFixed(3).replace(/^0/, '');
        return trend.sampleSize
          ? `OPS last 10 days: ${sign}${abs} vs season (${trend.sampleSize} AB)`
          : `Recent OPS: ${sign}${abs} vs season`;
      } else {
        // For pitching, positive delta means recent ERA is BETTER (lower)
        const sign = trend.delta >= 0 ? '−' : '+';  // flip for ERA narrative
        const abs = Math.abs(trend.delta).toFixed(2);
        return trend.sampleSize
          ? `ERA last 15 days: ${sign}${abs} vs season (${trend.sampleSize} IP)`
          : `Recent ERA: ${sign}${abs} vs season`;
      }
    }

    // --- Build ranked lists
    function buildMVPList(players, scoreFunc, whyFunc, leagueId, forceTWP, limit = 10) {
      const ranked = players
        .filter(p => !leagueId || p.leagueId === leagueId)
        .map(p => ({ ...p, mvpS: scoreFunc(p) }))
        .filter(p => p.mvpS !== null)
        .sort((a,b) => b.mvpS - a.mvpS)
        .slice(0, limit);
      // For MVP and Cy Young: if a TWP (two-way player like Ohtani) exists in this
      // league but didn't make the top 10 by score, force them in — but ONLY if their
      // score is at least 70 (otherwise TWP status alone isn't enough, they're underperforming).
      const TWP_MIN_SCORE = 70;
      if (forceTWP) {
        const twpInLeague = players.find(p =>
          p.leagueId === leagueId &&
          p.pid === 660271 &&        // Ohtani
          !ranked.some(r => r.pid === p.pid)
        );
        if (twpInLeague) {
          const score = scoreFunc(twpInLeague);
          if (score !== null && score >= TWP_MIN_SCORE) {
            ranked.pop();
            ranked.push({ ...twpInLeague, mvpS: score });
            ranked.sort((a,b) => b.mvpS - a.mvpS);
          }
          // If score < 70 or null, do NOT force include — TWP status alone
          // isn't enough; player needs to actually be performing
        }
      }
      return ranked.map((p, i) => ({ ...p, rank: i+1, why: whyFunc(p) }));
    }

    // --- ROY why string (works for both hitters and pitchers)
    function royWhy(p) {
      if (p.isPitcher) return cyWhy(p);
      return mvpWhy(p);
    }

    function trackerPlayerDetailHTML(p, awardType) {
      const isPitcher = awardType === 'cy' || (awardType === 'roy' && p.isPitcher);
      const stats = { ...(p.s || {}) };
      const isRookie = awardType === 'roy' || (() => {
        return isRookieEligible(p.pid, isPitcher ? 'pitcher' : 'hitter');
      })();
      const awardBadge = awardsBadgeHTML(p.pid, awardType === 'roy' ? (isPitcher ? 'cy' : 'mvp') : awardType);
      const seasonDots = seasonDotsHTML(p.pid, isPitcher ? 'pitcher' : 'hitter');
      const trendBadge = !isRookie
        ? (isPitcher
            ? trendFormaHTML(calcPitcherScore(stats), careerStatsCache[p.pid]?.formaScore)
            : trendBadgeHTML((parseFloat(stats.obp) || 0) + (parseFloat(stats.slg) || 0), careerStatsCache[p.pid]?.ops, 'ops'))
        : '';
      const color = getDiamondPlayerColor(isPitcher ? calcPitcherScore(stats) : ((parseFloat(stats.obp) || 0) + (parseFloat(stats.slg) || 0)), isPitcher ? 'pitcher' : 'hitter');
      const statsLine = isPitcher
        ? (() => {
            const qs = parseInt(stats.qualityStarts || 0) || 0;
            return `ERA ${stats.era || '—'} · WHIP ${stats.whip || '—'} · IP ${stats.inningsPitched || '—'}<br>GS ${stats.gamesStarted ?? '—'} · QS ${qs}`;
          })()
        : formatSeasonHitterSummary(stats);
      const barLabel = isPitcher ? 'FORM' : 'OPS';
      const barValue = isPitcher ? Math.max(0, calcPitcherScore(stats)) : (((parseFloat(stats.obp) || 0) + (parseFloat(stats.slg) || 0)).toFixed(3));
      const barWidth = isPitcher
        ? Math.min(100, Math.round(Math.max(0, calcPitcherScore(stats))))
        : Math.min(100, Math.round((((parseFloat(stats.obp) || 0) + (parseFloat(stats.slg) || 0)) / 1.2) * 100));
      const rankSummary = trackerRankSummary(p, isPitcher);
      return `<div class="impact-detail-card">
        <div class="impact-row">
          <div class="impact-row-left">
            <div class="impact-name-block">
              <div class="impact-name">${awardBadge || ''}</div>
              <div class="impact-stats-line">${statsLine}</div>
              ${rankSummary ? `<div class="impact-stats-line" style="margin-top:5px">${rankSummary}</div>` : ''}
            </div>
          </div>
          <div class="impact-bar-block">
            <div class="impact-bar-bg"><div class="impact-bar-fill" style="width:${barWidth}%;background:${color}"></div></div>
          </div>
          <div class="impact-bar-val-wrap">
            <span class="impact-bar-label">${barLabel}</span>
            <span class="impact-bar-val" style="color:${statTextColor(color)}">${barValue}</span>
            ${trendBadge ? `<div style="margin-top:3px;text-align:right">${trendBadge}</div>` : ''}
            ${seasonDots}
          </div>
        </div>
      </div>`;
    }

    // --- Build ROY list for a league
    // Eligibility: career AB < 130 AND career IP < 50 (MLB official thresholds).
    // Players without career stats in cache are assumed eligible (true rookies).
    // Scoring: mvpScore for hitters, cyScore for pitchers, then convert to
    // percentile within the eligible pool so both types compete on equal footing.
    //
    // MLB also strips rookie status after 45 active roster days (IL time excluded).
    // This can't be computed from stats alone, so edge cases are handled via the
    // global NON_ROOKIE_OVERRIDES set.
    // To find a player's PID: open DevTools console after page load and run:
    //   [...document.querySelectorAll('[data-pid]')].find(el=>el.textContent.includes('Sasaki'))
    // or check mlb.com/player/<name> — the numeric ID is in the URL.
    function buildROYList(hitters, pitchers, leagueId) {
      const ROY_MIN_PA = 20;
      const ROY_MIN_IP = 5;

      // Filter eligible hitters
      // TWP exception: a player with career IP > 50 but career AB < 130 can still
      // be eligible as a position player rookie (e.g. McLean pitched last year, bats this year).
      // The MLB rule counts hitting and pitching service separately.
      const royHitters = hitters
        .filter(p => !leagueId || p.leagueId === leagueId)
        .filter(p => !NON_ROOKIE_OVERRIDES.has(p.pid))
        .filter(p => parseInt(p.s?.plateAppearances||0) >= ROY_MIN_PA)
        .filter(p => {
          const c = careerStatsCache[p.pid];
          if (!c || !('careerAB' in c)) return true;
          // Eligible as hitter if career AB < 130, regardless of career IP
          // (pitcher-turned-batter is judged on hitting service time)
          return c.careerAB < ROOKIE_AB_LIMIT;
        })
        .map(p => ({ ...p, mvpS: mvpScore(p), isPitcher: false }))
        .filter(p => p.mvpS !== null);

      // Filter eligible pitchers
      const royPitchers = pitchers
        .filter(p => !leagueId || p.leagueId === leagueId)
        .filter(p => !NON_ROOKIE_OVERRIDES.has(p.pid))
        .filter(p => parseFloat(p.s?.inningsPitched||0) >= ROY_MIN_IP)
        .filter(p => {
          const c = careerStatsCache[p.pid];
          if (!c || !('careerIP' in c)) return true; // no prior data = first MLB year
          return isRookieEligible(p.pid, 'pitcher');
        })
        .map(p => ({ ...p, mvpS: cyScore(p), isPitcher: true }))
        .filter(p => p.mvpS !== null);

      // Normalize over the combined pool so hitters and pitchers compete directly.
      // Both groups use their raw mvpS score scaled to [0,100] relative to the full merged pool.
      const allCandidates = [...royHitters, ...royPitchers];
      if (!allCandidates.length) return [];
      const maxS = Math.max(...allCandidates.map(p => p.mvpS));
      const minS = Math.min(...allCandidates.map(p => p.mvpS));
      const range = maxS - minS || 1;
      const merged = allCandidates
        .map(p => ({ ...p, royPct: 100 * (p.mvpS - minS) / range }))
        .sort((a,b) => b.royPct - a.royPct).slice(0, 5);

      return merged.map((p, i) => ({ ...p, rank: i+1, why: royWhy(p) }));
    }

    // --- Row HTML (shared by MVP, CY, and ROY)
    function rowHTML(p, awardType) {
      const rankCls = p.rank <= 3 ? `rank${p.rank}` : '';
      const photoUrl = siloHeadshot(p.pid);
      const teamLogo = p.teamId && TEAM_META[p.teamId]
        ? `<img src="${TEAM_META[p.teamId].logo}" style="width:13px;height:13px;object-fit:contain;vertical-align:middle;margin-right:2px" onerror="this.style.display='none'">` : '';
      const score = p.mvpS.toFixed(1);
      const isPitcher = awardType === 'cy' || (awardType === 'roy' && p.isPitcher);
      // For ROY: same pill style for both pitchers (P) and hitters (position)
      let posHtml = '';
      if (awardType === 'roy') {
        const posLabel = p.isPitcher ? 'P' : (p.position || '');
        posHtml = posLabel ? `<span class="mvp-pos-pill">${posLabel}</span>` : '';
      } else if (awardType === 'mvp' && p.position) {
        posHtml = `<span class="mvp-pos-pill">${p.position}</span>`;
      }
      // Rookie badge — shown in ROY always, and in MVP/CY if player is ROY-eligible
      function isRoyEligible(pid) {
        return isRookieEligible(pid, isPitcher ? 'pitcher' : 'hitter');
      }
      const rookieBadge = (awardType === 'roy' || isRoyEligible(p.pid))
        ? `<span style="display:inline-block;font-size:8px;font-weight:800;padding:1px 4px;border-radius:3px;background:#b45309;color:#fff;margin-right:3px;letter-spacing:.3px">R</span>`
        : '';
      const awardHtml = awardsBadgeHTML(p.pid, awardType === 'roy' ? (p.isPitcher ? 'cy' : 'mvp') : awardType);
      const trend = getMvpTrend(p, p.isPitcher ? 'cy' : awardType);
      const ilHtml   = ilBadgeHTML(p);
      const nextHtml = ilHtml ? '' : nextGameHTML(p, p.isPitcher ? 'cy' : awardType);
      const detailHtml = trackerPlayerDetailHTML(p, awardType);
      return `<details class="mvp-row-wrap">
        <summary class="mvp-row ${rankCls}">
        <div class="mvp-rank ${p.rank <= 3 ? 'top' : ''}">${p.rank}</div>
        <img class="mvp-photo" src="${photoUrl}" alt="${p.name}" style="background:${teamPhotoBg(p.teamId)}"
          onerror="this.src='${siloHeadshot(0)}'">
        <div class="mvp-info">
          <div class="mvp-name">${rookieBadge}${posHtml}<span class="mvp-name-text">${p.name}</span></div>
          <div class="mvp-meta">
            <span class="mvp-team">${teamLogo}${p.teamAbbr}</span>
            ${awardHtml}
          </div>
          ${ilHtml}
          ${nextHtml}
        </div>
        <div class="mvp-score-block">
          <div class="mvp-score-val">${score}</div>
          <div class="mvp-score-lbl">${awardType === 'roy' ? 'SCORE' : 'SCORE'}</div>
        </div>
        <div class="mvp-trend" style="${trendColor(trend, p.rank)}" title="${trendTitle(trend)}">${trendArrow(trend, p.rank)}</div>
        </summary>
        <div class="mvp-row-detail">${detailHtml}</div>
      </details>`;
    }

    // --- Card HTML
    function cardHTML(title, league, players, awardTypeOverride) {
      const isPitching = /cy young/i.test(title);
      const isROY = /rookie/i.test(title);
      const awardType = awardTypeOverride || (isROY ? 'roy' : isPitching ? 'cy' : 'mvp');
      const emptyMsg = isROY
        ? 'NO ROOKIES WITH ENOUGH DATA YET'
        : 'NOT ENOUGH DATA YET';
      const rows = players.length
        ? players.map(p => rowHTML(p, awardType)).join('')
        : `<div style="padding:24px;color:var(--muted);font-family:'Barlow Condensed';text-align:center;letter-spacing:1px">${emptyMsg}</div>`;
      return `<div class="mvp-tracker-card">
        <div class="mvp-card-header">
          <span class="mvp-card-title">${title} RANKING</span>
        </div>
        <div class="mvp-card-body">${rows}</div>
      </div>`;
    }

    // Build all 4 MVP/CY trackers
    const alMVP  = buildMVPList(rawHitters,  mvpScore, mvpWhy,  103, true, 30);
    const nlMVP  = buildMVPList(rawHitters,  mvpScore, mvpWhy,  104, true, 30);
    const alCY   = buildMVPList(rawPitchers, cyScore,  cyWhy,   103, false, 10);
    const nlCY   = buildMVPList(rawPitchers, cyScore,  cyWhy,   104, false, 10);
    // Save globally so Top Games can reuse without re-fetching
    window._mvpLists = { alMVP, nlMVP, alCY, nlCY, alROY: null, nlROY: null };

    // Fetch career stats for ROY eligibility check.
    const royCandidateHitters  = rawHitters.filter(p => parseInt(p.s?.plateAppearances||0) >= 20);
    const royCandidatePitchers = rawPitchers.filter(p => parseFloat(p.s?.inningsPitched||0) >= 5);
    // Also include pitchers not already in rawHitters — needed so TWP candidates like McLean
    // (debuted as pitcher, batting this year with few IP) can be evaluated for careerAB.
    const twpCandidatePitchers = rawPitchers.filter(p => !rawHitters.some(h => h.pid === p.pid));
    const royCandidatePids = [...new Set([
      ...royCandidateHitters.map(p => p.pid),
      ...royCandidatePitchers.map(p => p.pid),
      ...twpCandidatePitchers.map(p => p.pid),
    ])];
    await fetchCareerStats(royCandidatePids);

    // TWP hitters: some players (like McLean) appear in rawPitchers but are batting
    // this year. Their hitting stats aren't in the general /stats?group=hitting leaderboard.
    // Fetch each one's season hitting stats via the individual stats endpoint.
    const twpPids = rawPitchers
      .filter(p => {
        const c = careerStatsCache[p.pid];
        return c && c.careerAB < 130 && !rawHitters.some(h => h.pid === p.pid);
      })
      .map(p => p.pid);
    if (twpPids.length) {
      await Promise.all(twpPids.map(pid =>
        fetchWithTimeout(
          `${MLB_API}/people?personIds=${pid}&hydrate=stats(type=season,group=hitting,season=${CURRENT_YEAR},gameType=R)`
        ).then(r => r.json()).then(d => {
          const person = (d.people || [])[0];
          if (!person) return;
          // Try hydrate format first (group.displayName present)
          let s = person.stats?.find(g =>
            g.group?.displayName?.toLowerCase() === 'hitting' &&
            g.type?.displayName?.toLowerCase() === 'season'
          )?.splits?.[0]?.stat;
          // Fallback: any hitting group
          if (!s) s = person.stats?.find(g =>
            g.group?.displayName?.toLowerCase() === 'hitting'
          )?.splits?.[0]?.stat;
          // Fallback: first stats entry with plateAppearances
          if (!s) s = person.stats?.[0]?.splits?.[0]?.stat;
          if (s && parseInt(s.plateAppearances||0) >= 20) {
            const existing = rawPitchers.find(p => p.pid === pid);
            if (existing) {
              // Attach leagueId from team if missing
              const entry = { ...existing, s, position: positionMap[pid] || 'DH' };
              if (!entry.leagueId && entry.teamId) entry.leagueId = getTeamLeagueId(entry.teamId);
              rawHitters.push(entry);
            }
          }
        }).catch(() => {})
      ));
    }

    // Build ROY lists (now that career stats are available for eligibility check)
    const alROY = buildROYList(rawHitters, rawPitchers, 103);
    const nlROY = buildROYList(rawHitters, rawPitchers, 104);
    // Update global with ROY lists now available
    if (window._mvpLists) {
      window._mvpLists.alROY = alROY; window._mvpLists.nlROY = nlROY;
      // If Top Games was already rendered with simplified-formula data, reload it now
      if (window._tgNeedsRefresh) { window._tgNeedsRefresh = false; if (window._tgCurrentDay) { delete window._tgDayCache[window._tgCurrentDay]; loadTopGamesDay(window._tgCurrentDay); } }
    }

    // Fetch RECENT-FORM stats for all top-10 players + ROY candidates
    const allHitterPids  = [...new Set([...alMVP, ...nlMVP, ...alROY.filter(p => !p.isPitcher), ...nlROY.filter(p => !p.isPitcher)].map(p => p.pid))];
    const allPitcherPids = [...new Set([...alCY, ...nlCY, ...alROY.filter(p => p.isPitcher), ...nlROY.filter(p => p.isPitcher)].map(p => p.pid))];
    const allTeamIds = [...new Set([...alMVP, ...nlMVP, ...alCY, ...nlCY, ...alROY, ...nlROY].map(p => p.teamId).filter(Boolean))];
    try {
      await Promise.all([
        fetchSeasonHistory([...new Set([...allHitterPids, ...allPitcherPids])]),
        fetchMvpHeatHitting(allHitterPids),
        fetchMvpHeatPitching(allPitcherPids),
        fetchRecentHitting(allHitterPids),
        fetchRecentPitching(allPitcherPids),
        fetchMvpSchedule(),
        fetchMvpIL(allTeamIds),
      ]);
    } catch(e) {}

    // Save to localStorage after all heavy fetches complete (only if we just fetched fresh data)
    if (!cached) {
      saveCache({
        rawHitters,
        rawPitchers,
        positionMap,
        careerStatsCache: { ...careerStatsCache },
        seasonHistoryCache: { ...seasonHistoryCache },
      });
    }

    const now = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
    const today = new Date().toLocaleDateString('en-US', { day:'numeric', month:'short' });

    function renderMVPView(filter) {
      const showMVP = filter === 'all' || filter === 'mvp';
      const showCY  = filter === 'all' || filter === 'cy';
      const showROY = filter === 'all' || filter === 'roy';

      let grid = '';
      if (showMVP) {
        grid += cardHTML('AL MVP', 'AMERICAN LEAGUE', alMVP.slice(0, 10));
        grid += cardHTML('NL MVP', 'NATIONAL LEAGUE', nlMVP.slice(0, 10));
      }
      if (showCY) {
        grid += cardHTML('AL CY YOUNG', 'AMERICAN LEAGUE', alCY);
        grid += cardHTML('NL CY YOUNG', 'NATIONAL LEAGUE', nlCY);
      }
      if (showROY) {
        grid += cardHTML('AL ROOKIE OF THE YEAR', 'AMERICAN LEAGUE', alROY);
        grid += cardHTML('NL ROOKIE OF THE YEAR', 'NATIONAL LEAGUE', nlROY);
      }

      el.innerHTML = `
        <div class="mvp-page-header">
          <div>
            <div class="mvp-page-title">AWARD TRACKING</div>
            <div class="mvp-page-subtitle">REAL-TIME CANDIDATES · ${CURRENT_YEAR} SEASON</div>
          </div>
          <div class="mvp-tabs-row">
            <button class="mvp-tab-btn ${filter==='all'?'active':''}" onclick="setMVPFilter('all')">ALL</button>
            <button class="mvp-tab-btn ${filter==='mvp'?'active':''}" onclick="setMVPFilter('mvp')">MVP</button>
            <button class="mvp-tab-btn ${filter==='cy'?'active':''}" onclick="setMVPFilter('cy')">CY YOUNG</button>
            <button class="mvp-tab-btn ${filter==='roy'?'active':''}" onclick="setMVPFilter('roy')">ROOKIE</button>
          </div>
        </div>
        <div class="mvp-grid">${grid}</div>
        <div class="mvp-last-update">Updated ${today} at ${now} · Scores normalized vs league average · Min. ${minPA} PA / ${minIP} IP</div>`;
    }

    window._renderMVPView = renderMVPView;
    renderMVPView(mvpActiveTracker);

  } catch(e) {
    document.getElementById('mvpContent').innerHTML =
      errorStateHTML('mvpTrackerPromise=null;loadMVPTracker()');
  }
}

function setMVPFilter(f) {
  mvpActiveTracker = f;
  if (window._renderMVPView) window._renderMVPView(f);
}

// Helper: get league ID from team ID (AL=103, NL=104)
function getTeamLeagueId(teamId) {
  const AL = new Set([108,110,111,114,116,117,118,133,136,139,140,141,142,145,147]);
  return AL.has(teamId) ? 103 : 104;
}

// Update disclaimer: show the daily refresh time in the visitor's local timezone.
(function() {
  const el = document.getElementById('update-disclaimer');
  if (!el) return;
  // The refresh fires at 08:00 UTC (summer) / 09:00 UTC (winter) — 10:00 in Amsterdam.
  const refresh = new Date();
  refresh.setUTCHours(isPacificDST(refresh) ? 8 : 9, 0, 0, 0);
  const time = refresh.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.textContent = `Stats update daily by ${time} your time`;
})();

// Map a player id to its diamond key, then open + scroll to that player's card.
// Lets the blog deep-link straight to a player's full roster card (#rosters/{abbr}/{pid}).
function diamondKeyForPid(teamId, pid) {
  const impact = teamsImpactCache[teamId];
  if (!impact) return null;
  for (const pos in impact.hittersByPos) {
    if ((impact.hittersByPos[pos] || []).some(p => p.id === pid)) return `h-${pos}`;
  }
  const groups = { SP: impact.spList, CL: impact.clList, RP: impact.rpList };
  for (const role in groups) {
    const i = (groups[role] || []).findIndex(p => p.id === pid);
    if (i >= 0) return `p-${role}-${i}`;
  }
  return null;
}
function openPlayerInRoster(teamId, pid) {
  const key = diamondKeyForPid(teamId, pid);
  if (!key) return;
  selectDiamondKey(key, teamId);
  setTimeout(() => {
    const el = key.startsWith('h-') ? document.getElementById('hitterDetailCard')
                                    : document.getElementById('detail-' + key);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
}

// On load, jump to the tab specified in the URL hash (e.g. #mvp, #rosters/nyy, #rosters/nyy/12345)
const VALID_TABS = new Set(['standings','topgames','rosters','rankings','mvp','info']);
const [hashTab, hashParam, hashPid] = window.location.hash.replace('#', '').split('/');
const startTab = VALID_TABS.has(hashTab) ? hashTab : 'standings';
if (startTab !== 'standings') switchTab(startTab);
if (startTab === 'rosters' && hashParam) {
  const tid = Object.keys(TEAM_META).find(id => (TEAM_META[id].abbr || '').toLowerCase() === hashParam.toLowerCase());
  if (tid) {
    const p = selectTeam(parseInt(tid));
    if (hashPid && p && typeof p.then === 'function') p.then(() => openPlayerInRoster(parseInt(tid), parseInt(hashPid)));
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refreshSmartCacheExpiry();
  if (isStandingsTabActive()) startStandingsAutoRefresh();
});
refreshSmartCacheExpiry();
init();

// Background prefetch: warm MVP + Top Games while the user browses standings,
// so those tabs render instantly on first click. Skipped if already visited.
setTimeout(() => {
  const prefetchTopGames = () => {
    if (!loaded.topgames) { loaded.topgames = true; try { loadTopGames(); } catch(e) {} }
  };
  if (!loaded.mvp) {
    loaded.mvp = true;
    loadMVPTracker().catch(()=>{}).finally(prefetchTopGames);
  } else {
    prefetchTopGames();
  }
}, 2500);
