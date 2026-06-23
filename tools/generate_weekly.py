#!/usr/bin/env python3
"""Baseball Lens — daily themed article generator ("The Lens").

Reads live MLB stats, computes the facts deterministically in the app's color
language (elite/green … poor/red) — power rankings, team staffs, elite hitters
and pitchers, and week-over-week movers — and writes a static, crawlable HTML
article that speaks the app's visual vocabulary: player headshots ringed in
their tier color, team logos, the shimmer for historic seasons.

Each day publishes a focused EDITION (theme rotates by weekday, override with
--theme). A dated snapshot is saved every run; movers compare against the
snapshot closest to ~7 days back, so risers/fallers/color-changes are meaningful
even on a daily cadence.

Phase 2: Claude writes the prose (headline + intro + each section's lead) around
the computed facts — the lists are code-rendered, so no stat is hallucinated.
Falls back to deterministic templates if tools/.env / the SDK / the call fails.

Usage:  python3 tools/generate_weekly.py [--season YYYY] [--date YYYY-MM-DD] [--theme KEY]
"""

import argparse
import datetime as dt
import json
import os
import re
import urllib.request
from html import escape

API = "https://statsapi.mlb.com/api/v1"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLOG_DIR = os.path.join(ROOT, "blog")
SNAP_DIR = os.path.join(ROOT, "data", "snapshots")
SITE = "https://baseballlens.com"

# ── Color scale (ported from getDiamondPlayerColor / statTextColor in app.js) ─
BRIGHT = {"green": "#16a34a", "lgreen": "#b1c882", "yellow": "#ffc000",
          "orange": "#ff8100", "red": "#ff2200", "gray": "#9ca3af"}
TEXT = {"green": "#16a34a", "lgreen": "#7d9440", "yellow": "#c29200",
        "orange": "#e06f00", "red": "#e51f00", "gray": "#6b7280"}
TIER_LABEL = {"green": "elite", "lgreen": "above avg", "yellow": "average",
              "orange": "below avg", "red": "poor", "gray": "no data"}
TIER_ORDER = {"green": 0, "lgreen": 1, "yellow": 2, "orange": 3, "red": 4, "gray": 5}

# Team primary colors — backdrop for the transparent "silo" headshots, so every
# player circle is filled with its team's color (ported from TEAM_META in app.js).
TEAM_COLOR = {
    108: "#BA0021", 109: "#A71930", 110: "#DF4601", 111: "#BD3039", 112: "#0E3386",
    113: "#C6011F", 114: "#00385D", 115: "#33006F", 116: "#0C2340", 117: "#002D62",
    118: "#004687", 119: "#005A9C", 120: "#AB0003", 121: "#002D72", 133: "#003831",
    134: "#FDB827", 135: "#2F241D", 136: "#0C2C56", 137: "#FD5A1E", 138: "#C41E3A",
    139: "#092C5C", 140: "#003278", 141: "#134A8E", 142: "#002B5C", 143: "#E81828",
    144: "#CE1141", 145: "#27251F", 146: "#00A3E0", 147: "#003087", 158: "#12284B",
}


def _shade(hexc, ratio):                       # ratio 0..1 toward black
    n = int(hexc.lstrip("#"), 16)
    r, g, b = (n >> 16) & 255, (n >> 8) & 255, n & 255
    return "#%02x%02x%02x" % (round(r * (1 - ratio)), round(g * (1 - ratio)), round(b * (1 - ratio)))


def team_photo_bg(team_id):
    """Team-colored gradient backdrop for a player's silo cutout (None if unknown)."""
    c = TEAM_COLOR.get(team_id)
    return f"linear-gradient(145deg,{c} 0%,{_shade(c, 0.45)} 100%)" if c else None


def hitter_tier(ops):
    if not ops or ops <= 0: return "gray"
    if ops >= 0.900: return "green"
    if ops >= 0.750: return "lgreen"
    if ops >= 0.600: return "yellow"
    if ops >= 0.450: return "orange"
    return "red"


def forma_score(era, whip):
    parts = []
    if era is not None:
        parts.append(max(0, min(100, (6.00 - era) / (6.00 - 1.50) * 100)))
    if whip is not None:
        parts.append(max(0, min(100, (2.00 - whip) / (2.00 - 0.80) * 100)))
    return sum(parts) / len(parts) if parts else 0.0


def pitcher_tier(score):
    if score is None or score < 0: return "gray"
    if score >= 75: return "green"
    if score >= 60: return "lgreen"
    if score >= 40: return "yellow"
    if score >= 25: return "orange"
    return "red"


# ── Data ──────────────────────────────────────────────────────────────────
def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "BaseballLens/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def get_teams(season, asof=None):
    datep = f"&date={asof}" if asof else ""
    d = fetch(f"{API}/standings?leagueId=103,104&season={season}"
              f"&standingsTypes=regularSeason{datep}&hydrate=team,division")
    out = []
    for rec in d.get("records", []):
        lg = rec.get("league", {}).get("id")   # 103 AL, 104 NL
        for tr in rec.get("teamRecords", []):
            l10 = next((s for s in tr.get("records", {}).get("splitRecords", [])
                        if s.get("type") == "lastTen"), {})
            wins, losses = tr.get("wins", 0), tr.get("losses", 0)
            out.append({
                "id": tr["team"]["id"], "name": tr["team"]["name"],
                "abbr": tr["team"].get("abbreviation", ""), "lg": lg,
                "wins": wins, "losses": losses,
                "gp": tr.get("gamesPlayed", 0) or (wins + losses),
                "l10": f"{l10.get('wins', 0)}-{l10.get('losses', 0)}",
                "l10w": l10.get("wins", 0), "runDiff": tr.get("runDifferential", 0),
            })
    return out


def compute_power(teams):
    for t in teams:
        gp = t["gp"] or 1
        win_pct = t["wins"] / max(1, t["wins"] + t["losses"])
        l10_pct = t["l10w"] / 10
        rd_norm = max(0.0, min(1.0, (t["runDiff"] / gp + 2.5) / 5.0))
        t["power"] = 0.45 * win_pct + 0.25 * l10_pct + 0.30 * rd_norm
    ranked = sorted(teams, key=lambda t: t["power"], reverse=True)
    for i, t in enumerate(ranked, 1):
        t["rank"] = i
    return ranked


def _league(s):
    return (s.get("team", {}) or {}).get("league", {}).get("id")   # 103 AL, 104 NL


def _stats_url(season, group, sort, limit, pool, asof, start=None):
    if asof:
        span = f"stats=byDateRange&startDate={start or f'{season}-01-01'}&endDate={asof}"
    else:
        span = "stats=season"
    return (f"{API}/stats?{span}&season={season}&sportId=1&group={group}&gameType=R"
            f"&playerPool={pool}&sortStat={sort}&limit={limit}&hydrate=team(league)")


def get_hitters(season, limit=60, pool="qualified", asof=None, start=None, min_ab=120):
    d = fetch(_stats_url(season, "hitting", "onBasePlusSlugging", limit, pool, asof, start))
    out = []
    for s in d.get("stats", [{}])[0].get("splits", []):
        st = s["stat"]
        ops = float(st.get("ops", 0) or 0)
        out.append({"id": s["player"]["id"], "name": s["player"]["fullName"],
                    "team": s.get("team", {}).get("name", ""), "lg": _league(s),
                    "ops": ops, "hr": int(st.get("homeRuns", 0) or 0),
                    "ab": int(st.get("atBats", 0) or 0), "avg": st.get("avg", ".000"),
                    "rbi": int(st.get("rbi", 0) or 0), "sb": int(st.get("stolenBases", 0) or 0),
                    "tier": hitter_tier(ops), "historic": ops >= 1.000})
    if asof and pool == "qualified":   # byDateRange ignores the qualified pool — approximate it
        out = [h for h in out if h["ab"] >= min_ab]
    return out


def get_pitchers(season, limit=40, pool="qualified", asof=None, start=None, min_ip=50):
    d = fetch(_stats_url(season, "pitching", "earnedRunAverage", limit, pool, asof, start))
    out = []
    for s in d.get("stats", [{}])[0].get("splits", []):
        st = s["stat"]
        era, whip = float(st.get("era", 99)), float(st.get("whip", 9))
        forma = forma_score(era, whip)
        out.append({"id": s["player"]["id"], "name": s["player"]["fullName"],
                    "team": s.get("team", {}).get("name", ""), "lg": _league(s),
                    "era": era, "whip": whip, "forma": forma,
                    "ip": float(st.get("inningsPitched", 0) or 0),
                    "gs": int(st.get("gamesStarted", 0) or 0), "w": int(st.get("wins", 0) or 0),
                    "so": int(st.get("strikeOuts", 0) or 0),
                    "tier": pitcher_tier(forma), "historic": era <= 2.00 and whip <= 1.00})
    if asof and pool == "qualified":
        out = [p for p in out if p["ip"] >= min_ip]
    return out


def build_month_facts(season, start, end, label):
    """Protagonists of a finished calendar month (byDateRange that month)."""
    hitters = get_hitters(season, 80, asof=end, start=start, min_ab=40)
    pitchers = get_pitchers(season, 60, asof=end, start=start, min_ip=20)
    return {
        "month_label": label,
        "month_hitters": hitters[:8],
        "month_hr": sorted(hitters, key=lambda h: h["hr"], reverse=True)[:6],
        "month_pitchers": pitchers[:6],
    }


def get_week_hitters(season, start, end, limit=500, min_ab=15):
    """Per-hitter stats over a date window (the last 7 days) — for hot bats & cooling lines."""
    d = fetch(_stats_url(season, "hitting", "onBasePlusSlugging", limit, "all", end, start))
    out = []
    for s in d.get("stats", [{}])[0].get("splits", []):
        st = s["stat"]
        ab = int(st.get("atBats", 0) or 0)
        ops = float(st.get("ops", 0) or 0)
        out.append({"id": s["player"]["id"], "name": s["player"]["fullName"],
                    "team": s.get("team", {}).get("name", ""), "lg": _league(s),
                    "ab": ab, "hits": int(st.get("hits", 0) or 0),
                    "hr": int(st.get("homeRuns", 0) or 0), "sb": int(st.get("stolenBases", 0) or 0),
                    "rbi": int(st.get("rbi", 0) or 0), "g": int(st.get("gamesPlayed", 0) or 0),
                    "avg": st.get("avg", ".000"), "ops": ops,
                    "tier": hitter_tier(ops), "historic": False, "ok": ab >= min_ab})
    return out


def attach_team_meta(players, id_by_name, abbr_by_name):
    for p in players:
        p["team_id"] = id_by_name.get(p["team"])
        p["abbr"] = abbr_by_name.get(p["team"], "")


def get_hitter_season(season, pid, asof=None):
    """One hitter's season line — for hot-week part-timers missing from the qualified map."""
    span = f"stats=byDateRange&startDate={season}-01-01&endDate={asof}" if asof else "stats=season"
    try:
        sp = fetch(f"{API}/people/{pid}/stats?{span}&season={season}&group=hitting"
                   f"&gameType=R").get("stats", [{}])[0].get("splits", [])
        if not sp:
            return None
        st = sp[0]["stat"]
        ops = float(st.get("ops", 0) or 0)
        return {"id": pid, "ops": ops, "hr": int(st.get("homeRuns", 0) or 0),
                "avg": st.get("avg", ".000"), "rbi": int(st.get("rbi", 0) or 0),
                "sb": int(st.get("stolenBases", 0) or 0), "tier": hitter_tier(ops)}
    except Exception:
        return None


