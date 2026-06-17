#!/usr/bin/env python3
"""Baseball Lens — weekly article generator (Phase 1: deterministic, no LLM).

Reads live MLB stats, computes the facts in the app's own color language
(elite/green … poor/red), and writes a static, crawlable HTML article that uses
the app's visual vocabulary — colored player circles (like the diamond), team
logos, the shimmer for historic seasons — plus a /blog/ hub, an updated sitemap,
and a dated snapshot for future week-over-week diffs (color changes, race
movers). The numbers are computed here so nothing is hallucinated; the Phase-2
LLM layer will only rephrase these facts.

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
# BRIGHT = circle backgrounds (match the diamond); TEXT = readable on white.
BRIGHT = {"green": "#16a34a", "lgreen": "#b1c882", "yellow": "#ffc000",
          "orange": "#ff8100", "red": "#ff2200", "gray": "#9ca3af"}
TEXT = {"green": "#16a34a", "lgreen": "#7d9440", "yellow": "#c29200",
        "orange": "#e06f00", "red": "#e51f00", "gray": "#6b7280"}
TIER_LABEL = {"green": "elite", "lgreen": "above avg", "yellow": "average",
              "orange": "below avg", "red": "poor", "gray": "no data"}


def circle_text_color(tier):
    # Matches diamondTextColor(): white on green/red/orange, dark otherwise.
    return "#fff" if tier in ("green", "red", "orange") else "#1a1209"


def initials(name):
    parts = [p for p in name.replace(".", "").split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


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
            out.append({
                "id": tr["team"]["id"], "name": tr["team"]["name"],
                "wins": tr.get("wins", 0), "losses": tr.get("losses", 0),
                "streak": tr.get("streak", {}).get("streakCode", "—"),
                "l10": f"{l10.get('wins', 0)}-{l10.get('losses', 0)}",
                "l10w": l10.get("wins", 0),
                "runDiff": tr.get("runDifferential", 0),
                "divRank": tr.get("divisionRank", ""),
            })
    return out


def get_hitters(season, limit=12):
    d = fetch(f"{API}/stats/leaders?leaderCategories=onBasePlusSlugging&season={season}"
              f"&sportId=1&statGroup=hitting&limit={limit}&leaderGameTypes=R")
    out = []
    for cat in d.get("leagueLeaders", []):
        for l in cat.get("leaders", []):
            ops = float(l["value"])
            out.append({"name": l["person"]["fullName"], "ops": ops,
                        "team": l.get("team", {}).get("name", ""),
                        "tier": hitter_tier(ops), "historic": ops >= 1.000})
    return out


def get_pitchers(season, limit=12):
    d = fetch(f"{API}/stats?stats=season&season={season}&sportId=1&group=pitching"
              f"&gameType=R&playerPool=qualified&sortStat=earnedRunAverage&limit={limit}&hydrate=team")
    out = []
    for s in d.get("stats", [{}])[0].get("splits", []):
        st = s["stat"]
        era, whip = float(st.get("era", 99)), float(st.get("whip", 9))
        forma = forma_score(era, whip)
        out.append({"name": s["player"]["fullName"],
                    "team": s.get("team", {}).get("name", ""),
                    "era": era, "whip": whip, "forma": forma,
                    "tier": pitcher_tier(forma),
                    "historic": era <= 2.00 and whip <= 1.00})
    return out


# ── HTML pieces ─────────────────────────────────────────────────────────────
def logo_url(team_id):
    return f"https://www.mlbstatic.com/team-logos/{team_id}.svg"


def player_circle(name, tier, historic=False):
    cls = "bl-circle shiny" if historic else "bl-circle"
    return (f'<span class="{cls}" style="background:{BRIGHT[tier]};color:{circle_text_color(tier)}">'
            f'{escape(initials(name))}</span>')


def chip(tier, label):
    return f'<span class="bl-chip" style="color:{TEXT[tier]};background:{TEXT[tier]}1a">{escape(label)}</span>'


def team_row(t, hot):
    accent = TEXT["green"] if hot else TEXT["red"]
    return (f'<li class="bl-team">'
            f'<img class="bl-team-logo" src="{logo_url(t["id"])}" alt="" loading="lazy">'
            f'<span class="bl-team-info"><strong>{escape(t["name"])}</strong>'
            f'<span class="bl-muted"> · {t["wins"]}-{t["losses"]}, last 10 {escape(t["l10"])}</span></span>'
            f'<span class="bl-streak" style="color:{accent}">{escape(t["streak"])}</span></li>')


def hitter_row(h):
    star = ' <span class="bl-shimmer-tag">historic</span>' if h["historic"] else ""
    return (f'<li class="bl-player">{player_circle(h["name"], h["tier"], h["historic"])}'
            f'<span class="bl-player-info"><strong>{escape(h["name"])}</strong>'
            f'<span class="bl-muted">{escape(h["team"])}</span></span>'
            f'<span class="bl-stat" style="color:{TEXT[h["tier"]]}">{h["ops"]:.3f}<small>OPS</small></span>'
            f'{chip(h["tier"], TIER_LABEL[h["tier"]])}{star}</li>')


def pitcher_row(p):
    star = ' <span class="bl-shimmer-tag">historic</span>' if p["historic"] else ""
    return (f'<li class="bl-player">{player_circle(p["name"], p["tier"], p["historic"])}'
            f'<span class="bl-player-info"><strong>{escape(p["name"])}</strong>'
            f'<span class="bl-muted">{escape(p["team"])}</span></span>'
            f'<span class="bl-stat" style="color:{TEXT[p["tier"]]}">{p["era"]:.2f}<small>ERA</small></span>'
            f'{chip(p["tier"], TIER_LABEL[p["tier"]])}{star}</li>')


def build_facts(season):
    teams = get_teams(season)

    def streak_val(t):
        s = t["streak"]
        n = int(s[1:]) if len(s) > 1 and s[1:].isdigit() else 0
        return n if s.startswith("W") else -n

    hottest = sorted(teams, key=lambda t: (streak_val(t), t["l10w"], t["runDiff"]), reverse=True)[:3]
    coldest = sorted(teams, key=lambda t: (streak_val(t), t["l10w"], t["runDiff"]))[:3]
    elite_hitters = [h for h in get_hitters(season) if h["tier"] == "green"][:6]
    aces = [p for p in get_pitchers(season) if p["tier"] == "green"][:5]
    return {"hottest": hottest, "coldest": coldest,
            "elite_hitters": elite_hitters, "aces": aces}


def render_prose(f):
    parts = []
    h = f["hottest"][0]
    lead = (f'<p>The hottest team in baseball right now is the <strong>{escape(h["name"])}</strong>, '
            f'riding a <strong>{escape(h["streak"])}</strong> streak with a {escape(h["l10"])} mark '
            f'over their last ten ({"+" if h["runDiff"] >= 0 else ""}{h["runDiff"]} run differential).</p>')
    parts.append('<h2>Hottest teams</h2>' + lead +
                 '<ul class="bl-list">' + "".join(team_row(t, True) for t in f["hottest"]) + '</ul>')

    parts.append('<h2>Cooling off</h2>'
                 '<p>The other end of the thermometer — teams trying to find their footing:</p>'
                 '<ul class="bl-list">' + "".join(team_row(t, False) for t in f["coldest"]) + '</ul>')

    if f["elite_hitters"]:
        parts.append('<h2>Swinging a green bat</h2>'
                     '<p>On the Baseball Lens scale, an OPS of .900 or better is '
                     f'<span style="color:{TEXT["green"]};font-weight:700">elite</span> — green. '
                     'A shimmer means a historic pace (OPS ≥ 1.000):</p>'
                     '<ul class="bl-list">' + "".join(hitter_row(h) for h in f["elite_hitters"]) + '</ul>')

    if f["aces"]:
        parts.append('<h2>Green on the mound</h2>'
                     '<p>Form — our 0–100 pitcher score from ERA &amp; WHIP — puts these arms firmly '
                     'in the green. A shimmer means a historic pace (ERA ≤ 2.00 &amp; WHIP ≤ 1.00):</p>'
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
  .bl-list { list-style:none; display:flex; flex-direction:column; gap:10px; margin:14px 0; }
  .bl-muted { color:var(--muted); font-weight:500; }

  /* Player rows — circle + name + stat + tier chip (the app's visual language) */
  .bl-player, .bl-team { display:flex; align-items:center; gap:12px; }
  .bl-circle {
    position:relative; width:38px; height:38px; border-radius:50%; flex-shrink:0;
    display:inline-flex; align-items:center; justify-content:center;
    font-family:'Inter',sans-serif; font-weight:800; font-size:12px;
    border:2.5px solid rgba(255,255,255,.85); box-shadow:0 3px 9px rgba(22,28,39,.15);
  }
  .bl-player-info, .bl-team-info { display:flex; flex-direction:column; line-height:1.25; flex:1; min-width:0; }
  .bl-player-info strong, .bl-team-info strong { font-size:14.5px; }
  .bl-player-info .bl-muted, .bl-team-info .bl-muted { font-size:12.5px; }
  .bl-stat { font-weight:800; font-size:15px; display:flex; align-items:baseline; gap:3px; flex-shrink:0; }
  .bl-stat small { font-size:9px; font-weight:700; letter-spacing:.5px; opacity:.8; }
  .bl-chip { font-size:9px; font-weight:800; letter-spacing:.3px; text-transform:uppercase; padding:2px 7px; border-radius:4px; flex-shrink:0; }
  .bl-shimmer-tag { font-size:9px; font-weight:800; letter-spacing:.3px; text-transform:uppercase; color:#b8860b; }

  /* Team rows */
  .bl-team-logo { width:30px; height:30px; object-fit:contain; flex-shrink:0; }
  .bl-streak { font-family:'Barlow Condensed','Inter',sans-serif; font-weight:800; font-size:16px; flex-shrink:0; }

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
      <p class="bl-note">Stats via the MLB Stats API. Colors and form scores are Baseball Lens's own scale.</p>
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
<meta name="description" content="Weekly MLB recaps in plain language: hottest and coldest teams, elite hitters, dominant pitchers, and award-race movers — through the Baseball Lens color scale.">
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


def write_snapshot(date_iso, facts):
    os.makedirs(SNAP_DIR, exist_ok=True)
    snap = {
        "date": date_iso,
        "teams": [{"name": t["name"], "wins": t["wins"], "losses": t["losses"],
                   "streak": t["streak"], "l10": t["l10"], "divRank": t["divRank"]}
                  for t in facts["hottest"] + facts["coldest"]],
        "elite_hitters": [{"name": h["name"], "ops": h["ops"], "tier": h["tier"]}
                          for h in facts["elite_hitters"]],
        "aces": [{"name": p["name"], "forma": round(p["forma"], 1), "tier": p["tier"]}
                 for p in facts["aces"]],
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

    date_iso = args.date
    pretty = dt.date.fromisoformat(date_iso).strftime("%B %-d, %Y")
    title = f"MLB Weekly — {pretty}"
    desc = ("Hottest and coldest MLB teams, elite hitters and dominant pitchers this week, "
            "seen through the Baseball Lens color scale.")

    facts = build_facts(args.season)
    body = render_prose(facts)

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
