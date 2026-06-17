#!/usr/bin/env python3
"""Baseball Lens — weekly article generator.

Reads live MLB stats, computes the facts deterministically in the app's color
language (elite/green … poor/red) — power rankings, elite hitters, dominant
pitchers — and writes a static, crawlable HTML article that uses the app's
visual vocabulary: player headshots ringed in their tier color, team logos, the
shimmer for historic seasons. A dated snapshot is saved each run so the next
week can show movement (power-ranking risers/fallers) and color changes.

Phase 2: Claude writes the prose (headline + intro + each section's lead) around
the computed facts — the lists are code-rendered, so no stat is hallucinated.
Falls back to deterministic templates if tools/.env / the SDK / the call fails.

Usage:  python3 tools/generate_weekly.py [--season YYYY] [--date YYYY-MM-DD]
"""

import argparse
import datetime as dt
import json
import os
import urllib.request
from html import escape

API = "https://statsapi.mlb.com/api/v1"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLOG_DIR = os.path.join(ROOT, "blog")
SNAP_DIR = os.path.join(ROOT, "data", "snapshots")
SITE = "https://baseballlens.com"

# ── Color scale (ported from getDiamondPlayerColor / statTextColor in app.js) ─
# BRIGHT = circle/ring colors (match the diamond); TEXT = readable on white.
BRIGHT = {"green": "#16a34a", "lgreen": "#b1c882", "yellow": "#ffc000",
          "orange": "#ff8100", "red": "#ff2200", "gray": "#9ca3af"}
TEXT = {"green": "#16a34a", "lgreen": "#7d9440", "yellow": "#c29200",
        "orange": "#e06f00", "red": "#e51f00", "gray": "#6b7280"}
TIER_LABEL = {"green": "elite", "lgreen": "above avg", "yellow": "average",
              "orange": "below avg", "red": "poor", "gray": "no data"}


def hitter_tier(ops):
    if not ops or ops <= 0: return "gray"
    if ops >= 0.900: return "green"
    if ops >= 0.750: return "lgreen"
    if ops >= 0.600: return "yellow"
    if ops >= 0.450: return "orange"
    return "red"


def forma_score(era, whip):
    """FORMA base score 0-100 from ERA & WHIP (constants from app.js)."""
    parts = []
    if era is not None:
        parts.append(max(0, min(100, (6.00 - era) / (6.00 - 1.50) * 100)))
    if whip is not None:
        parts.append(max(0, min(100, (2.00 - whip) / (2.00 - 0.80) * 100)))
    return sum(parts) / len(parts) if parts else None


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
                "streak": tr.get("streak", {}).get("streakCode", "—"),
                "l10": f"{l10.get('wins', 0)}-{l10.get('losses', 0)}",
                "l10w": l10.get("wins", 0),
                "runDiff": tr.get("runDifferential", 0),
            })
    return out


def compute_power(teams):
    """Blend season record, last-10 form and run differential into one order."""
    for t in teams:
        gp = t["gp"] or 1
        win_pct = t["wins"] / max(1, t["wins"] + t["losses"])
        l10_pct = t["l10w"] / 10
        rd_pg = t["runDiff"] / gp
        rd_norm = max(0.0, min(1.0, (rd_pg + 2.5) / 5.0))   # ~[-2.5,+2.5] → [0,1]
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
                    "tier": pitcher_tier(forma),
                    "historic": era <= 2.00 and whip <= 1.00})
    return out


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
    driver = (f'{t["wins"]}-{t["losses"]} · {"+" if rd >= 0 else ""}{rd} run diff · '
              f'L10 {escape(t["l10"])}')
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


def hitter_row(h):
    star = ' <span class="bl-shimmer-tag">historic</span>' if h["historic"] else ""
    return (f'<li class="bl-player">{face(h["id"], h["tier"], h["historic"])}'
            f'<span class="bl-player-info"><strong>{escape(h["name"])}</strong>'
            f'<span class="bl-muted">{escape(h["team"])}</span></span>'
            f'<span class="bl-stat" style="color:{TEXT[h["tier"]]}">{h["ops"]:.3f}<small>OPS</small></span>'
            f'{chip(h["tier"], TIER_LABEL[h["tier"]])}{star}</li>')