def build_gems_facts(season, asof, facts):
    """Best HEALTHY players on the 5 worst teams (by record) in each league."""
    worst = []
    for lg in (103, 104):
        same = [t for t in facts["power_all"] if t.get("lg") == lg]
        same.sort(key=lambda t: t["wins"] / max(1, t["wins"] + t["losses"]))
        worst += same[:5]
    worst_names = {t["name"] for t in worst}
    active = set()   # active rosters exclude IL / injured players
    for t in worst:
        try:
            r = fetch(f"{API}/teams/{t['id']}/roster?rosterType=active"
                      + (f"&date={asof}" if asof else ""))
            active |= {p["person"]["id"] for p in r.get("roster", [])}
        except Exception:
            pass
    pit = get_pitchers(season, 400, asof=asof, min_ip=40)
    hit = get_hitters(season, 400, asof=asof, min_ab=100)
    attach_team_meta(pit, facts["team_id_by_name"], facts["team_abbr"])
    attach_team_meta(hit, facts["team_id_by_name"], facts["team_abbr"])
    keep = lambda p: p["team"] in worst_names and (not active or p["id"] in active)
    return {
        "gem_pitchers": sorted([p for p in pit if keep(p)], key=lambda p: p["forma"], reverse=True)[:5],
        "gem_hitters": sorted([h for h in hit if keep(h)], key=lambda h: h["ops"], reverse=True)[:5],
        "gem_teams": sorted(worst, key=lambda t: (t["lg"], -(t["wins"] - t["losses"]))),
    }


def get_rookies(season, asof=None):
    """Rookie standouts — filter out tiny samples so it's real risers, not 2-PA noise."""
    try:
        hit = [h for h in get_hitters(season, 60, pool="rookies", asof=asof) if h["ab"] >= 70]
        pit = [p for p in get_pitchers(season, 40, pool="rookies", asof=asof) if p["ip"] >= 30]
    except Exception:
        return {"hitters": [], "pitchers": []}
    hit.sort(key=lambda h: h["ops"], reverse=True)
    pit.sort(key=lambda p: p["forma"], reverse=True)
    return {"hitters": hit, "pitchers": pit}


def _team_stat_rows(url, key, lower_better, top):
    try:
        d = fetch(url)
    except Exception:
        return []
    rows = []
    for s in d.get("stats", [{}])[0].get("splits", []):
        t, st = s.get("team") or {}, s.get("stat", {})
        if t and st.get(key) is not None:
            rows.append({"id": t.get("id"), "name": t.get("name", ""),
                         "val": float(st[key]), "whip": float(st.get("whip", 0) or 0)})
    rows.sort(key=lambda r: r["val"], reverse=not lower_better)
    return rows[:top]


def _team_span(season, asof):
    return (f"stats=byDateRange&startDate={season}-01-01&endDate={asof}" if asof else "stats=season")


def get_team_pitching(season, top=5, asof=None):
    rows = _team_stat_rows(f"{API}/teams/stats?{_team_span(season, asof)}&group=pitching"
                           f"&season={season}&sportId=1&gameType=R", "era", True, top)
    for r in rows:
        r["tier"] = pitcher_tier(forma_score(r["val"], r["whip"]))
    return rows


def get_team_bullpen(season, top=5, asof=None):
    # Reliever split isn't available point-in-time; skip on past dates.
    if asof:
        return []
    rows = _team_stat_rows(f"{API}/teams/stats?stats=statSplits&sitCodes=rp&group=pitching"
                           f"&season={season}&sportId=1&gameType=R", "era", True, top)
    for r in rows:
        r["tier"] = pitcher_tier(forma_score(r["val"], r["whip"]))
    return rows


def _ip(v):
    try: return float(v)
    except Exception: return 0.0


def get_team_arms(season, team_id, asof=None):
    """A team's pitchers split into starters and relievers, each ranked by FORM.
    One call per team. Min-workload filters keep small-sample flukes out."""
    span = (f"stats=byDateRange&startDate={season}-01-01&endDate={asof}" if asof
            else "stats=season")
    url = (f"{API}/stats?{span}&season={season}&sportId=1&group=pitching"
           f"&gameType=R&teamId={team_id}&playerPool=all&limit=200")
    try:
        d = fetch(url)
    except Exception:
        return {"all": [], "rp": []}
    arms = []
    for s in d.get("stats", [{}])[0].get("splits", []):
        st = s.get("stat", {})
        era, whip = float(st.get("era", 99) or 99), float(st.get("whip", 9) or 9)
        gs = int(st.get("gamesStarted", 0) or 0)
        g = int(st.get("gamesPitched", 0) or 0)
        ip = _ip(st.get("inningsPitched", 0))
        sv = int(st.get("saves", 0) or 0)
        is_sp = gs >= 3 and ip >= 20
        is_rp = gs <= 2 and g >= 10 and ip >= 10
        if not (is_sp or is_rp):
            continue
        forma = forma_score(era, whip)
        role = "Starter" if is_sp else ("Closer" if sv >= 8 else "Reliever")
        arms.append({"id": s["player"]["id"], "name": s["player"]["fullName"],
                     "era": era, "whip": whip, "forma": forma, "tier": pitcher_tier(forma),
                     "role": role, "team_id": team_id})
    arms.sort(key=lambda r: r["forma"], reverse=True)
    pen = [a for a in arms if a["role"] != "Starter"]
    return {"all": arms[:5], "rp": pen[:5]}


def get_team_offense(season, top=5, asof=None):
    rows = _team_stat_rows(f"{API}/teams/stats?{_team_span(season, asof)}&group=hitting"
                           f"&season={season}&sportId=1&gameType=R", "ops", False, top)
    for r in rows:
        r["tier"] = hitter_tier(r["val"])
    return rows


# ── Movers (week-over-week, vs the snapshot closest to ~7 days back) ─────────
def load_baseline(date_iso, gap=7):
    if not os.path.isdir(SNAP_DIR):
        return None
    files = [f for f in os.listdir(SNAP_DIR) if f.endswith(".json") and f[:-5] < date_iso]
    if not files:
        return None
    target = dt.date.fromisoformat(date_iso) - dt.timedelta(days=gap)
    best = min(files, key=lambda f: abs((dt.date.fromisoformat(f[:-5]) - target).days))
    with open(os.path.join(SNAP_DIR, best)) as fh:
        return json.load(fh)


def compute_movers(f, base):
    if not base:
        return {}
    bh = {x["name"]: x for x in base.get("hitters", [])}
    bp = {x["name"]: x for x in base.get("pitchers", [])}
    hr, cool, form, colors = [], [], [], []
    for h in f["hitters_all"]:
        b = bh.get(h["name"])
        if not b:
            continue
        if h["hr"] - b.get("hr", h["hr"]) >= 2:
            hr.append({"p": h, "base": b, "d": h["hr"] - b["hr"]})
        if h["ops"] - b.get("ops", h["ops"]) <= -0.020:
            cool.append({"p": h, "base": b, "d": h["ops"] - b["ops"]})
        bt = hitter_tier(b.get("ops", h["ops"]))
        if (bt != h["tier"] and "gray" not in (bt, h["tier"])
                and abs(h["ops"] - b.get("ops", h["ops"])) >= 0.015):   # real move, not boundary flicker
            colors.append({"p": h, "old": bt, "stat": "OPS", "from": b.get("ops"), "to": h["ops"]})
    pform = []
    for p in f["pitchers_all"]:
        b = bp.get(p["name"])
        if not b:
            continue
        d = p["forma"] - b.get("forma", p["forma"])
        if d >= 4:
            form.append({"p": p, "base": b, "d": d})
        if d <= -4 and p["forma"] >= 55:   # strong arms (still good) that slipped the most
            pform.append({"p": p, "base": b, "d": d})
        bt = pitcher_tier(b.get("forma", p["forma"]))
        if bt != p["tier"] and "gray" not in (bt, p["tier"]) and abs(d) >= 4:   # real move
            colors.append({"p": p, "old": bt, "stat": "form", "from": b.get("forma"), "to": p["forma"]})
    # Rookie surge — first-year hitters making the biggest week-over-week OPS jump.
    brk = {x["name"]: x for x in base.get("rookies", [])}
    surge = []
    for h in f.get("rookies", {}).get("hitters", []):
        b = brk.get(h["name"])
        if b and h["ops"] - b.get("ops", h["ops"]) >= 0.030:
            surge.append({"p": h, "base": b, "d": h["ops"] - b["ops"]})
    surge.sort(key=lambda x: x["d"], reverse=True)

    hr.sort(key=lambda x: x["d"], reverse=True)
    form.sort(key=lambda x: x["d"], reverse=True)
    pform.sort(key=lambda x: x["d"])   # most form lost first
    cool.sort(key=lambda x: x["d"])
    colors.sort(key=lambda c: abs(TIER_ORDER[c["old"]] - TIER_ORDER[c["p"]["tier"]]), reverse=True)
    featured = {x["p"]["id"] for x in hr[:5] + form[:5] + pform[:3] + cool[:5] + surge[:5]}
    colors = [c for c in colors if c["p"]["id"] not in featured]   # don't repeat a player across sections
    return {"hr": hr[:5], "form": form[:5], "pform": pform[:3], "cool": cool[:5],
            "colors": colors[:6], "rookie_surge": surge[:5], "baseline_date": base.get("date")}


def attach_hr_games(hr_movers, season, since_date, asof, abbr):
    """For each HR climber, pull the recent game log so we can say where the HRs came from."""
    for m in hr_movers:
        m["games"] = []
        try:
            gl = fetch(f"{API}/people/{m['p']['id']}/stats?stats=gameLog&season={season}"
                       f"&group=hitting&gameType=R")
            for s in gl.get("stats", [{}])[0].get("splits", []):
                day = s.get("date", "")
                if day <= since_date or (asof and day > asof):
                    continue
                hr = int(s["stat"].get("homeRuns", 0) or 0)
                if hr > 0:
                    opp = s.get("opponent", {}).get("name", "")
                    m["games"].append({"date": day, "opp": abbr.get(opp, opp), "hr": hr})
        except Exception:
            pass


# ── HTML pieces ─────────────────────────────────────────────────────────────
def logo_url(team_id):
    return f"https://www.mlbstatic.com/team-logos/{team_id}.svg"


def headshot(pid):
    return (f"https://img.mlbstatic.com/mlb-photos/image/upload/"
            f"d_people:generic:headshot:silo:current.png/w_213,q_auto:best/"
            f"v1/people/{pid}/headshot/silo/current")


