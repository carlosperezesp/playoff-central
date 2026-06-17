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


def get_teams(season):
    d = fetch(f"{API}/standings?leagueId=103,104&season={season}"
              f"&standingsTypes=regularSeason&hydrate=team,division")
    out = []
    for rec in d.get("records", []):
        for tr in rec.get("teamRecords", []):
            l10 = next((s for s in tr.get("records", {}).get("splitRecords", [])
                        if s.get("type") == "lastTen"), {})
            wins, losses = tr.get("wins", 0), tr.get("losses", 0)
            out.append({
                "id": tr["team"]["id"], "name": tr["team"]["name"],
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


def get_hitters(season, limit=50):
    d = fetch(f"{API}/stats?stats=season&season={season}&sportId=1&group=hitting"
              f"&gameType=R&playerPool=qualified&sortStat=onBasePlusSlugging&limit={limit}&hydrate=team")
    out = []
    for s in d.get("stats", [{}])[0].get("splits", []):
        st = s["stat"]
        ops = float(st.get("ops", 0) or 0)
        out.append({"id": s["player"]["id"], "name": s["player"]["fullName"],
                    "team": s.get("team", {}).get("name", ""),
                    "ops": ops, "hr": int(st.get("homeRuns", 0) or 0),
                    "tier": hitter_tier(ops), "historic": ops >= 1.000})
    return out


def get_pitchers(season, limit=40):
    d = fetch(f"{API}/stats?stats=season&season={season}&sportId=1&group=pitching"
              f"&gameType=R&playerPool=qualified&sortStat=earnedRunAverage&limit={limit}&hydrate=team")
    out = []
    for s in d.get("stats", [{}])[0].get("splits", []):
        st = s["stat"]
        era, whip = float(st.get("era", 99)), float(st.get("whip", 9))
        forma = forma_score(era, whip)
        out.append({"id": s["player"]["id"], "name": s["player"]["fullName"],
                    "team": s.get("team", {}).get("name", ""),
                    "era": era, "whip": whip, "forma": forma,
                    "tier": pitcher_tier(forma), "historic": era <= 2.00 and whip <= 1.00})
    return out


def get_team_pitching(season, top=5):
    d = fetch(f"{API}/teams/stats?stats=season&group=pitching&season={season}&sportId=1&gameType=R")
    rows = []
    for s in d.get("stats", [{}])[0].get("splits", []):
        t, st = s.get("team") or {}, s.get("stat", {})
        if t and st.get("era") is not None:
            era, whip = float(st["era"]), float(st.get("whip", 0) or 0)
            rows.append({"id": t.get("id"), "name": t.get("name", ""), "era": era, "whip": whip,
                         "tier": pitcher_tier(forma_score(era, whip))})
    rows.sort(key=lambda r: r["era"])
    return rows[:top]


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
        if bt != h["tier"] and "gray" not in (bt, h["tier"]):
            colors.append({"p": h, "old": bt})
    for p in f["pitchers_all"]:
        b = bp.get(p["name"])
        if not b:
            continue
        if p["forma"] - b.get("forma", p["forma"]) >= 4:
            form.append({"p": p, "base": b, "d": p["forma"] - b["forma"]})
        bt = pitcher_tier(b.get("forma", p["forma"]))
        if bt != p["tier"] and "gray" not in (bt, p["tier"]):
            colors.append({"p": p, "old": bt})
    hr.sort(key=lambda x: x["d"], reverse=True)
    form.sort(key=lambda x: x["d"], reverse=True)
    cool.sort(key=lambda x: x["d"])
    colors.sort(key=lambda c: abs(TIER_ORDER[c["old"]] - TIER_ORDER[c["p"]["tier"]]), reverse=True)
    return {"hr": hr[:5], "form": form[:5], "cool": cool[:5], "colors": colors[:6],
            "baseline_date": base.get("date")}


# ── HTML pieces ─────────────────────────────────────────────────────────────
def logo_url(team_id):
    return f"https://www.mlbstatic.com/team-logos/{team_id}.svg"


def headshot(pid):
    return (f"https://img.mlbstatic.com/mlb-photos/image/upload/"
            f"d_people:generic:headshot:67:current.png/w_213,q_auto:best/"
            f"v1/people/{pid}/headshot/67/current")


def face(pid, tier, historic=False):
    cls = "bl-face-wrap shiny" if historic else "bl-face-wrap"
    return (f'<span class="{cls}" style="--ring:{BRIGHT[tier]}">'
            f'<img class="bl-face" loading="lazy" alt="" src="{headshot(pid)}" '
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


def staff_row(s, i):
    return (f'<li class="bl-rankrow"><span class="bl-rank">{i}</span>'
            f'<img class="bl-team-logo" src="{logo_url(s["id"])}" alt="" loading="lazy">'
            f'<span class="bl-team-info"><strong>{escape(s["name"])}</strong>'
            f'<span class="bl-muted">{s["whip"]:.2f} WHIP</span></span>'
            f'<span class="bl-stat" style="color:{TEXT[s["tier"]]}">{s["era"]:.2f}<small>ERA</small></span></li>')


def _player_row(p, stat_html, extra=""):
    return (f'<li class="bl-player">{face(p["id"], p["tier"], p.get("historic"))}'
            f'<span class="bl-player-info"><strong>{escape(p["name"])}</strong>'
            f'<span class="bl-muted">{escape(p["team"])}</span></span>{stat_html}{extra}</li>')


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
    delta = f'<span class="bl-delta" style="color:{TEXT["green"]}">+{d} HR · {h["hr"]} total</span>'
    return _player_row(h, delta)


def form_row(m):
    p, b, d = m["p"], m["base"], m["d"]
    crossed = (' <span class="bl-shimmer-tag" style="color:#16a34a">now elite</span>'
               if p["tier"] == "green" and pitcher_tier(b["forma"]) != "green" else "")
    delta = (f'<span class="bl-delta" style="color:{TEXT["green"]}">'
             f'form {b["forma"]:.0f}&rarr;{p["forma"]:.0f} (+{d:.0f})</span>')
    return _player_row(p, delta, crossed)


def cool_row(m):
    h, b, d = m["p"], m["base"], m["d"]
    delta = (f'<span class="bl-delta" style="color:{TEXT["red"]}">'
             f'OPS {b["ops"]:.3f}&rarr;{h["ops"]:.3f} ({d:.3f})</span>')
    return _player_row(h, delta)


def color_row(c):
    p, old = c["p"], c["old"]
    delta = f'<span class="bl-delta">{tier_dot(old)} &rarr; {tier_dot(p["tier"])}</span>'
    return _player_row(p, delta)


# ── Sections (each returns full HTML or "" if empty) ────────────────────────
def _lead(n, key, fallback):
    return f'<p>{escape(n[key])}</p>' if n and n.get(key) else fallback


def _section(heading, lead_html, rows):
    return f'<h2>{heading}</h2>{lead_html}<ul class="bl-list">{rows}</ul>' if rows else ""


def sec_power(f, n, limit=10):
    rows = "".join(power_row(t, f["has_movement"]) for t in f["power_top"][:limit])
    d = ('<p>Our power ranking — season record, run differential and last-ten form blended into '
         'one order. The top of the league right now:</p>')
    return _section("Power Rankings", _lead(n, "power_lead", d), rows)


def sec_staffs(f, n, limit=5):
    rows = "".join(staff_row(s, i) for i, s in enumerate(f["staffs"][:limit], 1))
    d = '<p>Team ERA — rotation and bullpen together. The run-prevention leaders:</p>'
    return _section("Best staffs on the mound", _lead(n, "staff_lead", d), rows)


def sec_bats(f, n, limit=8):
    rows = "".join(hitter_row(h) for h in f["elite_hitters"][:limit])
    d = ('<p>An OPS of .900 or better is '
         f'<span style="color:{TEXT["green"]};font-weight:700">elite</span> on our scale — green. '
         'A shimmer marks a historic pace (OPS ≥ 1.000):</p>')
    return _section("Swinging a green bat", _lead(n, "hitters_lead", d), rows)


def sec_arms(f, n, limit=6):
    rows = "".join(pitcher_row(p) for p in f["aces"][:limit])
    d = ('<p>Form — our 0–100 score from ERA &amp; WHIP — puts these arms in the green. '
         'A shimmer marks a historic pace (ERA ≤ 2.00 &amp; WHIP ≤ 1.00):</p>')
    return _section("Green on the mound", _lead(n, "pitchers_lead", d), rows)


def sec_hr(f, n, limit=5):
    rows = "".join(hr_row(m) for m in f["movers"].get("hr", [])[:limit])
    d = '<p>Who put the ball over the wall most since last week:</p>'
    return _section("Climbing the home-run ladder", _lead(n, "hr_lead", d), rows)


def sec_risers(f, n, limit=5):
    rows = "".join(form_row(m) for m in f["movers"].get("form", [])[:limit])
    d = '<p>Arms trending up — the biggest gains in form since last week:</p>'
    return _section("Turning it around", _lead(n, "risers_lead", d), rows)


def sec_fallers(f, n, limit=5):
    rows = "".join(cool_row(m) for m in f["movers"].get("cool", [])[:limit])
    d = '<p>Bats that have cooled off — the steepest OPS slides since last week:</p>'
    return _section("Cooling off", _lead(n, "fallers_lead", d), rows)


def sec_colors(f, n, limit=6):
    rows = "".join(color_row(c) for c in f["movers"].get("colors", [])[:limit])
    d = '<p>Players who changed color on our scale this week — the tide turning, one way or the other:</p>'
    return _section("Changing colors", _lead(n, "colors_lead", d), rows)


SECTIONS = {"power": sec_power, "staffs": sec_staffs, "bats": sec_bats, "arms": sec_arms,
            "hr": sec_hr, "risers": sec_risers, "fallers": sec_fallers, "colors": sec_colors}

# Weekday (0=Mon) → (edition title, [section ids])
THEME_CALENDAR = {
    0: ("Power Rankings", ["power"]),
    1: ("Pitching Report", ["staffs", "arms", "risers"]),
    2: ("Hitting Report", ["bats", "hr"]),
    3: ("Risers & Fallers", ["risers", "fallers", "colors"]),
    4: ("Midweek Check", ["power", "staffs"]),
    5: ("Bats & Arms", ["bats", "arms"]),
    6: ("Around the League", ["power", "bats", "arms"]),
}
THEME_BY_KEY = {  # --theme override
    "power": ("Power Rankings", ["power"]),
    "pitching": ("Pitching Report", ["staffs", "arms", "risers"]),
    "hitting": ("Hitting Report", ["bats", "hr"]),
    "movers": ("Risers & Fallers", ["risers", "fallers", "colors"]),
    "league": ("Around the League", ["power", "bats", "arms"]),
}
FALLBACK_SECTIONS = ["power", "bats", "arms"]   # if a theme's sections are all empty


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
    "You write THE LENS, the daily column for Baseball Lens, an MLB site that turns the season "
    "into color (green = elite, red = struggling).\n\n"
    "VOICE — a chronicler in the tradition of Red Smith, Roger Angell and Jim Murray:\n"
    "- Plain, exact American English. Strong precise verbs, not piled-up adjectives. Economy is "
    "respect for the reader.\n"
    "- Sense of occasion: when a number is genuinely special, find the image that makes it land — "
    "but never inflate. Admiration without honesty is just hype. Measure every claim against the data.\n"
    "- Dry wit is welcome; clichés, hype and emoji are not. Be fair to the teams and players "
    "struggling, never cruel.\n"
    "- A feel for the season's arc — who's rising, who's sliding, where this is heading.\n"
    "- Never lie to the reader: use ONLY the names and numbers in the data provided; never invent, "
    "round differently, or estimate a stat.\n\n"
    "Today's edition has a THEME (given as edition_theme) and a fixed set of sections (sections_today). "
    "FORMAT: 'title' is a punchy 6-10 word headline true to the theme. 'intro' opens like a column — "
    "3-4 sentences picking out the day's real storyline(s). Each lead is 1-3 sentences setting up its "
    "list; name a standout or two but do NOT enumerate the whole list (the page renders it). Return "
    "ONLY raw JSON (no markdown) with string keys from: title, intro, power_lead, staff_lead, "
    "hitters_lead, pitchers_lead, hr_lead, risers_lead, fallers_lead, colors_lead — include title, "
    "intro, and a lead for each section in sections_today."
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
    payload = {
        "edition_theme": theme_title,
        "sections_today": section_ids,
        "power_rankings_top": [{"rank": t["rank"], "name": t["name"],
                                "record": f'{t["wins"]}-{t["losses"]}', "run_diff": t["runDiff"],
                                "last10": t["l10"]} for t in f["power_top"]],
        "best_staffs_by_team_era": [{"rank": i, "name": s["name"], "era": s["era"], "whip": s["whip"]}
                                    for i, s in enumerate(f["staffs"], 1)],
        "elite_hitters": [{"name": h["name"], "team": h["team"], "ops": round(h["ops"], 3),
                           "hr": h["hr"], "historic_pace": h["historic"]} for h in f["elite_hitters"]],
        "elite_pitchers": [{"name": p["name"], "team": p["team"], "era": p["era"], "whip": p["whip"],
                            "historic_pace": p["historic"]} for p in f["aces"]],
    }
    if m:
        payload["movers_vs_last_week"] = {
            "hr_climbers": [{"name": x["p"]["name"], "hr_now": x["p"]["hr"], "hr_gained": x["d"]} for x in m.get("hr", [])],
            "form_risers": [{"name": x["p"]["name"], "form_now": round(x["p"]["forma"]), "form_gained": round(x["d"])} for x in m.get("form", [])],
            "cooling_bats": [{"name": x["p"]["name"], "ops_now": round(x["p"]["ops"], 3), "ops_drop": round(x["d"], 3)} for x in m.get("cool", [])],
            "color_changes": [{"name": c["p"]["name"], "from": TIER_LABEL[c["old"]], "to": TIER_LABEL[c["p"]["tier"]]} for c in m.get("colors", [])],
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


def build_facts(season, prev_rank):
    ranked = compute_power(get_teams(season))
    for t in ranked:
        t["movement"] = (prev_rank[t["name"]] - t["rank"]) if t["name"] in prev_rank else None
    hitters = get_hitters(season, 50)
    pitchers = get_pitchers(season, 40)
    return {
        "power_all": ranked, "power_top": ranked[:10], "has_movement": bool(prev_rank),
        "staffs": get_team_pitching(season, 5),
        "hitters_all": hitters, "pitchers_all": pitchers,
        "elite_hitters": [h for h in hitters if h["tier"] == "green"][:8],
        "aces": [p for p in pitchers if p["tier"] == "green"][:6],
    }


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
  .bl-article h2 { font-family:'Barlow Condensed','Inter',sans-serif; font-size:14px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--accent); margin:28px 0 10px; }
  .bl-article p { font-size:15px; line-height:1.6; margin-bottom:6px; }
  .bl-intro { font-size:16px; color:var(--muted); margin-bottom:18px; }
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

  .bl-player { display:flex; align-items:center; gap:12px; }
  .bl-face-wrap { position:relative; flex-shrink:0; display:inline-block; line-height:0; }
  .bl-face { width:52px; height:52px; border-radius:50%; object-fit:cover; object-position:center 28%;
    border:3px solid var(--ring,#9ca3af); background:var(--surface2); box-shadow:0 2px 8px rgba(22,28,39,.18); }
  .bl-face-wrap.shiny::after { content:''; position:absolute; inset:0; border-radius:50%;
    background:linear-gradient(115deg, transparent 38%, rgba(255,226,160,.5) 47%, rgba(255,255,255,.92) 50%, rgba(255,226,160,.5) 53%, transparent 62%);
    background-size:250% 100%; background-position:150% 0; mix-blend-mode:screen; pointer-events:none;
    animation:blSheen 3.4s ease-in-out infinite; }
  @keyframes blSheen { 0% { background-position:150% 0; } 55%,100% { background-position:-50% 0; } }
  @media (prefers-reduced-motion: reduce) { .bl-face-wrap.shiny::after { animation:none; } }
  .bl-player-info { display:flex; flex-direction:column; line-height:1.25; flex:1; min-width:0; }
  .bl-player-info strong { font-size:14.5px; }
  .bl-player-info .bl-muted { font-size:12.5px; }
  .bl-stat { font-weight:800; font-size:15px; display:flex; align-items:baseline; gap:3px; flex-shrink:0; }
  .bl-stat small { font-size:9px; font-weight:700; letter-spacing:.5px; opacity:.8; }
  .bl-chip { font-size:9px; font-weight:800; letter-spacing:.3px; text-transform:uppercase; padding:2px 7px; border-radius:4px; flex-shrink:0; }
  .bl-shimmer-tag { font-size:9px; font-weight:800; letter-spacing:.3px; text-transform:uppercase; color:#b8860b; }
  .bl-delta { font-family:'Barlow Condensed','Inter',sans-serif; font-weight:800; font-size:13px; flex-shrink:0; text-align:right; white-space:nowrap; }
  .bl-dot { display:inline-block; width:9px; height:9px; border-radius:50%; vertical-align:middle; margin:0 3px 1px 0; }

  .bl-foot { margin-top:26px; text-align:center; }
  .bl-cta { display:inline-block; background:var(--accent-blue); color:#fff; text-decoration:none; font-weight:700; font-size:14px; padding:11px 20px; border-radius:999px; }
  .bl-note { color:var(--muted); font-size:12px; margin-top:16px; text-align:center; }
"""

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} — Baseball Lens</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#0d2016">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="{title} — Baseball Lens">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{site}/og-image.png">
<meta property="og:url" content="{canonical}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="{rel}icon.png">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow+Condensed:wght@400;600;700;800;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{rel}css/main.css">
<style>{style}</style>
</head>
<body>
  <div class="bl-wrap">
    <div class="bl-top"><a href="{rel}"><img src="{rel}icon.png" alt=""><span class="bl-wordmark">BASEBALL <span>LENS</span></span></a></div>
    <article class="bl-article">
      <div class="bl-kicker">The Lens · {kicker}</div>
      <h1>{title}</h1>
      <div class="bl-date">{datestr}</div>
      {body}
      <div class="bl-foot"><a class="bl-cta" href="{rel}">See the full picture →</a></div>
      <p class="bl-note">Stats via the MLB Stats API. Colors, form scores and power rankings are Baseball Lens's own.</p>
    </article>
  </div>
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


def write_snapshot(date_iso, facts):
    os.makedirs(SNAP_DIR, exist_ok=True)
    snap = {
        "date": date_iso,
        "power_ranking": [{"name": t["name"], "rank": t["rank"]} for t in facts["power_all"]],
        "hitters": [{"name": h["name"], "ops": round(h["ops"], 3), "hr": h["hr"]}
                    for h in facts["hitters_all"][:40]],
        "pitchers": [{"name": p["name"], "era": p["era"], "forma": round(p["forma"], 1)}
                     for p in facts["pitchers_all"][:40]],
    }
    with open(os.path.join(SNAP_DIR, f"{date_iso}.json"), "w") as fh:
        json.dump(snap, fh, indent=2)


def rebuild_index():
    os.makedirs(BLOG_DIR, exist_ok=True)
    cards = []
    for fn in sorted((f for f in os.listdir(BLOG_DIR) if f.endswith(".html") and f != "index.html"),
                     reverse=True):
        html = open(os.path.join(BLOG_DIR, fn)).read()
        tm = re.search(r"<h1>(.*?)</h1>", html, re.S)
        dm = re.search(r'class="bl-date">(.*?)<', html, re.S)
        title = tm.group(1).strip() if tm else fn
        date = dm.group(1).strip() if dm else ""
        cards.append(f'<a class="bl-card" href="{fn}"><h2>{title}</h2>'
                     f'<div class="bl-date">{date}</div></a>')
    with open(os.path.join(BLOG_DIR, "index.html"), "w") as fh:
        fh.write(INDEX_PAGE.format(site=SITE, cards="".join(cards)))


def rebuild_sitemap(date_iso):
    urls = [(f"{SITE}/", "1.0", "daily"), (f"{SITE}/blog/", "0.8", "daily")]
    for fn in sorted((f for f in os.listdir(BLOG_DIR) if f.endswith(".html") and f != "index.html"),
                     reverse=True):
        urls.append((f"{SITE}/blog/{fn}", "0.6", "monthly"))
    body = "".join(
        f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{date_iso}</lastmod>\n"
        f"    <changefreq>{cf}</changefreq>\n    <priority>{p}</priority>\n  </url>\n"
        for u, p, cf in urls)
    with open(os.path.join(ROOT, "sitemap.xml"), "w") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                 f"{body}</urlset>\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=dt.date.today().year)
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--theme", default="", help="override: power|pitching|hitting|movers|league")
    args = ap.parse_args()

    load_env()
    date_iso = args.date
    pretty = dt.date.fromisoformat(date_iso).strftime("%B %-d, %Y")
    kicker, section_ids = pick_theme(date_iso, args.theme)

    baseline = load_baseline(date_iso)
    prev_rank = {r["name"]: r["rank"] for r in baseline.get("power_ranking", [])} if baseline else {}
    facts = build_facts(args.season, prev_rank)
    facts["movers"] = compute_movers(facts, baseline)

    narration = llm_narration(facts, kicker, section_ids)
    title = (narration or {}).get("title") or f"{kicker} — {pretty}"
    body = render_article(section_ids, facts, narration)
    desc = (f"{kicker}: MLB through the Baseball Lens color scale — power rankings, elite hitters "
            "and pitchers, and week-over-week movers.")

    os.makedirs(BLOG_DIR, exist_ok=True)
    slug = f"{date_iso}.html"
    with open(os.path.join(BLOG_DIR, slug), "w") as fh:
        fh.write(PAGE.format(title=escape(title), desc=escape(desc), kicker=escape(kicker),
                             canonical=f"{SITE}/blog/{slug}", site=SITE, rel="../",
                             datestr=pretty.upper(), body=body, style=STYLE))

    write_snapshot(date_iso, facts)
    rebuild_index()
    rebuild_sitemap(date_iso)
    print(f"Wrote blog/{slug} [{kicker}: {', '.join(section_ids)}], "
          f"movers={'yes' if facts['movers'] else 'no baseline yet'}")


if __name__ == "__main__":
    main()