def pitcher_row(p):
    star = ' <span class="bl-shimmer-tag">historic</span>' if p["historic"] else ""
    return (f'<li class="bl-player">{face(p["id"], p["tier"], p["historic"])}'
            f'<span class="bl-player-info"><strong>{escape(p["name"])}</strong>'
            f'<span class="bl-muted">{escape(p["team"])}</span></span>'
            f'<span class="bl-stat" style="color:{TEXT[p["tier"]]}">{p["era"]:.2f}<small>ERA</small></span>'
            f'{chip(p["tier"], TIER_LABEL[p["tier"]])}{star}</li>')


def build_facts(season, prev_rank):
    ranked = compute_power(get_teams(season))
    has_movement = bool(prev_rank)
    for t in ranked:
        t["movement"] = (prev_rank[t["name"]] - t["rank"]) if t["name"] in prev_rank else None
    hitters = get_hitters(season, 50)
    pitchers = get_pitchers(season, 40)
    return {
        "power_all": ranked, "power_top": ranked[:10], "has_movement": has_movement,
        "staffs": get_team_pitching(season, 5),
        "hitters_all": hitters, "pitchers_all": pitchers,
        "elite_hitters": [h for h in hitters if h["tier"] == "green"][:8],
        "aces": [p for p in pitchers if p["tier"] == "green"][:6],
    }


# ── Phase 2: LLM writes the prose around the computed facts ─────────────────
# The numbers/lists are rendered deterministically (no hallucinated stats); the
# LLM only writes the headline, intro, and each section's lead. Falls back to
# the templates below if tools/.env / the SDK / the API call is missing.
LLM_SYSTEM = (
    "You write the weekly recap for Baseball Lens, an MLB site that turns the season into "
    "color (green = elite, red = struggling).\n\n"
    "VOICE — a chronicler in the tradition of Red Smith, Roger Angell and Jim Murray:\n"
    "- Plain, exact American English. Strong precise verbs, not piled-up adjectives. Economy is "
    "respect for the reader.\n"
    "- Sense of occasion: when a number is genuinely special, find the image that makes it land — "
    "but never inflate. Admiration without honesty is just hype. Measure every claim against the data.\n"
    "- Dry wit is welcome; clichés, hype and emoji are not. Be fair to the teams losing, never cruel.\n"
    "- A little warmth and a feel for the season's arc — streaks, where this is heading — is good.\n"
    "- Never lie to the reader: use ONLY the names and numbers in the data provided; never invent, "
    "round differently, or estimate a stat.\n\n"
    "FORMAT: 'title' is a punchy 6-10 word headline. 'intro' opens like a sports column — 3-4 "
    "sentences that pick out the week's two or three real storylines (a surging team, a historic "
    "pace, a staff carrying a club) and what they add up to; it should read as writing, not a "
    "caption. Each 'lead' is 1-3 sentences setting up the list that follows; name a standout or two "
    "but do NOT enumerate the whole list (the page renders it below). Return ONLY raw JSON (no "
    "markdown fences) with string keys: title, intro, power_lead, staff_lead, hitters_lead, pitchers_lead."
)