def face(pid, tier, historic=False, team_id=None):
    cls = "bl-face-wrap shiny" if historic else "bl-face-wrap"
    bg = team_photo_bg(team_id)
    bgstyle = f' style="background:{bg}"' if bg else ""
    return (f'<span class="{cls}" style="--ring:{BRIGHT[tier]}">'
            f'<img class="bl-face" loading="lazy" alt="" src="{headshot(pid)}"{bgstyle} '
            f'onerror="this.onerror=null;this.src=\'{headshot(0)}\'"></span>')


def chip(tier, label):
    return f'<span class="bl-chip" style="color:{TEXT[tier]};background:{TEXT[tier]}1a">{escape(label)}</span>'


def tier_dot(t):
    return (f'<span class="bl-dot" style="background:{BRIGHT[t]}"></span>{TIER_LABEL[t]}')


def movement_badge(m):
    if m is None:
        return '<span class="bl-mv bl-mv-new">NEW</span>'
    if m > 0:
        return f'<span class="bl-mv" style="color:{TEXT["green"]}">&#9650;{m}</span>'
    if m < 0:
        return f'<span class="bl-mv" style="color:{TEXT["red"]}">&#9660;{abs(m)}</span>'
    return '<span class="bl-mv bl-muted">&ndash;</span>'


def power_row(t, show_mv):
    rd = t["runDiff"]
    mv = movement_badge(t.get("movement")) if show_mv else ""
    driver = f'{t["wins"]}-{t["losses"]} · {"+" if rd >= 0 else ""}{rd} run diff · L10 {escape(t["l10"])}'
    return (f'<li class="bl-rankrow"><span class="bl-rank">{t["rank"]}</span>{mv}'
            f'<img class="bl-team-logo" src="{logo_url(t["id"])}" alt="" loading="lazy">'
            f'<span class="bl-team-info"><strong>{escape(t["name"])}</strong>'
            f'<span class="bl-muted">{driver}</span></span></li>')


def team_stat_row(i, r, value, unit, sub):
    return (f'<li class="bl-rankrow"><span class="bl-rank">{i}</span>'
            f'<img class="bl-team-logo" src="{logo_url(r["id"])}" alt="" loading="lazy">'
            f'<span class="bl-team-info"><strong>{escape(r["name"])}</strong>'
            f'<span class="bl-muted">{sub}</span></span>'
            f'<span class="bl-stat" style="color:{TEXT[r["tier"]]}">{value}<small>{unit}</small></span></li>')


def _rface(p):
    bg = team_photo_bg(p.get("team_id"))
    style = f' style="background:{bg}"' if bg else ""
    return (f'<img class="bl-rface" loading="lazy" alt="" src="{headshot(p["id"])}"{style} '
            f'onerror="this.onerror=null;this.src=\'{headshot(0)}\'">')


def _arms_card(roster, header):
    """Expanding roster under a pitching team row: arms ranked by FORM, with role,
    photo and FORM/ERA/WHIP."""
    head = (f'<div class="bl-rrow bl-rhead"><span></span><span class="bl-rname">{header}</span>'
            f'<span>FORM</span><span>ERA</span><span>WHIP</span></div>')
    rows = "".join(
        f'<div class="bl-rrow">{_rface(p)}'
        f'<span class="bl-rname"><strong>{escape(p["name"])}</strong>'
        f'<span class="bl-role">{p["role"]}</span></span>'
        f'<span class="bl-rstat" style="color:{TEXT[p["tier"]]}">{p["forma"]:.0f}</span>'
        f'<span class="bl-rstat" style="color:{TEXT[pitcher_tier(forma_score(p["era"], None))]}">{p["era"]:.2f}</span>'
        f'<span class="bl-rstat" style="color:{TEXT[pitcher_tier(forma_score(None, p["whip"]))]}">{p["whip"]:.2f}</span></div>'
        for p in roster)
    return f'<div class="bl-card" hidden><div class="bl-roster">{head}{rows}</div></div>'


def pitch_team_row(i, r, roster, sub, header):
    """Staff/bullpen row: ERA and WHIP as two equal stats; expands to its top arms."""
    era_t = pitcher_tier(forma_score(r["val"], None))
    whip_t = pitcher_tier(forma_score(None, r["whip"]))
    head = (f'<span class="bl-rank">{i}</span>'
            f'<img class="bl-team-logo" src="{logo_url(r["id"])}" alt="" loading="lazy">'
            f'<span class="bl-team-info"><strong>{escape(r["name"])}</strong>'
            f'<span class="bl-muted">{sub}</span></span>'
            f'<span class="bl-stat" style="color:{TEXT[era_t]}">{r["val"]:.2f}<small>ERA</small></span>'
            f'<span class="bl-stat" style="color:{TEXT[whip_t]}">{r["whip"]:.2f}<small>WHIP</small></span>')
    if not roster:
        return f'<li class="bl-pwrap"><div class="bl-rankrow">{head}</div></li>'
    return (f'<li class="bl-pwrap"><div class="bl-rankrow bl-clickable" onclick="blToggleCard(this)">'
            f'{head}<span class="bl-chev">&rsaquo;</span></div>{_arms_card(roster, header)}</li>')


def rookie_row(p, kind):
    if kind == "hit":
        stat = f'<span class="bl-stat" style="color:{TEXT[p["tier"]]}">{p["ops"]:.3f}<small>OPS</small></span>'
    else:
        stat = f'<span class="bl-stat" style="color:{TEXT[p["tier"]]}">{p["era"]:.2f}<small>ERA</small></span>'
    return _player_row(p, stat, ' <span class="bl-shimmer-tag" style="color:#b45309">rookie</span>')


def _logo_sm(p):
    return (f'<img class="bl-prow-logo" src="{logo_url(p["team_id"])}" alt="" loading="lazy">'
            if p.get("team_id") else "")


def _arrow_stat(label, old, new, tier_fn, prec):
    """old→new (delta) with each number in its own tier color, label/arrow in gray.
    The delta number takes the colour of the second value."""
    g = TEXT["gray"]
    oc, nc = TEXT[tier_fn(old)], TEXT[tier_fn(new)]
    return ('<span class="bl-delta">'
            f'<span style="color:{g}">{label}</span> '
            f'<span style="color:{oc}">{old:.{prec}f}</span>'
            f'<span style="color:{g}">&rarr;</span>'
            f'<span style="color:{nc}">{new:.{prec}f}</span> '
            f'<span style="color:{nc}">({new - old:+.{prec}f})</span></span>')


def _meter(label, value, pct, tier):
    pct = max(4, min(100, pct))
    return (f'<div class="bl-meter"><div class="bl-meter-top"><span class="bl-meter-label">{label}</span>'
            f'<span class="bl-meter-val" style="color:{TEXT[tier]}">{value}</span></div>'
            f'<div class="bl-meter-bar"><span style="width:{pct:.0f}%;background:{BRIGHT[tier]}"></span></div>'
            f'<div class="bl-meter-tier" style="color:{TEXT[tier]}">{TIER_LABEL[tier]}</div></div>')


def player_card(season, week=None):
    """Essential inline card (photo + season line + form/OPS meter) — expands on click,
    right inside the article. No navigation, no extra API calls."""
    if not season:
        return ""
    tier = season["tier"]
    if "era" in season:   # pitcher
        l1 = f'ERA {season["era"]:.2f} · WHIP {season["whip"]:.2f} · IP {season["ip"]:g}'
        l2 = f'GS {season.get("gs", 0)} · {season.get("w", 0)} W · {season.get("so", 0)} K'
        meter = _meter("FORM", f'{season["forma"]:.0f}', season["forma"], tier)
    else:                 # hitter
        l1 = f'AVG {season.get("avg", ".000")} · HR {season["hr"]} · OPS {season["ops"]:.3f}'
        l2 = f'{season.get("rbi", 0)} RBI · {season.get("sb", 0)} SB'
        meter = _meter("OPS", f'{season["ops"]:.3f}', season["ops"] / 1.2 * 100, tier)
    wk = f'<div class="bl-card-week">This week: {_week_line(week)}</div>' if week else ""
    tint = BRIGHT[tier]   # card follows the player's tier color
    bg = team_photo_bg(season.get("team_id"))
    facebg = f' style="background:{bg}"' if bg else ""
    return (f'<div class="bl-card" hidden style="background:{tint}1a;border-color:{tint}59">'
            f'<div class="bl-card-body">'
            f'<img class="bl-card-face" loading="lazy" alt="" src="{headshot(season["id"])}"{facebg} '
            f'onerror="this.onerror=null;this.src=\'{headshot(0)}\'">'
            f'<div class="bl-card-main"><div class="bl-card-stats">{l1}</div>'
            f'<div class="bl-card-stats2">{l2}</div>{wk}</div>{meter}</div></div>')


def _pwrap(inner, card):
    """A player row + its hidden inline card; clickable only when there's a card to open."""
    if not card:
        return f'<li class="bl-pwrap"><div class="bl-player">{inner}</div></li>'
    return (f'<li class="bl-pwrap"><div class="bl-player bl-clickable" onclick="blToggleCard(this)">'
            f'{inner}<span class="bl-chev">&rsaquo;</span></div>{card}</li>')


def _player_row(p, stat_html, extra="", card=None):
    info = (f'<span class="bl-player-info"><strong>{escape(p["name"])}</strong>'
            f'<span class="bl-muted">{_logo_sm(p)}{escape(p["team"])}</span></span>')
    inner = f'{face(p["id"], p["tier"], p.get("historic"), p.get("team_id"))}{info}{stat_html}{extra}'
    return _pwrap(inner, player_card(p) if card is None else card)


def hitter_row(h):
    stat = f'<span class="bl-stat" style="color:{TEXT[h["tier"]]}">{h["ops"]:.3f}<small>OPS</small></span>'
    star = ' <span class="bl-shimmer-tag">historic</span>' if h["historic"] else ""
    return _player_row(h, stat + chip(h["tier"], TIER_LABEL[h["tier"]]), star)


def pitcher_row(p):
    stat = f'<span class="bl-stat" style="color:{TEXT[p["tier"]]}">{p["era"]:.2f}<small>ERA</small></span>'
    star = ' <span class="bl-shimmer-tag">historic</span>' if p["historic"] else ""
    return _player_row(p, stat + chip(p["tier"], TIER_LABEL[p["tier"]]), star)


def hr_row(m):
    h, d = m["p"], m["d"]
    games = m.get("games") or []
    sub = " · ".join(f'{g["hr"]} vs {escape(g["opp"])}' for g in games) if games else f'{h["hr"]} HR total'
    info = (f'<span class="bl-player-info"><strong>{escape(h["name"])}</strong>'
            f'<span class="bl-muted">{_logo_sm(h)}{sub}</span></span>')
    inner = (f'{face(h["id"], h["tier"], h.get("historic"), h.get("team_id"))}{info}'
             f'<span class="bl-delta" style="color:{TEXT["green"]}">+{d} HR</span>')
    return _pwrap(inner, player_card(h))


def form_row(m):
    p, b = m["p"], m["base"]
    crossed = (' <span class="bl-shimmer-tag" style="color:#16a34a">now elite</span>'
               if p["tier"] == "green" and pitcher_tier(b["forma"]) != "green" else "")
    delta = _arrow_stat("form", b["forma"], p["forma"], pitcher_tier, 0)
    return _player_row(p, delta, crossed)


