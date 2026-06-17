#!/usr/bin/env python3
"""Baseball Lens — weekly article generator (Phase 1: deterministic, no LLM).

Reads live MLB stats, computes the facts in the app's own color language
(elite/green … poor/red), and writes a static, crawlable HTML article plus a
/blog/ hub, an updated sitemap, and a dated snapshot for future week-over-week
diffs (color changes, race movers). The numbers are computed here so nothing is
hallucinated; the Phase-2 LLM layer will only rephrase these facts.

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

# ── Color scale (ported from getDiamondPlayerColor in js/app.js) ──────────
HEX = {"green": "#16a34a", "lgreen": "#7d9440", "yellow": "#c29200",
       "orange": "#e06f00", "red": "#e51f00", "gray": "#6b7280"}


def hitter_tier(ops):
    if not ops or ops <= 0: return ("gray", "no data")
    if ops >= 0.900: return ("green", "elite")
    if ops >= 0.750: return ("lgreen", "above average")
    if ops >= 0.600: return ("yellow", "average")
    if ops >= 0.450: return ("orange", "below average")
    return ("red", "poor")


def forma_score(era, whip):
    """FORMA base score 0-100 from ERA & WHIP (ERADCST/WHIP constants from app.js)."""
    parts = []
    if era is not None:
        parts.append(max(0, min(100, (6.00 - era) / (6.00 - 1.50) * 100)))
    if whip is not None:
        parts.append(max(0, min(100, (2.00 - whip) / (2.00 - 0.80) * 100)))
    return sum(parts) / len(parts) if parts else None


def pitcher_tier(score):
    if score is None or score < 0: return ("gray", "no data")
    if score >= 75: return ("green", "elite")
    if score >= 60: return ("lgreen", "above average")
    if score >= 40: return ("yellow", "average")
    if score >= 25: return ("orange", "below average")
    return ("red", "poor")


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
                "name": tr["team"]["name"],
                "wins": tr.get("wins", 0), "losses": tr.get("losses", 0),
                "pct": tr.get("winningPercentage", ""),
                "streak": tr.get("streak", {}).get("streakCode", "—"),
                "l10": f"{l10.get('wins', 0)}-{l10.get('losses', 0)}",
                "l10w": l10.get("wins", 0),
                "runDiff": tr.get("runDifferential", 0),
                "divRank": tr.get("divisionRank", ""),
            })
    return out


def get_leaders(category, group, season, limit=15):
    d = fetch(f"{API}/stats/leaders?leaderCategories={category}&season={season}"
              f"&sportId=1&statGroup={group}&limit={limit}&leaderGameTypes=R")
    out = []
    for cat in d.get("leagueLeaders", []):
        for l in cat.get("leaders", []):
            out.append({"name": l["person"]["fullName"], "value": l["value"],
                        "team": l.get("team", {}).get("name", "")})
    return out


def get_qualified_pitchers(season, limit=12):
    d = fetch(f"{API}/stats?stats=season&season={season}&sportId=1&group=pitching"
              f"&gameType=R&playerPool=qualified&sortStat=earnedRunAverage&limit={limit}&hydrate=team")
    out = []
    for s in d.get("stats", [{}])[0].get("splits", []):
        st = s["stat"]
        out.append({
            "name": s["player"]["fullName"], "team": s.get("team", {}).get("name", ""),
            "era": float(st.get("era", 99)), "whip": float(st.get("whip", 9)),
            "ip": st.get("inningsPitched", "0"),
        })
    return out


# ── Article assembly ────────────────────────────────────────────────────────
def chip(tier_key, label):
    c = HEX[tier_key]
    return (f'<span class="bl-chip" style="color:{c};background:{c}1a">{escape(label)}</span>')


def build_facts(season):
    teams = get_teams(season)
    # Hottest: win streaks first, then last-10, then run diff.
    def streak_val(t):
        s = t["streak"]
        n = int(s[1:]) if len(s) > 1 and s[1:].isdigit() else 0
        return n if s.startswith("W") else -n
    hottest = sorted(teams, key=lambda t: (streak_val(t), t["l10w"], t["runDiff"]), reverse=True)[:3]
    coldest = sorted(teams, key=lambda t: (streak_val(t), t["l10w"], t["runDiff"]))[:3]

    hitters = get_leaders("onBasePlusSlugging", "hitting", season, 12)
    for h in hitters:
        h["ops"] = float(h["value"])
        h["tier"], h["label"] = hitter_tier(h["ops"])
    elite_hitters = [h for h in hitters if h["tier"] == "green"][:6]

    pitchers = get_qualified_pitchers(season, 12)
    for p in pitchers:
        p["forma"] = forma_score(p["era"], p["whip"])
        p["tier"], p["label"] = pitcher_tier(p["forma"])
    aces = [p for p in pitchers if p["tier"] == "green"][:5]

    return {"hottest": hottest, "coldest": coldest,
            "elite_hitters": elite_hitters, "aces": aces}


def render_prose(f):
    parts = []

    # Hottest teams
    h = f["hottest"][0]
    lead = (f'<p>The hottest team in baseball right now is the <strong>{escape(h["name"])}</strong>, '
            f'riding a <strong>{escape(h["streak"])}</strong> streak with a {escape(h["l10"])} mark '
            f'over their last ten to sit at {h["wins"]}-{h["losses"]} '
            f'({"+" if h["runDiff"] >= 0 else ""}{h["runDiff"]} run differential).</p>')
    rows = "".join(
        f'<li><strong>{escape(t["name"])}</strong> — {escape(t["streak"])}, '
        f'last 10 {escape(t["l10"])}, {t["wins"]}-{t["losses"]}</li>' for t in f["hottest"])
    parts.append(f'<h2>Hottest teams</h2>{lead}<ul class="bl-list">{rows}</ul>')

    # Coldest teams
    rows = "".join(
        f'<li><strong>{escape(t["name"])}</strong> — {escape(t["streak"])}, '
        f'last 10 {escape(t["l10"])}, {t["wins"]}-{t["losses"]}</li>' for t in f["coldest"])
    parts.append('<h2>Cooling off</h2>'
                 '<p>The other end of the thermometer — teams trying to find their footing:</p>'
                 f'<ul class="bl-list">{rows}</ul>')

    # Elite hitters (green)
    if f["elite_hitters"]:
        rows = "".join(
            f'<li><strong>{escape(h["name"])}</strong> '
            f'<span class="bl-muted">({escape(h["team"])})</span> — '
            f'{h["ops"]:.3f} OPS {chip(h["tier"], "elite")}</li>' for h in f["elite_hitters"])
        parts.append('<h2>Swinging a green bat</h2>'
                     '<p>On the Baseball Lens scale, an OPS of .900 or better is '
                     '<span style="color:%s;font-weight:700">elite</span> — green. '
                     'These bats are scorching:</p>'
                     '<ul class="bl-list">%s</ul>' % (HEX["green"], rows))

    # Aces (green form)
    if f["aces"]:
        rows = "".join(
            f'<li><strong>{escape(p["name"])}</strong> '
            f'<span class="bl-muted">({escape(p["team"])})</span> — '
            f'{p["era"]:.2f} ERA, {p["whip"]:.2f} WHIP {chip(p["tier"], "elite form")}</li>'
            for p in f["aces"])
        parts.append('<h2>Green on the mound</h2>'
                     '<p>Form (our 0–100 pitcher score from ERA &amp; WHIP) puts these arms '
                     'firmly in the green:</p>'
                     f'<ul class="bl-list">{rows}</ul>')

    return "\n".join(parts)


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
<style>
  body {{ background: var(--bg); }}
  .bl-wrap {{ max-width: 720px; margin: 0 auto; padding: 0 20px 60px; }}
  .bl-top {{ display:flex; align-items:center; gap:10px; padding:18px 0; }}
  .bl-top a {{ display:flex; align-items:center; gap:10px; text-decoration:none; color:var(--text); }}
  .bl-top img {{ width:34px; height:34px; }}
  .bl-wordmark {{ font-family:'Bebas Neue'; font-size:22px; letter-spacing:2px; }}
  .bl-wordmark span {{ color: var(--accent); }}
  .bl-article {{ background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:30px 28px; }}
  .bl-article h1 {{ font-family:'Barlow Condensed','Inter',sans-serif; font-size:34px; line-height:1.05; letter-spacing:.5px; margin-bottom:8px; }}
  .bl-date {{ color:var(--muted); font-size:13px; font-weight:600; letter-spacing:.5px; text-transform:uppercase; margin-bottom:22px; }}
  .bl-article h2 {{ font-family:'Barlow Condensed','Inter',sans-serif; font-size:14px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--accent); margin:26px 0 10px; }}
  .bl-article p {{ font-size:15px; line-height:1.6; margin-bottom:6px; }}
  .bl-list {{ list-style:none; display:flex; flex-direction:column; gap:8px; margin:10px 0; }}
  .bl-list li {{ font-size:14.5px; line-height:1.45; padding-left:14px; position:relative; }}
  .bl-list li::before {{ content:''; position:absolute; left:0; top:9px; width:5px; height:5px; border-radius:50%; background:var(--accent); }}
  .bl-muted {{ color:var(--muted); font-weight:500; }}
  .bl-chip {{ font-size:10px; font-weight:800; letter-spacing:.3px; text-transform:uppercase; padding:2px 7px; border-radius:4px; margin-left:4px; }}
  .bl-foot {{ margin-top:24px; text-align:center; }}
  .bl-cta {{ display:inline-block; background:var(--accent-blue); color:#fff; text-decoration:none; font-weight:700; font-size:14px; padding:11px 20px; border-radius:999px; }}
  .bl-note {{ color:var(--muted); font-size:12px; margin-top:16px; text-align:center; }}
</style>
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
        "elite_hitters": [{"name": h["name"], "ops": h["ops"]} for h in facts["elite_hitters"]],
        "aces": [{"name": p["name"], "forma": round(p["forma"], 1)} for p in facts["aces"]],
    }
    with open(os.path.join(SNAP_DIR, f"{date_iso}.json"), "w") as fh:
        json.dump(snap, fh, indent=2)


def rebuild_index(date_iso):
    os.makedirs(BLOG_DIR, exist_ok=True)
    arts = []
    for fn in sorted(os.listdir(BLOG_DIR), reverse=True):
        if fn.endswith(".html") and fn != "index.html":
            d = fn.replace("weekly-", "").replace(".html", "")
            try:
                pretty = dt.date.fromisoformat(d).strftime("%B %-d, %Y")
            except ValueError:
                pretty = d
            arts.append((fn, d, pretty))
    cards = "".join(
        f'<a class="bl-card" href="{fn}"><h2>MLB Weekly — {pretty}</h2>'
        f'<div class="bl-date">{pretty}</div></a>' for fn, d, pretty in arts)
    with open(os.path.join(BLOG_DIR, "index.html"), "w") as fh:
        fh.write(INDEX_PAGE.format(site=SITE, cards=cards))


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
                             datestr=pretty.upper(), body=body))

    write_snapshot(date_iso, facts)
    rebuild_index(date_iso)
    rebuild_sitemap(date_iso)
    print(f"Wrote blog/{slug}, blog/index.html, sitemap.xml, data/snapshots/{date_iso}.json")


if __name__ == "__main__":
    main()
