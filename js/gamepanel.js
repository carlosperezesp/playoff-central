// The game panel: one engine behind two boards.
//
// dugout.html and the Top Games tab both unfold a game into the same picture —
// linescore, live situation (bases, count, pitch count, strike zone, defense),
// the notebook scorecard, the player box. This file owns that picture and the
// delayed fetch that feeds it, so the two pages can never drift apart.
//
// The delay: the stats feed keeps a timestamped snapshot history per game.
// fetchDelayed() pins every request to the newest snapshot at or before
// now-minus-delay, so the whole panel agrees on what time it is and a board
// sitting next to a slow broadcast spoils nothing.
//
// Exposed as window.GP. Pages own their chrome (rows, day pickers, delay bars);
// this module owns fetching and the panel itself.
(function () {
const API11 = 'https://statsapi.mlb.com/api/v1.1';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pad = n => String(n).padStart(2, '0');
const fj = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
// Finished games ride the shared forever-cache when apicache.js is on the page
const cj = (u, o) => (typeof cachedJSON === 'function' ? cachedJSON(u, o) : fj(u));

// The feed's timecodes are UTC, second precision: YYYYMMDD_HHMMSS. Same format
// everywhere, so "which snapshot is at or before my delayed now" is a plain
// string comparison.
const timecode = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

// ── The index pages' scoring language, copied verbatim so a number here can
// never disagree with the same man's number on his own board ─────────────────
const ERA_BEST = 1.50, ERA_WORST = 6.00, WHIP_BEST = 0.80, WHIP_WORST = 2.00;
function forma(era, whip) {
  const p = [];
  if (era  != null && isFinite(era))  p.push(Math.max(0, Math.min(100, (ERA_WORST  - era)  / (ERA_WORST  - ERA_BEST)  * 100)));
  if (whip != null && isFinite(whip)) p.push(Math.max(0, Math.min(100, (WHIP_WORST - whip) / (WHIP_WORST - WHIP_BEST) * 100)));
  return p.length ? Math.round(p.reduce((a,b)=>a+b,0) / p.length) : null;
}
const TIERS = ['#16a34a','#b1c882','#ffc000','#ff8100','#ff2200'];
const tierForm = f => f == null ? '#9ca3af' : f >= 75 ? TIERS[0] : f >= 60 ? TIERS[1] : f >= 40 ? TIERS[2] : f >= 25 ? TIERS[3] : TIERS[4];
const tscale = (v, c) => (v == null || v <= 0) ? '#9ca3af'
  : v >= c[0] ? TIERS[0] : v >= c[1] ? TIERS[1] : v >= c[2] ? TIERS[2] : v >= c[3] ? TIERS[3] : TIERS[4];
const tierOps = o => tscale(o, [.900, .750, .600, .450]);
const AVG_T = [.300, .255, .205, .160];
const shade = (h,r) => { const n=parseInt(h.slice(1),16),R=Math.round(((n>>16)&255)*(1-r)),G=Math.round(((n>>8)&255)*(1-r)),B=Math.round((n&255)*(1-r));
  return '#'+((1<<24)+(R<<16)+(G<<8)+B).toString(16).slice(1); };
const onTier = c => (c === '#ff8100' || c === '#ff2200' || c === '#9ca3af') ? '#fff' : shade(c,.62);
const face = id => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_180,q_auto:best/v1/people/${id}/headshot/silo/current`;
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const fmt3 = v => v == null ? '—' : v.toFixed(3).replace(/^0/, '');

// ── Field lists: one flat list of names; the API keeps any field whose name
// appears here, at any depth. A folded row only needs the scoreboard... ──────
const F_LITE = 'gamePk,gameData,status,abstractGameState,detailedState,liveData,linescore,'
  + 'currentInning,currentInningOrdinal,inningState,isTopInning,scheduledInnings,innings,num,home,away,'
  + 'runs,hits,errors,teams,balls,strikes,outs,offense,batter,first,second,third,defense,pitcher,'
  + 'id,fullName,plays,currentPlay,result,description,about,isComplete';
// ...an unfolded one adds the boxscore, every finished plate appearance (the
// scorecard), the men on defense, and the pitch count. Same snapshot, more of it.
const F_FULL = F_LITE + ','
  + 'boxscore,players,person,batters,pitchers,battingOrder,position,abbreviation,stats,batting,pitching,'
  + 'atBats,rbi,baseOnBalls,strikeOuts,inningsPitched,earnedRuns,seasonStats,avg,ops,era,whip,numberOfPitches,'
  + 'saves,saveOpportunities,holds,gamesFinished,'
  + 'batSide,pitchHand,'
  + 'catcher,shortstop,left,center,right,'
  + 'allPlays,eventType,halfInning,inning,matchup,runners,credits,credit,code,'
  // ...and each runner's journey, so the scorecard can draw the basepaths: where
  // he ended up, whether he was out on the bases, and the outs count after each play
  + 'movement,end,outBase,isOut,details,runner,count';
// The pitches of the current at-bat, for the zone. Kept out of F_FULL because
// the name playEvents would drag in every pitch of the game under allPlays.
const F_ZONE = 'liveData,plays,currentPlay,playEvents,isPitch,pitchNumber,details,isBall,call,code,'
  + 'pitchData,strikeZoneTop,strikeZoneBottom,coordinates,pX,pZ,startSpeed,type';

// ── The delayed fetch ────────────────────────────────────────────────────────
const FEEDS = new Map();    // `${pk}|${tc}|${tier}` → feed, so nudging the delay repaints from memory
function remember(key, feed) {
  FEEDS.set(key, feed);
  if (FEEDS.size > 240) FEEDS.delete(FEEDS.keys().next().value);  // oldest first: Map keeps insertion order
}

// Snapshot list (tiny), then the feed pinned to the newest snapshot at or
// before now-minus-delay. tier 'lite' is the scoreboard; 'full' adds the box,
// the plays and the pitches of the current at-bat — all on the same timecode.
async function fetchDelayed(pk, { delay = 0, tier = 'lite' } = {}) {
  const stamps = await fj(`${API11}/game/${pk}/feed/live/timestamps`);
  if (!Array.isArray(stamps) || !stamps.length) return { feed: null, pregame: true };
  const target = timecode(new Date(Date.now() - delay * 1000));
  let tc = null;
  for (const s of stamps) { if (s <= target) tc = s; else break; }
  if (!tc) return { feed: null, pregame: true };   // the delayed clock predates the feed's first snapshot

  const key = `${pk}|${tc}|${tier}`;
  let feed = FEEDS.get(key);
  if (!feed) {
    if (tier === 'full') {
      const [main, zone] = await Promise.all([
        fj(`${API11}/game/${pk}/feed/live?timecode=${tc}&fields=${F_FULL}`),
        fj(`${API11}/game/${pk}/feed/live?timecode=${tc}&fields=${F_ZONE}`).catch(() => null),
      ]);
      feed = main;
      feed._zonePlay = zone?.liveData?.plays?.currentPlay || null;
    } else {
      feed = await fj(`${API11}/game/${pk}/feed/live?timecode=${tc}&fields=${F_LITE}`);
    }
    remember(key, feed);
  }
  return { feed, tc, isLast: tc === stamps[stamps.length - 1] };
}

// A game from a finished day is history: no delay to respect, one fetch, cached forever.
function fetchFinal(pk) {
  const key = `${pk}|final|full`;
  const hit = FEEDS.get(key);
  if (hit) return Promise.resolve(hit);
  return cj(`${API11}/game/${pk}/feed/live?fields=${F_FULL}`, { ttl: Infinity })
    .then(feed => { remember(key, feed); return feed; });
}

// ── Panel parts ──────────────────────────────────────────────────────────────
function diamondHTML(off) {
  const on = b => off?.[b] ? 'on' : '';
  return `<svg class="diamond" width="46" height="42" viewBox="0 0 46 42">
    <rect class="${on('second')}" x="17.5" y="2" width="11" height="11" transform="rotate(45 23 7.5)"/>
    <rect class="${on('third')}"  x="4.5"  y="15" width="11" height="11" transform="rotate(45 10 20.5)"/>
    <rect class="${on('first')}"  x="30.5" y="15" width="11" height="11" transform="rotate(45 36 20.5)"/>
  </svg>`;
}

function linesHTML(ls, g) {
  const played = (ls.innings || []).length;
  const n = Math.max(ls.scheduledInnings || 9, played);
  const cur = ls.currentInning;
  const cell = (side, i) => {
    const v = (ls.innings || [])[i]?.[side]?.runs;
    return `<td class="${i + 1 === cur ? 'now' : ''}">${v ?? ''}</td>`;
  };
  const row = side => {
    const t = g.teams[side].team, tot = ls.teams?.[side] || {};
    return `<tr><td>${esc(t.abbreviation || t.teamName)}</td>
      ${Array.from({length:n}, (_, i) => cell(side, i)).join('')}
      <td class="rhe sep-l">${tot.runs ?? 0}</td><td class="rhe">${tot.hits ?? 0}</td><td class="rhe">${tot.errors ?? 0}</td></tr>`;
  };
  return `<div class="lines"><table>
    <thead><tr><th></th>${Array.from({length:n}, (_, i) => `<th>${i+1}</th>`).join('')}
      <th class="rhe sep-l">R</th><th class="rhe">H</th><th class="rhe">E</th></tr></thead>
    <tbody>${row('away')}${row('home')}</tbody>
  </table></div>`;
}

// Pitch count for the man on the mound, read straight out of the same snapshot's box
function pitchCount(feed, pid) {
  for (const side of ['away', 'home']) {
    const st = feed.liveData?.boxscore?.teams?.[side]?.players?.[`ID${pid}`]?.stats?.pitching;
    if (st && st.numberOfPitches != null) return { p: st.numberOfPitches, s: st.strikes };
  }
  return null;
}

// Same thresholds the Bullpen board uses to call a man's job
function penRole(p) {
  const ss = p?.seasonStats?.pitching || {};
  if ((ss.saves ?? 0) >= 5 || ((ss.saveOpportunities ?? 0) >= 5 && (ss.gamesFinished ?? 0) >= 10))
    return '<i class="role">CLOSER</i>';
  if ((ss.holds ?? 0) >= 8) return '<i class="role set">SETUP</i>';
  return '';
}

const boxPlayer = (feed, pid) => {
  for (const s of ['away', 'home']) {
    const p = feed.liveData?.boxscore?.teams?.[s]?.players?.[`ID${pid}`];
    if (p) return p;
  }
  return null;
};

function situHTML(g, feed, ls) {
  const batter = ls.offense?.batter, pitcher = ls.defense?.pitcher;
  const pc = pitcher ? pitchCount(feed, pitcher.id) : null;
  // Season OPS and FORM from the same snapshot's box — the circles the boards use
  const bP = batter ? boxPlayer(feed, batter.id) : null;
  const pP = pitcher ? boxPlayer(feed, pitcher.id) : null;
  const gp = pid => feed.gameData?.players?.[`ID${pid}`];
  const bOps = num(bP?.seasonStats?.batting?.ops);
  const pForm = forma(num(pP?.seasonStats?.pitching?.era), num(pP?.seasonStats?.pitching?.whip));
  const bC = tierOps(bOps), pC = tierForm(pForm);
  const bSide = batter && gp(batter.id)?.batSide?.code, pSide = pitcher && gp(pitcher.id)?.pitchHand?.code;
  const faceHTML = pid => pid ? `<span class="face"><img src="${face(pid)}" alt="" loading="lazy"
    onerror="this.style.visibility='hidden'"></span>` : '';
  return `<div class="situ">
    ${diamondHTML(ls.offense)}
    <div class="count">${ls.balls ?? 0}<i>–</i>${ls.strikes ?? 0} <i>· ${ls.outs ?? 0} OUT</i></div>
    <div class="duel">
      <div class="duel-row"><span class="who">AB</span>
        <span class="fcirc ops" style="background:${bC};color:${onTier(bC)}">${fmt3(bOps)}</span>
        ${faceHTML(batter?.id)}
        <span class="nm">${esc(batter?.fullName || '—')}</span>
        ${bSide ? `<span class="hand ${bSide}">${bSide === 'S' ? 'SWITCH' : bSide + 'HB'}</span>` : ''}</div>
      <div class="duel-row"><span class="who">P</span>
        <span class="fcirc" style="background:${pC};color:${onTier(pC)}">${pForm ?? '—'}</span>
        ${faceHTML(pitcher?.id)}
        <span class="nm">${esc(pitcher?.fullName || '—')}</span>
        ${pSide ? `<span class="hand ${pSide}">${pSide}HP</span>` : ''}${penRole(pP)}
        ${pc ? `<span class="pc">${pc.p} P${pc.s != null ? ` · ${pc.s} S` : ''}</span>` : ''}</div>
    </div>
  </div>`;
}

// ── Strike zone, catcher's view: the pitches of the at-bat on screen ─────────
const pitchColor = ev => {
  const call = ev.details?.call?.code || '';
  return (call === 'X' || call === 'D' || call === 'E') ? 'var(--gold)'
    : ev.details?.isBall ? 'var(--walk)' : 'var(--whiff)';
};

function zoneHTML(feed, ls) {
  const play = feed._zonePlay;
  const pitches = (play?.playEvents || []).filter(ev => ev.isPitch && ev.pitchData?.coordinates?.pX != null);
  const PPF = 26;                                   // pixels per foot
  const W = 112, H = 128, cx = W / 2;
  const py = z => H - 6 - (z - 0.5) * PPF;          // 0.5ft above the bottom edge
  const zx = 0.7083 * PPF;                          // the plate is 17in wide
  const szT = pitches.length ? pitches.reduce((a,p) => a + (p.pitchData.strikeZoneTop || 3.4), 0) / pitches.length : 3.4;
  const szB = pitches.length ? pitches.reduce((a,p) => a + (p.pitchData.strikeZoneBottom || 1.6), 0) / pitches.length : 1.6;
  const dot = ev => {
    const c = ev.pitchData.coordinates;
    const x = Math.max(6, Math.min(W - 6, cx + c.pX * PPF));
    const y = Math.max(6, Math.min(H - 6, py(c.pZ)));
    return `<circle cx="${x}" cy="${y}" r="5.5" fill="${pitchColor(ev)}" opacity=".92"></circle>
      <text x="${x}" y="${y + 2.8}" text-anchor="middle" fill="#0d1a12">${ev.pitchNumber || ''}</text>`;
  };
  // From behind the plate a right-handed batter stands on the catcher's left.
  // A switch hitter takes the side opposite the pitcher's arm.
  let bSide = feed.gameData?.players?.[`ID${ls.offense?.batter?.id}`]?.batSide?.code || '';
  const lab = bSide;
  if (bSide === 'S') bSide = (feed.gameData?.players?.[`ID${ls.defense?.pitcher?.id}`]?.pitchHand?.code === 'L') ? 'R' : 'L';
  const bx = bSide === 'R' ? 12 : W - 12;
  const batter = bSide ? `<g opacity=".5">
      <circle cx="${bx}" cy="${py(szT) - 6}" r="4" fill="#9fb4a6"/>
      <rect x="${bx - 3.5}" y="${py(szT) + 1}" width="7" height="${Math.max(10, py(szB) - py(szT) - 2)}" rx="3.5" fill="#9fb4a6"/>
      <text x="${bx}" y="${H - 10}" text-anchor="middle" fill="#9fb4a6" style="font-size:9px">${lab}</text>
    </g>` : '';
  return `<div class="zonebox">
    <div class="zone-title">This at-bat</div>
    <svg class="zone" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect class="zrect" x="${cx - zx}" y="${py(szT)}" width="${zx * 2}" height="${py(szB) - py(szT)}"/>
      ${batter}
      ${pitches.map(dot).join('')}
    </svg>
    <div class="zone-legend"><span><i style="background:var(--whiff)"></i>Strike</span>
      <span><i style="background:var(--walk)"></i>Ball</span>
      <span><i style="background:var(--gold)"></i>In play</span></div>
  </div>`;
}

// Every pitch of the at-bat, with the radar reading and the pitch type
function pitchLogHTML(feed) {
  const pitches = (feed._zonePlay?.playEvents || []).filter(ev => ev.isPitch);
  if (!pitches.length) return '';
  const rows = pitches.map(ev => `<div class="plrow">
      <i class="pln" style="background:${pitchColor(ev)}">${ev.pitchNumber || ''}</i>
      <b>${ev.pitchData?.startSpeed != null ? ev.pitchData.startSpeed.toFixed(1) : '—'}</b><span>mph</span>
      <em>${esc(ev.details?.type?.code || '')}</em>
    </div>`).join('');
  return `<div class="pitchlog"><div class="zone-title">Pitches</div>${rows}</div>`;
}

// The nine men behind the pitcher, straight from the linescore's defense
const DEF_SLOTS = [['pitcher','P'],['catcher','C'],['first','1B'],['second','2B'],['third','3B'],
  ['shortstop','SS'],['left','LF'],['center','CF'],['right','RF']];
function fieldersHTML(ls) {
  const rows = DEF_SLOTS.map(([k, lab]) => {
    const p = ls.defense?.[k];
    return p?.fullName ? `<div class="frow"><span class="fpos">${lab}</span><span class="fnm">${esc(p.fullName)}</span></div>` : '';
  }).join('');
  return rows ? `<div class="fielders">${rows}</div>` : '';
}

// ── The scorecard: every finished plate appearance in notebook shorthand ─────
function playCredits(play) {
  const out = [];
  (play.runners || []).forEach(r => (r.credits || []).forEach(c => {
    if (c.position?.code) out.push({ p: c.position.code, credit: c.credit || '' });
  }));
  return out;
}

function notation(play) {
  const ev = play.result?.eventType || '', d = play.result?.description || '';
  const cs = playCredits(play);
  const chain = cs.filter(c => c.credit.includes('assist') || c.credit.includes('putout')).map(c => c.p);
  const C = { hit:'var(--hit)', hr:'var(--gold)', walk:'var(--walk)', k:'var(--whiff)',
    err:'var(--err)', out:'var(--ink-dim)' };
  switch (ev) {
    case 'strikeout':        return { t: /called out on strikes/.test(d) ? 'ꓘ' : 'K', c: C.k };
    case 'strikeout_double_play': return { t: 'K-DP', c: C.k };
    case 'walk':             return { t: 'BB', c: C.walk };
    case 'intent_walk':      return { t: 'IBB', c: C.walk };
    case 'hit_by_pitch':     return { t: 'HBP', c: C.walk };
    case 'catcher_interf':   return { t: 'CI', c: C.walk };
    case 'single':           return { t: '1B', c: C.hit };
    case 'double':           return { t: '2B', c: C.hit };
    case 'triple':           return { t: '3B', c: C.hit };
    case 'home_run':         return { t: 'HR', c: C.hr };
    case 'sac_fly':          return { t: 'SF' + (chain[chain.length-1] || ''), c: C.out };
    case 'sac_bunt':         return { t: 'SAC', c: C.out };
    case 'field_error':      { const e = cs.find(c => c.credit.includes('error'));
                               return { t: 'E' + (e?.p || ''), c: C.err }; }
    case 'grounded_into_double_play': return { t: 'DP' + (chain.length ? ' ' + chain.join('-') : ''), c: C.out };
    case 'double_play':      return { t: 'DP', c: C.out };
    case 'triple_play':
    case 'grounded_into_triple_play': return { t: 'TP', c: C.out };
    case 'force_out':        return { t: 'FO' + (chain.length ? ' ' + chain.join('-') : ''), c: C.out };
    case 'fielders_choice':
    case 'fielders_choice_out': return { t: 'FC', c: C.out };
    case 'field_out': {
      if (/grounds out|ground bunts|bunt grounds/.test(d))
        return { t: chain.length > 1 ? chain.join('-') : (chain[0] ? chain[0] + 'U' : 'GO'), c: C.out };
      const pos = chain[chain.length - 1] || '';
      if (/flies out/.test(d))  return { t: 'F' + pos, c: C.out };
      if (/lines out/.test(d))  return { t: 'L' + pos, c: C.out };
      if (/pops out/.test(d))   return { t: 'P' + pos, c: C.out };
      return { t: chain.join('-') || 'OUT', c: C.out };
    }
    default: return null;    // a steal, a pickoff, a wild pitch — runner traffic, not a PA
  }
}

// Runner-only events sneak into allPlays; a scorecard cell is a plate appearance
const NON_PA = /caught_stealing|stolen_base|pickoff|wild_pitch|passed_ball|balk|advance|defensive|ejection|game_advisory|injury|mound_visit|pitching_substitution|offensive_substitution|batter_timeout|no_pitch/;

// Each cell is one plate appearance and the runner's whole life after it, the
// way a notebook keeps it: basepaths drawn as far as he got, a filled diamond
// for a run, a half path and a tick for a man cut down on the bases, and the
// cause of every advance written at the corner it happened on.
const BASE_N = { '1B': 1, '2B': 2, '3B': 3, 'home': 4, 'score': 4 };

function advanceLabel(det, batSlot) {
  const ev = det?.eventType || '';
  if (/stolen_base/.test(ev)) return 'SB';
  if (/wild_pitch/.test(ev)) return 'WP';
  if (/passed_ball/.test(ev)) return 'PB';
  if (/balk/.test(ev)) return 'BLK';
  if (/defensive_indiff/.test(ev)) return 'DI';
  if (/error|pickoff_error/.test(ev)) return 'E';
  return batSlot ? String(batSlot) : '';
}

function outLabel(r) {
  const ev = r.details?.eventType || '';
  const chain = (r.credits || []).map(c => c.position?.code).filter(Boolean).join('-');
  const tag = /caught_stealing/.test(ev) ? 'CS' : /pickoff/.test(ev) ? 'PK' : '';
  return (tag && chain) ? `${tag} ${chain}` : tag || chain;
}

function scorecardData(feed, side) {
  const bx = feed.liveData?.boxscore?.teams?.[side];
  const plays = feed.liveData?.plays?.allPlays;
  if (!bx || !Array.isArray(plays)) return null;
  const P = bx.players || {};
  const half = side === 'away' ? 'top' : 'bottom';
  const slotOf = bid => { const bo = P[`ID${bid}`]?.battingOrder; return bo ? Math.floor(bo / 100) : 0; };

  const cells = {};                    // batterId → [cell, cell, ...] in PA order
  let live = new Map();                // runnerId → the cell still on the bases
  let maxInning = 9, curInning = 0, prevOuts = 0;

  plays.forEach(pl => {
    if (pl.about?.halfInning !== half) return;
    const inn = pl.about.inning || 0;
    if (inn !== curInning) { curInning = inn; prevOuts = 0; live = new Map(); }
    maxInning = Math.max(maxInning, inn);

    const bid = pl.matchup?.batter?.id;
    const ev = pl.result?.eventType || '';
    let bcell = null;
    if (pl.about?.isComplete && bid && !NON_PA.test(ev)) {
      const n = notation(pl);
      if (n) {
        bcell = { inning: inn, n, reached: 0, scored: false, seg: {}, out: null, slash: false };
        // The pitches before the last one, the way a scorer dots them in:
        // a walk's fourth ball and a strikeout's third strike live in the notation
        if (pl.count?.balls != null) bcell.dots = {
          b: Math.max(0, Math.min(3, pl.count.balls - (/walk/.test(ev) ? 1 : 0))),
          s: Math.max(0, Math.min(2, pl.count.strikes - (/strikeout/.test(ev) ? 1 : 0))),
        };
        (cells[bid] = cells[bid] || []).push(bcell);
      }
    }
    const batSlot = slotOf(bid);
    let lastOutCell = null;

    (pl.runners || []).forEach(r => {
      const rid = r.details?.runner?.id;
      if (!rid) return;
      const cell = (bcell && rid === bid) ? bcell : live.get(rid);
      if (!cell) return;
      const mv = r.movement || {};
      if (mv.isOut) {
        live.delete(rid);
        // The batter thrown out at first needs no path — his notation already says it
        if (cell.reached > 0 || rid !== bid) {
          cell.out = { base: BASE_N[mv.outBase] || cell.reached + 1, lab: outLabel(r) };
          lastOutCell = cell;
        }
      } else if (mv.end && BASE_N[mv.end]) {
        const b = BASE_N[mv.end];
        if (b > cell.reached) {
          if (rid !== bid) cell.seg[b] = advanceLabel(r.details, batSlot);
          cell.reached = b;
        }
        if (b === 4) { cell.scored = true; live.delete(rid); }
        else live.set(rid, cell);
      }
    });

    // Third out of the half-inning: the notebook's diagonal stroke, on the cell that made it
    const outsNow = pl.count?.outs;
    if (outsNow === 3 && prevOuts < 3) { const c = lastOutCell || bcell; if (c) c.slash = true; }
    if (outsNow != null) prevOuts = outsNow;
  });

  const order = (bx.batters || []).map(id => P[`ID${id}`]).filter(p => p && p.battingOrder);
  if (!order.length) return null;
  return { cells, order, maxInning };
}

// The little diamond: home at the bottom, first on the right, a notebook cell in SVG
const PA_PTS = { 0: [20, 31], 1: [31, 20], 2: [20, 9], 3: [9, 20] };
const PA_LBL = { 1: [34, 30, 'start'], 2: [34, 12, 'start'], 3: [6, 12, 'end'], 4: [6, 30, 'end'] };
function paSVG(cell) {
  const seg = (a, b, half) => {
    const A = PA_PTS[a % 4], B = PA_PTS[b % 4];
    const x2 = half ? (A[0] + B[0]) / 2 : B[0], y2 = half ? (A[1] + B[1]) / 2 : B[1];
    return `<line class="run" x1="${A[0]}" y1="${A[1]}" x2="${x2}" y2="${y2}"/>`;
  };
  let s = `<polygon class="dia${cell.scored ? ' scored' : ''}" points="20,31 31,20 20,9 9,20"/>`;
  const reached = cell.scored ? 4 : cell.reached;
  for (let b = 1; b <= reached; b++) s += seg(b - 1, b);
  if (cell.out) {
    s += seg(cell.out.base - 1, cell.out.base, true);
    const A = PA_PTS[(cell.out.base - 1) % 4], B = PA_PTS[cell.out.base % 4];
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    const dx = (B[1] - A[1]) / 7, dy = (A[0] - B[0]) / 7;
    s += `<line class="run" x1="${mx - dx}" y1="${my - dy}" x2="${mx + dx}" y2="${my + dy}"/>`;
    const L = PA_LBL[cell.out.base];
    if (cell.out.lab) s += `<text x="${L[0]}" y="${L[1]}" text-anchor="${L[2]}" class="outlab">${esc(cell.out.lab)}</text>`;
  }
  for (const [b, lab] of Object.entries(cell.seg)) {
    if (!lab || (cell.out && +b === cell.out.base)) continue;
    const L = PA_LBL[b];
    s += `<text x="${L[0]}" y="${L[1]}" text-anchor="${L[2]}">${esc(lab)}</text>`;
  }
  if (cell.slash) s += `<line class="slash" x1="32" y1="33" x2="40" y2="41"/>`;
  return `<svg viewBox="0 0 40 41" width="40" height="41">${s}</svg>`;
}

function scorecardHTML(g, feed, side) {
  const data = scorecardData(feed, side);
  if (!data) return '';
  const head = Array.from({length: data.maxInning}, (_, i) => `<th>${i+1}</th>`).join('');
  const rows = data.order.map(p => {
    const bid = p.person?.id, sub = p.battingOrder % 100 !== 0;
    const slot = Math.floor(p.battingOrder / 100);
    const name = esc((p.person?.fullName || '').split(' ').slice(1).join(' ') || p.person?.fullName || '');
    const tds = Array.from({length: data.maxInning}, (_, i) => {
      const list = (data.cells[bid] || []).filter(c => c.inning === i + 1);
      return `<td>${list.map(c => `<div class="pa">${paSVG(c)}<span class="lab" style="color:${c.n.c}">${c.n.t}</span>${
        c.dots && (c.dots.b || c.dots.s) ? `<span class="pdots">${'<i class="db"></i>'.repeat(c.dots.b)}${'<i class="ds"></i>'.repeat(c.dots.s)}</span>` : ''
      }</div>`).join('')}</td>`;
    }).join('');
    return `<tr><td><i class="ord">${sub ? '↳' : slot}</i>${name}</td>${tds}</tr>`;
  }).join('');
  // The notebook's inning totals, straight from the linescore of the same snapshot
  const ls = feed.liveData?.linescore;
  const totRow = (lab, key, cls) => `<tr class="tot ${cls}"><td>${lab}</td>${
    Array.from({length: data.maxInning}, (_, i) =>
      `<td>${ls?.innings?.[i]?.[side]?.[key] ?? ''}</td>`).join('')}</tr>`;
  return `<div class="sc-team">${esc(g.teams[side].team.teamName)}</div>
    <table><thead><tr><th></th>${head}</tr></thead><tbody>${rows}
    ${totRow('R', 'runs', 'totr')}${totRow('H', 'hits', 'toth')}</tbody></table>`;
}

// ── Player boxscore ──────────────────────────────────────────────────────────
function boxTeamHTML(g, feed, side) {
  const bx = feed.liveData?.boxscore?.teams?.[side];
  if (!bx) return '';
  const P = bx.players || {};
  const sums = { ab: 0, r: 0, h: 0, rbi: 0, bb: 0, k: 0 };
  const batRow = id => {
    const p = P[`ID${id}`]; if (!p) return '';
    const st = p.stats?.batting;
    if (!st || st.atBats == null) return '';
    sums.ab += st.atBats; sums.r += st.runs ?? 0; sums.h += st.hits ?? 0;
    sums.rbi += st.rbi ?? 0; sums.bb += st.baseOnBalls ?? 0; sums.k += st.strikeOuts ?? 0;
    const sub = p.battingOrder && p.battingOrder % 100 !== 0;
    return `<tr><td>${sub ? '<i class="subarrow">↳</i> ' : ''}${esc(p.person?.fullName)}
        <i class="pos-tag">${esc(p.position?.abbreviation || '')}</i></td>
      <td>${st.atBats}</td><td>${st.runs ?? 0}</td><td>${st.hits ?? 0}</td><td>${st.rbi ?? 0}</td>
      <td>${st.baseOnBalls ?? 0}</td><td>${st.strikeOuts ?? 0}</td>
      <td style="color:${tscale(num(p.seasonStats?.batting?.avg), AVG_T)};font-weight:800">${esc(p.seasonStats?.batting?.avg ?? '')}</td></tr>`;
  };
  const armRow = id => {
    const p = P[`ID${id}`]; if (!p) return '';
    const st = p.stats?.pitching;
    if (!st || st.inningsPitched == null) return '';
    return `<tr><td>${esc(p.person?.fullName)} ${penRole(p)}</td>
      <td>${esc(st.inningsPitched)}</td><td>${st.hits ?? 0}</td><td>${st.runs ?? 0}</td>
      <td>${st.earnedRuns ?? 0}</td><td>${st.baseOnBalls ?? 0}</td><td>${st.strikeOuts ?? 0}</td>
      <td>${st.numberOfPitches ?? ''}</td>
      <td style="color:${tierForm(forma(num(p.seasonStats?.pitching?.era), null))};font-weight:800">${esc(p.seasonStats?.pitching?.era ?? '')}</td></tr>`;
  };
  const bats = (bx.batters || []).map(batRow).join('');
  const arms = (bx.pitchers || []).map(armRow).join('');
  if (!bats && !arms) return '';
  return `<div class="box">
    <div class="box-team">${esc(g.teams[side].team.teamName)}</div>
    ${bats ? `<table>
      <thead><tr><th></th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>AVG</th></tr></thead>
      <tbody>${bats}<tr class="totrow"><td>Totals</td><td>${sums.ab}</td><td>${sums.r}</td><td>${sums.h}</td>
        <td>${sums.rbi}</td><td>${sums.bb}</td><td>${sums.k}</td><td></td></tr></tbody></table>` : ''}
    ${arms ? `<table>
      <thead><tr><th></th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th><th>P</th><th>ERA</th></tr></thead>
      <tbody>${arms}</tbody></table>` : ''}
  </div>`;
}

const mlinkHTML = g =>
  `<a class="mlink" href="matchup.html?a=${g.teams.home.team.id}&b=${g.teams.away.team.id}">
    Compare rotations, pens &amp; lineups &rarr;</a>`;

// ── The panel ────────────────────────────────────────────────────────────────
// Everything below the fold for a game that has started. Returns null while the
// (possibly delayed) snapshot still says pre-game — the page shows its own
// pregame panel then. Wrap the result in an element carrying class="gp".
function detailHTML(g, feed, tier, opts = {}) {
  const st = feed?.gameData?.status, ls = feed?.liveData?.linescore;
  if (!st || st.abstractGameState === 'Preview' || ls?.currentInning == null) return null;

  const live = st.abstractGameState === 'Live';
  const state = (ls.inningState || '').toUpperCase();
  const between = state === 'MIDDLE' || state === 'END';
  const play = feed.liveData?.plays?.currentPlay;
  const desc = play?.about?.isComplete ? play?.result?.description : null;

  if (tier !== 'full')
    return `${linesHTML(ls, g)}<div class="dload">Loading the full panel…</div>`;

  const situation = live && !between
    ? situHTML(g, feed, ls) + `<div class="zonewrap">${zoneHTML(feed, ls)}${pitchLogHTML(feed)}${fieldersHTML(ls)}</div>`
    : '';
  const scorecard = scorecardHTML(g, feed, 'away') + scorecardHTML(g, feed, 'home');
  return `${linesHTML(ls, g)}
    ${situation}
    ${desc ? `<div class="lastplay"><b>Last play:</b> ${esc(desc)}</div>` : ''}
    <div class="dcols">
      <div class="dcol">
        <div class="dh">Boxscore</div>
        ${boxTeamHTML(g, feed, 'away')}${boxTeamHTML(g, feed, 'home')}
      </div>
      <div class="dcol">
        <div class="dh">Scorecard</div>
        <div class="sc">${scorecard || '<span class="dload">No plate appearances yet</span>'}</div>
      </div>
    </div>
    ${opts.mlink === false ? '' : mlinkHTML(g)}`;
}

window.GP = { detailHTML, fetchDelayed, fetchFinal,
  forma, tierForm, tierOps, onTier, face, num, fmt3, esc, F_LITE, F_FULL };
})();