def _week_line(h):
    parts = [f'{h["g"]} G', f'{h["hits"]}-for-{h["ab"]}']
    if h["hr"]:
        parts.append(f'{h["hr"]} HR')
    if h["sb"]:
        parts.append(f'{h["sb"]} SB')
    if h.get("rbi"):
        parts.append(f'{h["rbi"]} RBI')
    return " · ".join(parts)


def cool_row(m, wk=None):
    h, b = m["p"], m["base"]
    if wk:   # show the bad week's line, week OPS in its tier colour
        sub = _week_line(wk)
        right = (f'<span class="bl-delta"><span style="color:{TEXT["gray"]}">{wk["avg"]}</span> · '
                 f'<span style="color:{TEXT[hitter_tier(wk["ops"])]}">{wk["ops"]:.3f}</span>'
                 f'<span style="color:{TEXT["gray"]}"> OPS this week</span></span>')
    else:
        sub = escape(h["team"])
        right = _arrow_stat("OPS", b["ops"], h["ops"], hitter_tier, 3)
    info = (f'<span class="bl-player-info"><strong>{escape(h["name"])}</strong>'
            f'<span class="bl-muted">{_logo_sm(h)}{sub}</span></span>')
    inner = f'{face(h["id"], h["tier"], h.get("historic"), h.get("team_id"))}{info}{right}'
    return _pwrap(inner, player_card(h, week=wk))


def color_row(c):
    p, old = c["p"], c["old"]
    g = TEXT["gray"]
    if c.get("from") is not None and c.get("to") is not None:   # the stat that justifies the move
        if c.get("stat") == "form":
            label, prec, tf = "form", 0, pitcher_tier
        else:
            label, prec, tf = "OPS", 3, hitter_tier
        oc, nc = TEXT[tf(c["from"])], TEXT[tf(c["to"])]
        nums = (f'<span style="color:{oc}">{c["from"]:.{prec}f}</span>'
                f'<span style="color:{g}">&rarr;</span>'
                f'<span style="color:{nc}">{c["to"]:.{prec}f}</span>')
        why = f'<br><span class="bl-why"><span style="color:{g}">{label}</span> {nums}</span>'
    else:
        why = ""
    delta = f'<span class="bl-delta">{tier_dot(old)} &rarr; {tier_dot(p["tier"])}{why}</span>'
    return _player_row(p, delta)


def rookie_surge_row(m):
    h, b, d = m["p"], m["base"], m["d"]
    delta = (f'<span class="bl-delta" style="color:{TEXT["green"]}">'
             f'OPS {b["ops"]:.3f}&rarr;{h["ops"]:.3f} (+{d:.3f})</span>')
    return _player_row(h, delta, ' <span class="bl-shimmer-tag" style="color:#b45309">rookie</span>')


def hweek_row(h, season=None):   # best hitters of the week — show their 7-day game line
    info = (f'<span class="bl-player-info"><strong>{escape(h["name"])}</strong>'
            f'<span class="bl-muted">{_logo_sm(h)}{_week_line(h)}</span></span>')
    inner = (f'{face(h["id"], h["tier"], False, h.get("team_id"))}{info}'
             f'<span class="bl-stat" style="color:{TEXT[h["tier"]]}">{h["ops"]:.3f}<small>OPS&middot;WK</small></span>')
    return _pwrap(inner, player_card(season, week=h))


def pfaller_row(m):   # strong arm losing form
    p, b = m["p"], m["base"]
    info = (f'<span class="bl-player-info"><strong>{escape(p["name"])}</strong>'
            f'<span class="bl-muted">{_logo_sm(p)}{escape(p["team"])}</span></span>')
    inner = f'{face(p["id"], p["tier"], False, p.get("team_id"))}{info}{_arrow_stat("form", b["forma"], p["forma"], pitcher_tier, 0)}'
    return _pwrap(inner, player_card(p))


# ── Sections (each returns full HTML or "" if empty) ────────────────────────
# Each recurring section carries a FIXED canonical one-line gloss (so a term is
# defined the same way every edition, never cold). The LLM 'lead' is colour on
# top — optional, and must not re-define terms (the gloss already did).
def _lead(n, key):
    return f'<p>{escape(n[key])}</p>' if n and n.get(key) else ""


def _section(heading, gloss, lead, rows):
    if not rows:
        return ""
    g = f'<p class="bl-gloss">{gloss}</p>' if gloss else ""
    return f'<h2>{heading}</h2>{g}{lead}<ul class="bl-list">{rows}</ul>'


def sec_power(f, n, limit=10):
    rows = "".join(power_row(t, f["has_movement"]) for t in f["power_top"][:limit])
    g = "Power ranking — record, run differential and last-10 form, blended into one order."
    return _section("Power Rankings", g, _lead(n, "power_lead"), rows)


def sec_staffs(f, n, limit=5):
    rows = "".join(pitch_team_row(i, r, r.get("roster"), "Top arms by form", "Pitcher")
                   for i, r in enumerate(f["staffs"][:limit], 1))
    g = "Team ERA — the whole staff, starters and bullpen. Lower is better."
    return _section("Best staffs on the mound", g, _lead(n, "staff_lead"), rows)


def sec_bullpen(f, n, limit=5):
    rows = "".join(pitch_team_row(i, r, r.get("roster"), "Top relievers by form", "Reliever")
                   for i, r in enumerate(f.get("bullpen", [])[:limit], 1))
    # header label stays "Reliever"; per-row roles distinguish closers
    g = "Bullpen ERA — relievers only. Lower is better."
    return _section("Best bullpens", g, _lead(n, "bullpen_lead"), rows)


def sec_offense(f, n, limit=5):
    rows = "".join(team_stat_row(i, r, f'{r["val"]:.3f}', "OPS", "team OPS")
                   for i, r in enumerate(f.get("offense", [])[:limit], 1))
    g = "Team OPS — on-base plus slugging. Higher is better."
    return _section("Best offenses", g, _lead(n, "offense_lead"), rows)


def sec_rookies(f, n):
    rk = f.get("rookies", {})
    rows = "".join(rookie_row(h, "hit") for h in rk.get("hitters", [])[:5])
    rows += "".join(rookie_row(p, "pit") for p in rk.get("pitchers", [])[:3])
    g = "Top first-year players, hitters by OPS (minimum real playing time)."
    return _section("The rookie class", g, _lead(n, "rookies_lead"), rows)


def sec_rookie_surge(f, n, limit=5):
    rows = "".join(rookie_surge_row(m) for m in f["movers"].get("rookie_surge", [])[:limit])
    g = "Rookies with the biggest OPS jump this week."
    return _section("Rookies breaking out", g, _lead(n, "rookie_surge_lead"), rows)


def _by_league(items):
    return [x for x in items if x.get("lg") == 103], [x for x in items if x.get("lg") == 104]


def _race(heading, gloss, lead, items, row_fn, each=3):
    al, nl = _by_league(items)

    def block(label, lst):
        return (f'<div class="bl-subhead">{label}</div><ul class="bl-list">'
                + "".join(row_fn(x) for x in lst[:each]) + '</ul>') if lst else ""
    body = block("American League", al) + block("National League", nl)
    g = f'<p class="bl-gloss">{gloss}</p>' if gloss else ""
    return f'<h2>{heading}</h2>{g}{lead}{body}' if body else ""


def sec_mvp(f, n):
    g = "Best hitters by OPS, in each league."
    return _race("MVP watch", g, _lead(n, "mvp_lead"), f["hitters_all"], hitter_row)


def sec_cy(f, n):
    g = "Best starters by form — our 0–100 pitching score from ERA &amp; WHIP — in each league."
    by_form = sorted(f["pitchers_all"], key=lambda p: p["forma"], reverse=True)  # match the "by form" gloss
    return _race("Cy Young watch", g, _lead(n, "cy_lead"), by_form, pitcher_row)


def sec_roy(f, n):
    g = "Top first-year hitters by OPS, in each league."
    return _race("Rookie of the Year watch", g, _lead(n, "roy_lead"),
                 f.get("rookies", {}).get("hitters", []), lambda h: rookie_row(h, "hit"))


def sec_bats(f, n, limit=8):
    rows = "".join(hitter_row(h) for h in f["elite_hitters"][:limit])
    g = "Hitters at .900+ OPS — elite (green). A shimmer means a historic pace (1.000+)."
    return _section("Swinging a green bat", g, _lead(n, "hitters_lead"), rows)


def sec_arms(f, n, limit=6):
    rows = "".join(pitcher_row(p) for p in f["aces"][:limit])
    g = ("Top arms by form — our 0–100 pitching score from ERA &amp; WHIP. "
         "A shimmer means a historic pace (sub-2.00 ERA, sub-1.00 WHIP).")
    return _section("Green on the mound", g, _lead(n, "pitchers_lead"), rows)


def sec_hr(f, n, limit=5):
    rows = "".join(hr_row(m) for m in f["movers"].get("hr", [])[:limit])
    g = "Most home runs added this week."
    return _section("Climbing the home-run ladder", g, _lead(n, "hr_lead"), rows)


def sec_risers(f, n, limit=5):
    rows = "".join(form_row(m) for m in f["movers"].get("form", [])[:limit])
    g = "Pitchers whose form — our 0–100 score from ERA &amp; WHIP — climbed most this week."
    return _section("Turning it around", g, _lead(n, "risers_lead"), rows)


def sec_pfallers(f, n, limit=3):
    rows = "".join(pfaller_row(m) for m in f["movers"].get("pform", [])[:limit])
    g = "Of the strongest arms, the ones who shed the most form this week."
    return _section("Cooling on the mound", g, _lead(n, "pfallers_lead"), rows)


def sec_hweek(f, n, limit=5):
    hb = f.get("hit_by_id", {})
    rows = "".join(hweek_row(h, hb.get(h["id"])) for h in f.get("week_hot", [])[:limit])
    g = "The week's hottest hitters — top OPS over the last 7 days (min at-bats), with their game line."
    return _section("Hot at the plate", g, _lead(n, "hweek_lead"), rows)


def sec_fallers(f, n, limit=5):
    wk = f.get("week_by_id", {})
    rows = "".join(cool_row(m, wk.get(m["p"]["id"])) for m in f["movers"].get("cool", [])[:limit])
    g = "Hitters whose bat cooled most this week — shown with their 7-day line."
    return _section("Cooling off", g, _lead(n, "fallers_lead"), rows)


def sec_colors(f, n, limit=6):
    rows = "".join(color_row(c) for c in f["movers"].get("colors", [])[:limit])
    g = "Players who moved up or down a tier on our scale this week."
    return _section("Changing colors", g, _lead(n, "colors_lead"), rows)


# ── Monthly "Best of [month]" sections ──────────────────────────────────────
def hr_total_row(h):
    stat = f'<span class="bl-stat" style="color:{TEXT["green"]}">{h["hr"]}<small>HR</small></span>'
    return _player_row(h, stat)


def sec_month_hitters(f, n, limit=8):
    lbl = f.get("month_label", "The month")
    rows = "".join(hitter_row(h) for h in f.get("month_hitters", [])[:limit])
    return _section(f"{lbl} at the plate", f"{lbl}'s best hitters, by OPS for the month.",
                    _lead(n, "month_hitters_lead"), rows)