def load_env():
    """Load KEY=VALUE pairs from tools/.env into os.environ (gitignored, local)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def facts_for_llm(f):
    def mv(t):
        if not f["has_movement"]:
            return None
        m = t["movement"]
        return "NEW" if m is None else (f"+{m}" if m > 0 else (str(m) if m < 0 else "0"))
    return json.dumps({
        "power_rankings_top": [{"rank": t["rank"], "name": t["name"],
                                "record": f'{t["wins"]}-{t["losses"]}', "run_diff": t["runDiff"],
                                "last10": t["l10"], "movement_vs_last_week": mv(t)}
                               for t in f["power_top"]],
        "best_staffs_by_team_era": [{"rank": i, "name": s["name"], "era": s["era"], "whip": s["whip"]}
                                    for i, s in enumerate(f["staffs"], 1)],
        "elite_hitters": [{"name": h["name"], "team": h["team"], "ops": round(h["ops"], 3),
                           "hr": h["hr"], "historic_pace": h["historic"]} for h in f["elite_hitters"]],
        "elite_pitchers": [{"name": p["name"], "team": p["team"], "era": p["era"],
                            "whip": p["whip"], "historic_pace": p["historic"]} for p in f["aces"]],
    }, indent=2)


def llm_narration(f):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=1800,
            system=LLM_SYSTEM,
            messages=[{"role": "user", "content":
                       "Write this week's recap from these facts:\n\n" + facts_for_llm(f)}],
        )
        text = next(b.text for b in resp.content if b.type == "text")
        return json.loads(text[text.find("{"): text.rfind("}") + 1])
    except Exception as e:
        print(f"  LLM narration unavailable ({e}); using template prose")
        return None


def render_prose(f, n=None):
    def lead(key, fallback):
        return f'<p>{escape(n[key])}</p>' if n and n.get(key) else fallback
    parts = []
    if n and n.get("intro"):
        parts.append(f'<p class="bl-intro">{escape(n["intro"])}</p>')

    default = ('<p>Our weekly power ranking — season record, run differential and how a team has '
               'played its last ten, blended into one order. The top of the league right now:</p>')
    parts.append('<h2>Power Rankings</h2>' + lead("power_lead", default) +
                 '<ul class="bl-list">' +
                 "".join(power_row(t, f["has_movement"]) for t in f["power_top"]) + '</ul>')

    if f.get("staffs"):
        default = ('<p>Team ERA — the whole staff, rotation and bullpen together. '
                   'The run-prevention leaders:</p>')
        parts.append('<h2>Best staffs on the mound</h2>' + lead("staff_lead", default) +
                     '<ul class="bl-list">' +
                     "".join(staff_row(s, i) for i, s in enumerate(f["staffs"], 1)) + '</ul>')

    if f["elite_hitters"]:
        default = ('<p>On the Baseball Lens scale, an OPS of .900 or better is '
                   f'<span style="color:{TEXT["green"]};font-weight:700">elite</span> — green. '
                   'A shimmer marks a historic pace (OPS ≥ 1.000):</p>')
        parts.append('<h2>Swinging a green bat</h2>' + lead("hitters_lead", default) +
                     '<ul class="bl-list">' + "".join(hitter_row(h) for h in f["elite_hitters"]) + '</ul>')

    if f["aces"]:
        default = ('<p>Form — our 0–100 pitcher score from ERA &amp; WHIP — puts these arms firmly '
                   'in the green. A shimmer marks a historic pace (ERA ≤ 2.00 &amp; WHIP ≤ 1.00):</p>')
        parts.append('<h2>Green on the mound</h2>' + lead("pitchers_lead", default) +
                     '<ul class="bl-list">' + "".join(pitcher_row(p) for p in f["aces"]) + '</ul>')

    return "\n".join(parts)


STYLE = """
  body { background: var(--bg); }
  .bl-wrap { max-width: 720px; margin: 0 auto; padding: 0 20px 60px; }
  .bl-top { display:flex; align-items:center; gap:10px; padding:18px 0; }
  .bl-top a { display:flex; align-items:center; gap:10px; text-decoration:none; color:var(--text); }
  .bl-top img { width:34px; height:34px; }
  .bl-wordmark { font-family:'Bebas Neue'; font-size:22px; letter-spacing:2px; }
  .bl-wordmark span { color: var(--accent); }
  .bl-article { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:30px 28px; }
  .bl-article h1 { font-family:'Barlow Condensed','Inter',sans-serif; font-size:34px; line-height:1.05; letter-spacing:.5px; margin-bottom:8px; }
  .bl-date { color:var(--muted); font-size:13px; font-weight:600; letter-spacing:.5px; text-transform:uppercase; margin-bottom:22px; }
  .bl-article h2 { font-family:'Barlow Condensed','Inter',sans-serif; font-size:14px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--accent); margin:28px 0 10px; }
  .bl-article p { font-size:15px; line-height:1.6; margin-bottom:6px; }
  .bl-intro { font-size:16px; color:var(--muted); margin-bottom:18px; }
  .bl-list { list-style:none; display:flex; flex-direction:column; gap:12px; margin:14px 0; }
  .bl-muted { color:var(--muted); font-weight:500; }

  /* Power-ranking rows: rank + movement + logo + record */
  .bl-rankrow { display:flex; align-items:center; gap:10px; }
  .bl-rank { font-family:'Barlow Condensed','Inter',sans-serif; font-weight:800; font-size:19px; width:22px; text-align:center; flex-shrink:0; }
  .bl-mv { font-family:'Barlow Condensed','Inter',sans-serif; font-weight:800; font-size:13px; width:30px; text-align:center; flex-shrink:0; }
  .bl-mv-new { color:var(--accent-blue); font-size:10px; }
  .bl-team-logo { width:30px; height:30px; object-fit:contain; flex-shrink:0; }
  .bl-team-info { display:flex; flex-direction:column; line-height:1.25; flex:1; min-width:0; }
  .bl-team-info strong { font-size:14.5px; }
  .bl-team-info .bl-muted { font-size:12.5px; }

  /* Player rows: headshot ringed in tier color + name + stat + chip */
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
<title>The Lens — MLB analysis & weekly recaps | Baseball Lens</title>
<meta name="description" content="Weekly MLB recaps in plain language: power rankings, elite hitters, dominant pitchers and award-race movers — through the Baseball Lens color scale.">
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
    <p class="bl-sub">Weekly MLB recaps in plain language — through our color scale.</p>
    {cards}
  </div>