def sec_month_hr(f, n, limit=6):
    lbl = f.get("month_label", "the month")
    rows = "".join(hr_total_row(h) for h in f.get("month_hr", [])[:limit])
    return _section("Home runs of the month", f"Most home runs hit in {lbl}.",
                    _lead(n, "month_hr_lead"), rows)


def sec_month_pitchers(f, n, limit=6):
    lbl = f.get("month_label", "The month")
    rows = "".join(pitcher_row(p) for p in f.get("month_pitchers", [])[:limit])
    return _section(f"{lbl} on the mound", f"{lbl}'s best starters, by ERA for the month.",
                    _lead(n, "month_pitchers_lead"), rows)


def sec_gem_pitchers(f, n, limit=5):
    rows = "".join(pitcher_row(p) for p in f.get("gem_pitchers", [])[:limit])
    g = ("The best arms (by form) on the five worst teams in each league — healthy, stuck on "
         "losing clubs. Tap a name for where they shine.")
    return _section("Aces going to waste", g, _lead(n, "gem_pitchers_lead"), rows)


def sec_gem_hitters(f, n, limit=5):
    rows = "".join(hitter_row(h) for h in f.get("gem_hitters", [])[:limit])
    g = "The best bats (by OPS) on those same teams."
    return _section("Bats stuck on bad teams", g, _lead(n, "gem_hitters_lead"), rows)


SECTIONS = {"power": sec_power, "staffs": sec_staffs, "bullpen": sec_bullpen, "offense": sec_offense,
            "bats": sec_bats, "arms": sec_arms, "hr": sec_hr, "risers": sec_risers,
            "fallers": sec_fallers, "colors": sec_colors, "rookies": sec_rookies,
            "rookie_surge": sec_rookie_surge, "mvp": sec_mvp, "cy": sec_cy, "roy": sec_roy,
            "pfallers": sec_pfallers, "hweek": sec_hweek,
            "gem_pitchers": sec_gem_pitchers, "gem_hitters": sec_gem_hitters,
            "month_hitters": sec_month_hitters, "month_hr": sec_month_hr,
            "month_pitchers": sec_month_pitchers}
TEAMSTAT_SECTIONS = {"bullpen", "offense"}

# Weekday (0=Mon) → (edition title, [section ids])
THEME_CALENDAR = {
    0: ("Power Rankings", ["power"]),
    1: ("Pitching Report", ["staffs", "bullpen", "arms", "risers"]),
    2: ("Hitting Report", ["offense", "bats", "hr"]),
    3: ("Award Races", ["mvp", "cy", "roy"]),
    4: ("Risers & Fallers", ["risers", "pfallers", "hweek", "fallers", "colors"]),
    5: ("Rookie Report", ["rookies", "rookie_surge"]),
    6: ("Around the League", ["power", "offense", "staffs"]),
}
THEME_BY_KEY = {  # --theme override
    "power": ("Power Rankings", ["power"]),
    "pitching": ("Pitching Report", ["staffs", "bullpen", "arms", "risers"]),
    "hitting": ("Hitting Report", ["offense", "bats", "hr"]),
    "races": ("Award Races", ["mvp", "cy", "roy"]),
    "rookies": ("Rookie Report", ["rookies", "rookie_surge"]),
    "movers": ("Risers & Fallers", ["risers", "pfallers", "hweek", "fallers", "colors"]),
    "league": ("Around the League", ["power", "offense", "staffs"]),
    "gems": ("Hidden Gems on the League's Worst Teams", ["gem_pitchers", "gem_hitters"]),
}
# One-off themed editions that override the weekday rotation on a specific date.
SPECIAL_EDITIONS = {
    "2026-06-19": ("Hidden Gems on the League's Worst Teams", ["gem_pitchers", "gem_hitters"]),
}
FALLBACK_SECTIONS = ["power", "bats", "arms"]   # if a theme's sections are all empty

# Deterministic one-line standfirst per edition — a newcomer is oriented BEFORE the
# LLM intro runs, so it never matters if the model opens its intro in jargon.
EDITION_DEK = {
    "Power Rankings": "Our team power ranking — record, run differential and recent form in one order.",
    "Pitching Report": "The best staffs and arms in the game right now, by team ERA and our form score.",
    "Hitting Report": "The league's hottest offenses and hitters, by OPS and home runs.",
    "Award Races": "Where the MVP, Cy Young and Rookie of the Year races stand right now.",
    "Risers & Fallers": "Who climbed and who cooled over the past week.",
    "Rookie Report": "The first-year players worth watching.",
    "Around the League": "A quick lap of the standings, offenses and pitching staffs.",
    "Hidden Gems on the League's Worst Teams": "Good, healthy players having strong seasons on teams going nowhere.",
}


def pick_theme(date_iso, override):
    if override and override in THEME_BY_KEY:
        return THEME_BY_KEY[override]
    return THEME_CALENDAR[dt.date.fromisoformat(date_iso).weekday()]


def render_article(section_ids, f, n):
    parts = []
    if n and n.get("intro"):
        parts.append(f'<p class="bl-intro">{escape(n["intro"])}</p>')
    built = [SECTIONS[sid](f, n) for sid in section_ids if sid in SECTIONS]
    built = [b for b in built if b]
    if not built:   # theme's sections were all empty (e.g. movers with no baseline yet)
        built = [b for b in (SECTIONS[s](f, n) for s in FALLBACK_SECTIONS) if b]
    return "\n".join(parts + built)


# ── Phase 2: LLM writes the prose around the computed facts ─────────────────
LLM_SYSTEM = (
    "You write THE LENS, the daily MLB column for Baseball Lens (a site that turns the season into "
    "color: green = elite, red = struggling).\n\n"
    "WHO IT'S FOR: this is coffee-machine talk, not deep analysis. Short, plain, fun to read in 30 "
    "seconds. The reader is a fan, not an analyst. Keep it simple.\n\n"
    "YOUR COMPASS — the questions a fan actually asks:\n"
    "- Who are the best players right now, and are they over- or under-performing lately?\n"
    "- Who have been the best of the season so far?\n"
    "- Who are the best young players — future stars, or just a good year?\n"
    "- Which teams are good or bad, and why (lots of green players, or lots of red)?\n\n"
    "VOICE: plain, exact American English; a little dry wit; confident but never hype; no clichés, "
    "no emoji. Be fair to those struggling, never cruel.\n\n"
    "HARD RULES:\n"
    "1. Use ONLY the names and numbers in the data — never invent, re-round or estimate. Never "
    "contradict the lists: they are PRE-SORTED, so the first name in a list is the leader. Don't "
    "claim a different leader or a number the list doesn't show. Only name players who appear in a "
    "section shown today (sections_today) — never reference one that isn't on the page.\n"
    "2. Color words (green, yellow, red, 'elite', 'above average') are TIERS — fixed levels, never "
    "directions. When something improves or declines, say it rose/fell or name the tiers it moved "
    "between (e.g. 'from elite to above-average'). Never call a player 'red' unless the data says red.\n"
    "3. 'Form' is a PITCHING number only (0–100 from ERA & WHIP). For hitters talk OPS, AVG and home "
    "runs — never 'form'.\n"
    "4. Don't open in jargon. The first sentence orients a newcomer plainly; never start a piece with "
    "a proprietary term (form, elite green, recolored) before it's clear. A fixed one-line definition "
    "already sits under each section heading — do NOT redefine terms in your leads; add the human angle.\n"
    "5. Be specific about WHICH ranking you mean (the power ranking vs. the team-ERA ranking, etc.). "
    "Never write a bare 'the rankings'.\n"
    "6. Ignore noise. A change under ~.015 OPS, a fraction of an ERA, or a one-spot wiggle is NOT a "
    "story — never dramatize it. 'Down three-thousandths of OPS' is never worth a sentence.\n"
    "7. BE WEEK-AWARE but honest: season totals are given alongside each featured player's value a "
    "week ago (ops_a_week_ago, form_a_week_ago, hr_a_week_ago) and a movers section. Frame the week's "
    "real change; a 1.000 OPS that was 1.100 is a cold week, not a hot streak.\n"
    "8. READ THE GAMES. When a player has a 'where' breakdown (HRs by opponent/date), use it ('two "
    "in a weekend at Kansas City'), not just '+3 homers'.\n"
    "9. DON'T REPEAT YOURSELF across editions. You're given recent_headlines and avoid_reusing_lines "
    "(recent intros and leads). Don't echo their angle, phrasing or imagery; never reuse a player's "
    "signature line (e.g. a WHIP that 'looks like a typo'); and never flip a framing you used days ago. "
    "Find a fresh picture.\n"
    "10. HOUSE STYLE for numbers and names in prose: write run differential as 'plus-142' / 'minus-16'; "
    "name teams exactly as the data does (e.g. 'Athletics', not 'Oakland'); write last-10 as '7-3 over "
    "their last ten'. Never reformat or re-round a number the lists already show.\n\n"
    "FORMAT: 'title' = a punchy 6–10 word headline, true to today's theme and fresh vs the recent "
    "headlines. 'intro' = 2–3 short sentences on the day's one real storyline. Each section 'lead' "
    "(only for sections_today) = 1–2 sentences of color — name a standout, don't restate the whole "
    "list, don't redefine terms. Return ONLY raw JSON (no markdown) with string keys from: title, "
    "intro, power_lead, staff_lead, bullpen_lead, offense_lead, hitters_lead, pitchers_lead, hr_lead, "
    "risers_lead, pfallers_lead, hweek_lead, fallers_lead, colors_lead, rookies_lead, rookie_surge_lead, mvp_lead, cy_lead, "
    "roy_lead, month_hitters_lead, month_hr_lead, month_pitchers_lead, gem_pitchers_lead, "
    "gem_hitters_lead — include title, intro, and a lead for each section in sections_today.\n"
    "If edition_theme starts with 'Best of', this is a once-a-month wrap of the FINISHED month "
    "(data in month_recap): the intro looks back at who owned that month, and the leads recap, not "
    "preview. No week-over-week framing here.\n"
    "If hidden_gems is present, the angle is good, healthy players stuck on losing teams (the 5 worst "
    "by record in each league): the intro frames that, and the pitcher lead notes WHERE each arm shines "
    "(low ERA, strikeouts, etc.) from the data. Don't mock the teams; it's about the players."
)