</body>
</html>
"""


def load_prev_ranking(date_iso):
    """Most recent snapshot strictly before date_iso → {team name: rank}."""
    if not os.path.isdir(SNAP_DIR):
        return {}
    older = sorted(f for f in os.listdir(SNAP_DIR)
                   if f.endswith(".json") and f[:-5] < date_iso)
    if not older:
        return {}
    with open(os.path.join(SNAP_DIR, older[-1])) as fh:
        data = json.load(fh)
    return {r["name"]: r["rank"] for r in data.get("power_ranking", [])}


def write_snapshot(date_iso, facts):
    os.makedirs(SNAP_DIR, exist_ok=True)
    snap = {
        "date": date_iso,
        "power_ranking": [{"name": t["name"], "rank": t["rank"]} for t in facts["power_all"]],
        # Broad baselines so next week can compute movers (HR surges, pitcher turnarounds, etc.)
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
    for fn in sorted(os.listdir(BLOG_DIR), reverse=True):
        if fn.endswith(".html") and fn != "index.html":
            d = fn.replace("weekly-", "").replace(".html", "")
            try:
                pretty = dt.date.fromisoformat(d).strftime("%B %-d, %Y")
            except ValueError:
                pretty = d
            cards.append(f'<a class="bl-card" href="{fn}"><h2>MLB Weekly — {pretty}</h2>'
                         f'<div class="bl-date">{pretty}</div></a>')
    with open(os.path.join(BLOG_DIR, "index.html"), "w") as fh:
        fh.write(INDEX_PAGE.format(site=SITE, cards="".join(cards)))


def rebuild_sitemap(date_iso):
    urls = [(f"{SITE}/", "1.0", "daily"), (f"{SITE}/blog/", "0.8", "weekly")]
    for fn in sorted(os.listdir(BLOG_DIR), reverse=True):
        if fn.endswith(".html") and fn != "index.html":
            urls.append((f"{SITE}/blog/{fn}", "0.7", "monthly"))
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
    args = ap.parse_args()

    load_env()
    date_iso = args.date
    pretty = dt.date.fromisoformat(date_iso).strftime("%B %-d, %Y")
    desc = ("MLB power rankings, elite hitters and dominant pitchers this week, "
            "seen through the Baseball Lens color scale.")

    facts = build_facts(args.season, load_prev_ranking(date_iso))
    narration = llm_narration(facts)
    title = (narration or {}).get("title") or f"MLB Weekly — {pretty}"
    body = render_prose(facts, narration)

    os.makedirs(BLOG_DIR, exist_ok=True)
    slug = f"weekly-{date_iso}.html"
    with open(os.path.join(BLOG_DIR, slug), "w") as fh:
        fh.write(PAGE.format(title=escape(title), desc=escape(desc),
                             canonical=f"{SITE}/blog/{slug}", site=SITE, rel="../",
                             datestr=pretty.upper(), body=body, style=STYLE))

    write_snapshot(date_iso, facts)
    rebuild_index()
    rebuild_sitemap(date_iso)
    print(f"Wrote blog/{slug}, blog/index.html, sitemap.xml, data/snapshots/{date_iso}.json")


if __name__ == "__main__":
    main()