def load_env():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def facts_for_llm(f, theme_title, section_ids):
    m = f.get("movers", {})

    def wk(v):   # round a week-ago value or None
        return round(v, 3) if isinstance(v, (int, float)) else None
    payload = {
        "edition_theme": theme_title,
        "sections_today": section_ids,
        "recent_headlines": f.get("recent_headlines", []),
        "avoid_reusing_lines": f.get("recent_prose", []),
        "week_window": {"from": f.get("baseline_date"), "to": f.get("asof") or dt.date.today().isoformat()},
        "power_rankings_top": [{"rank": t["rank"], "name": t["name"],
                                "record": f'{t["wins"]}-{t["losses"]}', "run_diff": t["runDiff"],
                                "last10": t["l10"], "rank_change_vs_last_week": t.get("movement")}
                               for t in f["power_top"]],
        "best_staffs_by_team_era": [{"rank": i, "name": s["name"], "era": s["val"], "whip": s["whip"]}
                                    for i, s in enumerate(f["staffs"], 1)],
        "elite_hitters": [{"name": h["name"], "team": h["team"], "ops": round(h["ops"], 3),
                           "ops_a_week_ago": wk(h.get("ops_prev")), "hr": h["hr"],
                           "hr_a_week_ago": h.get("hr_prev"), "historic_pace": h["historic"]}
                          for h in f["elite_hitters"]],
        "elite_pitchers": [{"name": p["name"], "team": p["team"], "era": p["era"], "whip": p["whip"],
                            "form_now": round(p["forma"]),
                            "form_a_week_ago": (round(p["forma_prev"]) if p.get("forma_prev") is not None else None),
                            "historic_pace": p["historic"]} for p in f["aces"]],
    }
    if f.get("bullpen"):
        payload["best_bullpens_reliever_era"] = [{"rank": i, "name": r["name"], "era": r["val"]}
                                                 for i, r in enumerate(f["bullpen"], 1)]
    if f.get("offense"):
        payload["best_offenses_team_ops"] = [{"rank": i, "name": r["name"], "ops": round(r["val"], 3)}
                                             for i, r in enumerate(f["offense"], 1)]
    rk = f.get("rookies", {})
    if rk.get("hitters") or rk.get("pitchers"):
        payload["rookie_standouts"] = {
            "hitters": [{"name": h["name"], "team": h["team"], "ops": round(h["ops"], 3), "hr": h["hr"]}
                        for h in rk.get("hitters", [])[:6]],
            # rookie pitchers only render in the Rookie Report — don't dangle them in the ROY race
            "pitchers": ([{"name": p["name"], "team": p["team"], "era": p["era"]}
                          for p in rk.get("pitchers", [])[:4]] if "rookies" in section_ids else []),
        }
    if m:
        payload["movers_vs_last_week"] = {
            "hr_climbers": [{"name": x["p"]["name"], "hr_now": x["p"]["hr"], "hr_gained": x["d"],
                             "where": [f'{g["hr"]} vs {g["opp"]} ({g["date"]})' for g in x.get("games", [])]}
                            for x in m.get("hr", [])],
            "form_risers": [{"name": x["p"]["name"], "form_now": round(x["p"]["forma"]), "form_gained": round(x["d"])} for x in m.get("form", [])],
            "strong_arms_losing_form": [{"name": x["p"]["name"], "form_now": round(x["p"]["forma"]), "form_lost": round(x["d"])} for x in m.get("pform", [])],
            "cooling_bats": [{"name": x["p"]["name"], "week_line": _week_line(f["week_by_id"][x["p"]["id"]]) if x["p"]["id"] in f.get("week_by_id", {}) else None, "ops_drop_season": round(x["d"], 3)} for x in m.get("cool", [])],
            "color_changes": [{"name": c["p"]["name"], "from": TIER_LABEL[c["old"]], "to": TIER_LABEL[c["p"]["tier"]]} for c in m.get("colors", [])],
            "rookie_breakouts": [{"name": x["p"]["name"], "team": x["p"]["team"],
                                  "ops_now": round(x["p"]["ops"], 3), "ops_gained": round(x["d"], 3)}
                                 for x in m.get("rookie_surge", [])],
        }
    if f.get("week_hot"):
        payload["hot_hitters_this_week"] = [{"name": h["name"], "team": h["team"],
                                             "line": _week_line(h), "ops_week": round(h["ops"], 3)}
                                            for h in f["week_hot"]]
    if f.get("month_hitters"):
        payload["month_recap"] = {
            "month": f.get("month_label"),
            "top_hitters": [{"name": h["name"], "team": h["team"], "ops": round(h["ops"], 3),
                             "hr": h["hr"]} for h in f["month_hitters"]],
            "hr_leaders": [{"name": h["name"], "hr": h["hr"]} for h in f["month_hr"]],
            "top_pitchers": [{"name": p["name"], "team": p["team"], "era": p["era"]}
                             for p in f["month_pitchers"]],
        }
    if f.get("gem_pitchers") or f.get("gem_hitters"):
        payload["hidden_gems"] = {
            "premise": "best healthy players on the 5 worst teams (by record) in each league",
            "worst_teams": [f'{t["name"]} ({t["wins"]}-{t["losses"]})' for t in f.get("gem_teams", [])],
            "top_pitchers": [{"name": p["name"], "team": p["team"], "era": p["era"], "whip": p["whip"],
                              "form": round(p["forma"]), "gs": p.get("gs"), "wins": p.get("w"),
                              "strikeouts": p.get("so")} for p in f.get("gem_pitchers", [])],
            "top_hitters": [{"name": h["name"], "team": h["team"], "ops": round(h["ops"], 3),
                             "avg": h.get("avg"), "hr": h["hr"], "rbi": h.get("rbi"),
                             "sb": h.get("sb")} for h in f.get("gem_hitters", [])],
        }
    return json.dumps(payload, indent=2)


def llm_narration(f, theme_title, section_ids):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model="claude-opus-4-8", max_tokens=1800, system=LLM_SYSTEM,
            messages=[{"role": "user", "content":
                       "Write today's edition from these facts:\n\n" + facts_for_llm(f, theme_title, section_ids)}],
        )
        text = next(b.text for b in resp.content if b.type == "text")
        return json.loads(text[text.find("{"): text.rfind("}") + 1])
    except Exception as e:
        print(f"  LLM narration unavailable ({e}); using template prose")
        return None


def build_facts(season, baseline, asof=None, need_teamstats=False):
    teams = get_teams(season, asof)
    ranked = compute_power(teams)
    prev_rank = {r["name"]: r["rank"] for r in baseline.get("power_ranking", [])} if baseline else {}
    for t in ranked:
        t["movement"] = (prev_rank[t["name"]] - t["rank"]) if t["name"] in prev_rank else None
    hitters = get_hitters(season, 200, asof=asof)
    pitchers = get_pitchers(season, 120, asof=asof)
    id_by_name = {t["name"]: t["id"] for t in teams}
    abbr_by_name = {t["name"]: t.get("abbr", "") for t in teams}
    rookies = get_rookies(season, asof=asof)   # always — also feeds the snapshot baseline
    for lst in (hitters, pitchers, rookies["hitters"], rookies["pitchers"]):
        attach_team_meta(lst, id_by_name, abbr_by_name)
    bh = {x["name"]: x for x in baseline.get("hitters", [])} if baseline else {}
    bp = {x["name"]: x for x in baseline.get("pitchers", [])} if baseline else {}
    for h in hitters:                       # attach week-ago values for trend-aware prose
        b = bh.get(h["name"]); h["ops_prev"] = b["ops"] if b else None; h["hr_prev"] = b["hr"] if b else None
    for p in pitchers:
        b = bp.get(p["name"]); p["forma_prev"] = b["forma"] if b else None
    f = {
        "power_all": ranked, "power_top": ranked[:10], "has_movement": bool(prev_rank),
        "team_abbr": abbr_by_name, "team_id_by_name": id_by_name,
        "hit_by_id": {h["id"]: h for h in hitters}, "pit_by_id": {p["id"]: p for p in pitchers},
        "baseline_date": baseline.get("date") if baseline else None, "asof": asof,
        "staffs": get_team_pitching(season, 5, asof=asof),
        "hitters_all": hitters, "pitchers_all": pitchers,
        "elite_hitters": [h for h in hitters if h["tier"] == "green"][:8],
        "aces": sorted([p for p in pitchers if p["tier"] == "green"],
                       key=lambda p: p["forma"], reverse=True)[:6],   # by form, to match the gloss
        "rookies": rookies,
        "bullpen": [], "offense": [],
    }
    if need_teamstats:
        f["bullpen"] = get_team_bullpen(season, 5, asof=asof)
        f["offense"] = get_team_offense(season, 5, asof=asof)

    arms_cache = {}
    def _arms(tid):
        if tid not in arms_cache:
            arms_cache[tid] = get_team_arms(season, tid, asof=asof)
        return arms_cache[tid]
    for r in f["staffs"][:5]:                       # best arms overall, expands under each staff
        r["roster"] = _arms(r["id"])["all"]
    for r in f["bullpen"][:5]:                      # relievers, expands under each bullpen
        r["roster"] = _arms(r["id"])["rp"]
    return f


def article_jsonld(title, date_iso, canonical, desc, image=None):
    post = {
        "@type": "BlogPosting",
        "headline": title, "datePublished": date_iso, "dateModified": date_iso,
        "description": desc, "url": canonical, "mainEntityOfPage": canonical,
        "image": image or f"{SITE}/og-image.png",
        "author": {"@type": "Organization", "name": "Baseball Lens", "url": f"{SITE}/"},
        "publisher": {"@type": "Organization", "name": "Baseball Lens",
                      "logo": {"@type": "ImageObject", "url": f"{SITE}/icon.png"}},
        "isPartOf": {"@type": "Blog", "name": "The Lens", "url": f"{SITE}/blog/"},
    }
    crumbs = {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Baseball Lens", "item": f"{SITE}/"},
            {"@type": "ListItem", "position": 2, "name": "The Lens", "item": f"{SITE}/blog/"},
            {"@type": "ListItem", "position": 3, "name": title, "item": canonical},
        ],
    }
    data = {"@context": "https://schema.org", "@graph": [post, crumbs]}
    return ('<script type="application/ld+json">'
            + json.dumps(data, ensure_ascii=False).replace("</", "<\\/") + "</script>")


STYLE = """
  body { background: var(--bg); }
  .bl-wrap { max-width: 720px; margin: 0 auto; padding: 0 20px 60px; }
  .bl-top { display:flex; align-items:center; gap:10px; padding:18px 0; }
  .bl-top a { display:flex; align-items:center; gap:10px; text-decoration:none; color:var(--text); }
  .bl-top img { width:34px; height:34px; }
  .bl-wordmark { font-family:'Bebas Neue'; font-size:22px; letter-spacing:2px; }
  .bl-wordmark span { color: var(--accent); }
  .bl-article { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:30px 28px; }
  .bl-kicker { font-family:'Barlow Condensed','Inter',sans-serif; font-weight:700; font-size:12px; letter-spacing:2px; text-transform:uppercase; color:var(--accent-blue); margin-bottom:6px; }
  .bl-article h1 { font-family:'Barlow Condensed','Inter',sans-serif; font-size:34px; line-height:1.05; letter-spacing:.5px; margin-bottom:8px; }
  .bl-date { color:var(--muted); font-size:13px; font-weight:600; letter-spacing:.5px; text-transform:uppercase; margin-bottom:22px; }
  .bl-article h2 { font-family:'Barlow Condensed','Inter',sans-serif; font-size:18px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:var(--accent); margin:30px 0 8px; }
  .bl-article p { font-size:15px; line-height:1.6; margin-bottom:6px; }
  .bl-intro { font-size:16px; color:var(--muted); margin-bottom:18px; }
  .bl-gloss { font-size:12.5px; color:var(--muted); margin:0 0 8px; }
  .bl-dek { font-size:14.5px; color:var(--muted); margin:-4px 0 18px; line-height:1.5; }
  .bl-list { list-style:none; display:flex; flex-direction:column; gap:12px; margin:14px 0; }
  .bl-muted { color:var(--muted); font-weight:500; }

  .bl-rankrow { display:flex; align-items:center; gap:10px; }
  .bl-rank { font-family:'Barlow Condensed','Inter',sans-serif; font-weight:800; font-size:19px; width:22px; text-align:center; flex-shrink:0; }
  .bl-mv { font-family:'Barlow Condensed','Inter',sans-serif; font-weight:800; font-size:13px; width:30px; text-align:center; flex-shrink:0; }
  .bl-mv-new { color:var(--accent-blue); font-size:10px; }
  .bl-team-logo { width:30px; height:30px; object-fit:contain; flex-shrink:0; }
  .bl-team-info { display:flex; flex-direction:column; line-height:1.25; flex:1; min-width:0; }
  .bl-team-info strong { font-size:14.5px; }
  .bl-team-info .bl-muted { font-size:12.5px; }
  .bl-subhead { font-family:'Barlow Condensed','Inter',sans-serif; font-weight:700; font-size:11px; letter-spacing:1.2px; text-transform:uppercase; color:var(--muted); margin:14px 0 2px; }

  .bl-player { display:flex; align-items:center; gap:12px; }
  .bl-pwrap { list-style:none; }
  .bl-clickable { cursor:pointer; }
  .bl-clickable:hover .bl-team-info strong { color:var(--accent-blue); }
  .bl-roster { padding:4px 14px 10px; }
  .bl-rrow { display:grid; grid-template-columns:32px 1fr 42px 46px 50px; align-items:center; gap:8px; padding:6px 0; border-top:1px solid var(--border); font-size:13.5px; }
  .bl-rrow:first-child { border-top:none; }
  .bl-rhead { font-size:9.5px; font-weight:800; letter-spacing:.5px; text-transform:uppercase; color:var(--muted); }
  .bl-rhead > span:not(.bl-rname) { text-align:right; }
  .bl-rface { width:30px; height:30px; border-radius:50%; object-fit:cover; object-position:center 40%; background:var(--surface2); border:2px solid var(--border); }
  .bl-rname { display:flex; flex-direction:column; min-width:0; }
  .bl-rname strong { font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .bl-role { font-size:9.5px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; color:var(--muted); }
  .bl-rstat { text-align:right; font-weight:800; font-variant-numeric:tabular-nums; }
  .bl-clickable:hover .bl-player-info strong { color:var(--accent-blue); }
  .bl-clickable:hover .bl-face { border-color:var(--accent-blue); }
  .bl-chev { margin-left:4px; color:var(--muted); font-size:20px; font-weight:700; line-height:1; transition:transform .15s; flex-shrink:0; }
  .bl-open .bl-chev { transform:rotate(90deg); }
  .bl-prow-logo { width:15px; height:15px; object-fit:contain; vertical-align:-3px; margin-right:5px; }
  .bl-card { margin:10px 0 2px; background:var(--surface2,#eef1ee); border:1px solid var(--border); border-radius:12px; }
  .bl-card[hidden] { display:none; }
  .bl-card-body { display:flex; align-items:center; gap:14px; padding:14px 16px; }
  .bl-card-face { width:64px; height:64px; border-radius:50%; object-fit:cover; object-position:center 50%; border:3px solid var(--border); background:var(--surface); flex-shrink:0; }
  .bl-card-main { flex:1; min-width:0; }
  .bl-card-stats { font-weight:800; font-size:15px; }
  .bl-card-stats2 { color:var(--muted); font-weight:600; font-size:13px; margin-top:3px; }
  .bl-card-week { color:var(--muted); font-size:12.5px; margin-top:5px; }
  .bl-meter { width:118px; flex-shrink:0; }
  .bl-meter-top { display:flex; justify-content:space-between; align-items:baseline; }
  .bl-meter-label { font-size:10px; font-weight:800; letter-spacing:1px; color:var(--muted); }
  .bl-meter-val { font-weight:600; font-size:20px; }
  .bl-meter-bar { height:6px; background:var(--border); border-radius:3px; overflow:hidden; margin:4px 0 3px; }
  .bl-meter-bar span { display:block; height:100%; border-radius:3px; }
  .bl-meter-tier { font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.5px; text-align:right; }
  .bl-face-wrap { position:relative; flex-shrink:0; display:inline-block; line-height:0; }
  .bl-face { width:52px; height:52px; border-radius:50%; object-fit:cover; object-position:center 50%;
    border:3px solid var(--ring,#9ca3af); background:var(--surface2); box-shadow:0 2px 8px rgba(22,28,39,.18); }
  .bl-face-wrap.shiny::after { content:''; position:absolute; inset:0; border-radius:50%;
    background:linear-gradient(115deg, transparent 38%, rgba(255,226,160,.5) 47%, rgba(255,255,255,.92) 50%, rgba(255,226,160,.5) 53%, transparent 62%);
    background-size:250% 100%; background-position:150% 0; mix-blend-mode:screen; pointer-events:none;
    animation:blSheen 3.4s ease-in-out infinite; }
  @keyframes blSheen { 0% { background-position:150% 0; } 55%,100% { background-position:-50% 0; } }
  @media (prefers-reduced-motion: reduce) { .bl-face-wrap.shiny::after { animation:none; } }
  .bl-player-info { display:flex; flex-direction:column; line-height:1.25; flex:1; min-width:0; }
  .bl-player-info strong { font-size:15.5px; font-weight:600; }
  .bl-player-info .bl-muted { font-size:12.5px; }
  .bl-stat { font-weight:600; font-size:20px; display:flex; align-items:baseline; gap:3px; flex-shrink:0; }
  .bl-stat small { font-size:9px; font-weight:700; letter-spacing:.5px; opacity:.8; }
  .bl-chip { font-size:9px; font-weight:800; letter-spacing:.3px; text-transform:uppercase; padding:2px 7px; border-radius:4px; flex-shrink:0; }
  .bl-shimmer-tag { font-size:9px; font-weight:800; letter-spacing:.3px; text-transform:uppercase; color:#b8860b; }
  .bl-delta { font-family:'Barlow Condensed','Inter',sans-serif; font-weight:800; font-size:18px; flex-shrink:0; text-align:right; white-space:nowrap; }
  .bl-why { font-family:'Inter',sans-serif; font-weight:700; font-size:11.5px; color:var(--muted); }
  .bl-dot { display:inline-block; width:9px; height:9px; border-radius:50%; vertical-align:middle; margin:0 3px 1px 0; }

  .bl-foot { margin-top:26px; text-align:center; }
  .bl-cta { display:inline-block; background:var(--accent-blue); color:#fff; text-decoration:none; font-weight:700; font-size:14px; padding:11px 20px; border-radius:999px; }
  .bl-note { color:var(--muted); font-size:12px; margin-top:16px; text-align:center; }
  .bl-related { margin-top:34px; border-top:1px solid var(--border); padding-top:18px; }
  .bl-related ul { list-style:none; display:flex; flex-direction:column; gap:8px; margin:10px 0 0; }
  .bl-related a { color:var(--accent-blue); text-decoration:none; font-weight:600; font-size:14.5px; }
  .bl-related a:hover { text-decoration:underline; }
"""

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{seo_title}</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#0d2016">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="{seo_title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{site}/og-image.png">
<meta property="og:url" content="{canonical}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="{rel}icon.png">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow+Condensed:wght@400;600;700;800;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{rel}css/main.css">
{jsonld}
<style>{style}</style>
</head>
<body>
  <div class="bl-wrap">
    <div class="bl-top"><a href="{rel}"><img src="{rel}icon.png" alt=""><span class="bl-wordmark">BASEBALL <span>LENS</span></span></a></div>
    <article class="bl-article">
      <div class="bl-kicker">The Lens · {kicker}</div>
      <h1>{title}</h1>
      <div class="bl-date">{datestr}</div>
      {dek}
      {body}
      {related}
      <div class="bl-foot"><a class="bl-cta" href="{rel}">See the full picture →</a></div>
      <p class="bl-note">Stats via the MLB Stats API. Colors, form scores and power rankings are Baseball Lens's own.</p>
    </article>
  </div>
  <script>
  function blToggleCard(el){{
    var card = el.nextElementSibling;
    if(!card || !card.classList.contains('bl-card')) return;
    var hidden = card.hasAttribute('hidden');
    if(hidden){{ card.removeAttribute('hidden'); }} else {{ card.setAttribute('hidden',''); }}
    el.classList.toggle('bl-open', hidden);
  }}
  </script>
</body>
</html>
"""

INDEX_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Lens — daily MLB column | Baseball Lens</title>
<meta name="description" content="The Lens: a daily MLB column — power rankings, the best staffs, elite hitters and pitchers, and week-over-week movers, all through the Baseball Lens color scale.">
<meta name="theme-color" content="#0d2016">
<link rel="canonical" href="{site}/blog/">
<link rel="icon" type="image/png" href="../icon.png">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow+Condensed:wght@400;600;700;800;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../css/main.css">
{jsonld}
<style>
  body {{ background: var(--bg); }}
  .bl-wrap {{ max-width: 720px; margin: 0 auto; padding: 0 20px 60px; }}
  .bl-top {{ display:flex; align-items:center; gap:10px; padding:18px 0; }}
  .bl-top a {{ display:flex; align-items:center; gap:10px; text-decoration:none; color:var(--text); }}
  .bl-top img {{ width:34px; height:34px; }}
  .bl-wordmark {{ font-family:'Bebas Neue'; font-size:22px; letter-spacing:2px; }}
  .bl-wordmark span {{ color: var(--accent); }}
  h1 {{ font-family:'Barlow Condensed','Inter',sans-serif; font-size:32px; letter-spacing:.5px; margin:6px 0 4px; }}
  .bl-sub {{ color:var(--muted); margin-bottom:22px; }}
  .bl-card {{ display:block; background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:18px 20px; margin-bottom:12px; text-decoration:none; color:var(--text); transition:border-color .15s; }}
  .bl-card:hover {{ border-color:var(--accent-blue); }}
  .bl-card h2 {{ font-size:18px; margin-bottom:4px; }}
  .bl-card .bl-date {{ color:var(--muted); font-size:12px; font-weight:600; letter-spacing:.5px; text-transform:uppercase; }}
</style>
</head>
<body>
  <div class="bl-wrap">
    <div class="bl-top"><a href="../"><img src="../icon.png" alt=""><span class="bl-wordmark">BASEBALL <span>LENS</span></span></a></div>
    <h1>The Lens</h1>
    <p class="bl-sub">A daily MLB column — through our color scale.</p>
    {cards}
  </div>
</body>
</html>
"""


def _slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def _fn_date(fn):
    """The YYYY-MM-DD embedded in a blog filename (date-only or keyword slug)."""
    m = re.search(r"(\d{4}-\d{2}-\d{2})", fn)
    return m.group(1) if m else fn[:-5]


def write_snapshot(date_iso, facts, narration=None):
    os.makedirs(SNAP_DIR, exist_ok=True)
    snap = {
        "date": date_iso,
        "power_ranking": [{"name": t["name"], "rank": t["rank"]} for t in facts["power_all"]],
        "hitters": [{"name": h["name"], "ops": round(h["ops"], 3), "hr": h["hr"]}
                    for h in facts["hitters_all"][:40]],
        "pitchers": [{"name": p["name"], "era": p["era"], "forma": round(p["forma"], 1)}
                     for p in facts["pitchers_all"][:40]],
        "rookies": [{"name": h["name"], "ops": round(h["ops"], 3), "hr": h["hr"]}
                    for h in facts.get("rookies", {}).get("hitters", [])[:25]],
    }
    if narration:   # keep the prose so later editions can avoid reusing its imagery
        snap["narration"] = narration
    with open(os.path.join(SNAP_DIR, f"{date_iso}.json"), "w") as fh:
        json.dump(snap, fh, indent=2)


def rebuild_index():
    os.makedirs(BLOG_DIR, exist_ok=True)
    cards, posts = [], []
    for fn in sorted((f for f in os.listdir(BLOG_DIR) if f.endswith(".html") and f != "index.html"),
                     key=_fn_date, reverse=True):
        html = open(os.path.join(BLOG_DIR, fn)).read()
        tm = re.search(r"<h1>(.*?)</h1>", html, re.S)
        dm = re.search(r'class="bl-date">(.*?)<', html, re.S)
        title = tm.group(1).strip() if tm else fn
        date = dm.group(1).strip() if dm else ""
        cards.append(f'<a class="bl-card" href="{fn}"><h2>{title}</h2>'
                     f'<div class="bl-date">{date}</div></a>')
        posts.append({"@type": "BlogPosting", "headline": title,
                      "url": f"{SITE}/blog/{fn}", "datePublished": _fn_date(fn)})
    blog_ld = {"@context": "https://schema.org", "@type": "Blog", "name": "The Lens",
               "url": f"{SITE}/blog/", "description": "A daily MLB column through the Baseball Lens "
               "color scale — power rankings, hitters, pitchers and week-over-week movers.",
               "publisher": {"@type": "Organization", "name": "Baseball Lens",
                             "logo": {"@type": "ImageObject", "url": f"{SITE}/icon.png"}},
               "blogPost": posts}
    jsonld = ('<script type="application/ld+json">'
              + json.dumps(blog_ld, ensure_ascii=False).replace("</", "<\\/") + "</script>")
    with open(os.path.join(BLOG_DIR, "index.html"), "w") as fh:
        fh.write(INDEX_PAGE.format(site=SITE, cards="".join(cards), jsonld=jsonld))


def rebuild_sitemap(date_iso):
    urls = [(f"{SITE}/", "1.0", "daily"), (f"{SITE}/blog/", "0.8", "daily")]
    for fn in sorted((f for f in os.listdir(BLOG_DIR) if f.endswith(".html") and f != "index.html"),
                     key=_fn_date, reverse=True):
        urls.append((f"{SITE}/blog/{fn}", "0.6", "monthly"))
    body = "".join(
        f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{date_iso}</lastmod>\n"
        f"    <changefreq>{cf}</changefreq>\n    <priority>{p}</priority>\n  </url>\n"
        for u, p, cf in urls)
    with open(os.path.join(ROOT, "sitemap.xml"), "w") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                 f"{body}</urlset>\n")


def recent_headlines(date_iso, n=3):
    """Headlines of the last few editions, so the LLM can avoid echoing them."""
    if not os.path.isdir(BLOG_DIR):
        return []
    files = sorted((f for f in os.listdir(BLOG_DIR)
                    if f.endswith(".html") and f != "index.html" and _fn_date(f) < date_iso),
                   key=_fn_date, reverse=True)
    out = []
    for fn in files[:n]:
        m = re.search(r"<h1>(.*?)</h1>", open(os.path.join(BLOG_DIR, fn)).read(), re.S)
        if m:
            out.append(re.sub(r"<.*?>", "", m.group(1)).strip())
    return out


def recent_links(date_iso, n=4):
    """(title, filename) of the last few editions, for in-article internal linking."""
    if not os.path.isdir(BLOG_DIR):
        return []
    files = sorted((f for f in os.listdir(BLOG_DIR)
                    if f.endswith(".html") and f != "index.html" and _fn_date(f) < date_iso),
                   key=_fn_date, reverse=True)
    out = []
    for fn in files[:n]:
        m = re.search(r"<h1>(.*?)</h1>", open(os.path.join(BLOG_DIR, fn)).read(), re.S)
        if m:
            out.append((re.sub(r"<.*?>", "", m.group(1)).strip(), fn))
    return out


def recent_prose(date_iso, n=3):
    """Intros + leads from the last few editions (saved in their snapshots), so the LLM
    can be told what imagery/framings to avoid — not just the headlines."""
    if not os.path.isdir(SNAP_DIR):
        return []
    files = sorted((f for f in os.listdir(SNAP_DIR)
                    if f.endswith(".json") and f[:-5] < date_iso), reverse=True)
    out = []
    for fn in files[:n]:
        try:
            with open(os.path.join(SNAP_DIR, fn)) as fh:
                nar = json.load(fh).get("narration") or {}
        except Exception:
            continue
        if nar.get("intro"):
            out.append(nar["intro"])
        out.extend(v for k, v in nar.items() if k.endswith("_lead") and v)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=dt.date.today().year)
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--theme", default="", help="override: power|pitching|hitting|races|rookies|movers|league")
    ap.add_argument("--snapshot-only", action="store_true",
                    help="just save a dated snapshot (no article/LLM) — for building movers baselines")
    args = ap.parse_args()

    load_env()
    date_iso = args.date
    # Past dates use point-in-time stats (real retrospective); today uses current season.
    asof = date_iso if date_iso < dt.date.today().isoformat() else None

    if args.snapshot_only:
        facts = build_facts(args.season, None, asof=asof)
        write_snapshot(date_iso, facts)
        print(f"Snapshot {date_iso} (as-of {asof or 'current'}) — no article")
        return

    pretty = dt.date.fromisoformat(date_iso).strftime("%B %-d, %Y")
    # On the 1st of May–Oct, publish a "Best of [last month]" wrap instead of the daily theme.
    d = dt.date.fromisoformat(date_iso)
    monthly = d.day == 1 and d.month in (5, 6, 7, 8, 9, 10)
    if monthly:
        m_end = d - dt.timedelta(days=1)
        m_start, m_label = m_end.replace(day=1), m_end.strftime("%B")
        kicker, section_ids = f"Best of {m_label}", ["month_hitters", "month_hr", "month_pitchers"]
    elif not args.theme and date_iso in SPECIAL_EDITIONS:
        kicker, section_ids = SPECIAL_EDITIONS[date_iso]
    else:
        kicker, section_ids = pick_theme(date_iso, args.theme)

    baseline = None if monthly else load_baseline(date_iso)
    sids = set(section_ids) | set(FALLBACK_SECTIONS)
    facts = build_facts(args.season, baseline, asof=asof,
                        need_teamstats=bool(sids & TEAMSTAT_SECTIONS))
    facts["movers"] = {} if monthly else compute_movers(facts, baseline)
    if monthly:
        facts.update(build_month_facts(args.season, m_start.isoformat(), m_end.isoformat(), m_label))
        for lst in (facts["month_hitters"], facts["month_hr"], facts["month_pitchers"]):
            attach_team_meta(lst, facts["team_id_by_name"], facts["team_abbr"])
    facts["recent_headlines"] = recent_headlines(date_iso)
    facts["recent_prose"] = recent_prose(date_iso)
    if {"hweek", "fallers"} & set(section_ids):   # last-7-days hitter lines (hot bats + cooling)
        end_d = asof or dt.date.today().isoformat()
        start_d = (dt.date.fromisoformat(end_d) - dt.timedelta(days=7)).isoformat()
        wk = get_week_hitters(args.season, start_d, end_d)
        attach_team_meta(wk, facts["team_id_by_name"], facts["team_abbr"])
        facts["week_by_id"] = {h["id"]: h for h in wk}
        facts["week_hot"] = [h for h in wk if h["ok"]][:5]
        for h in facts["week_hot"]:   # part-timers missing from the qualified map still get a card
            if h["id"] not in facts["hit_by_id"]:
                sea = get_hitter_season(args.season, h["id"], asof)
                if sea:
                    facts["hit_by_id"][h["id"]] = sea
    if "gem_pitchers" in section_ids or "gem_hitters" in section_ids:
        facts.update(build_gems_facts(args.season, asof, facts))
    if "hr" in section_ids and facts["movers"].get("hr"):
        attach_hr_games(facts["movers"]["hr"], args.season,
                        facts.get("baseline_date") or date_iso, asof, facts["team_abbr"])

    narration = llm_narration(facts, kicker, section_ids)
    title = (narration or {}).get("title") or f"{kicker} — {pretty}"
    body = render_article(section_ids, facts, narration)
    dek_text = (f"The hitters, sluggers and arms who owned {m_label}." if monthly
                else EDITION_DEK.get(kicker, ""))
    dek = f'<p class="bl-dek">{escape(dek_text)}</p>' if dek_text else ""
    # SEO: keyword-rich title; unique meta description from the LLM intro.
    seo_title = f"MLB {kicker} — {pretty} | Baseball Lens"
    desc = (narration or {}).get("intro") or (
        f"{kicker}: MLB through the Baseball Lens color scale — power rankings, hitters, pitchers "
        "and week-over-week movers.")
    if len(desc) > 160:
        desc = desc[:157].rsplit(" ", 1)[0] + "…"
    links = recent_links(date_iso)
    related = (('<div class="bl-related"><h2>More from The Lens</h2><ul>'
                + "".join(f'<li><a href="{fn}">{t}</a></li>' for t, fn in links)  # t already escaped HTML
                + '</ul></div>') if links else "")

    os.makedirs(BLOG_DIR, exist_ok=True)
    slug = f"mlb-{_slugify(kicker)}-{date_iso}.html"
    canonical = f"{SITE}/blog/{slug}"
    jsonld = article_jsonld(title, date_iso, canonical, desc)
    with open(os.path.join(BLOG_DIR, slug), "w") as fh:
        fh.write(PAGE.format(title=escape(title), seo_title=escape(seo_title), desc=escape(desc),
                             kicker=escape(kicker), canonical=canonical, site=SITE, rel="../",
                             datestr=pretty.upper(), dek=dek, related=related, body=body,
                             style=STYLE, jsonld=jsonld))
    for old in os.listdir(BLOG_DIR):   # drop this date's prior AUTO edition (different kicker -> different slug); leave hand-made specials alone
        if old.startswith("mlb-") and old.endswith(".html") and old != slug and _fn_date(old) == date_iso:
            os.remove(os.path.join(BLOG_DIR, old))

    write_snapshot(date_iso, facts, narration)
    rebuild_index()
    rebuild_sitemap(date_iso)
    print(f"Wrote blog/{slug} [{kicker}: {', '.join(section_ids)}], "
          f"movers={'yes' if facts['movers'] else 'no baseline yet'}")


if __name__ == "__main__":
    main()
