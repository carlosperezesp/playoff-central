#!/usr/bin/env python3
"""One card with every postseason rotation: the 12 playoff clubs, four starters
each, every man wearing his regular-season FORM, clubs ranked by the average.

Who makes a club's four:
  1. anyone who has already started a playoff game for it (3+ IP: an opener
     is not a rotation) or is announced as a probable for one;
  2. then the best by FORM of the men who were starting down the stretch
     (starts in half their outings or more, one in the last two weeks);
  3. a club still short (bullpen games) takes whoever made the most starts in
     the last 30 days.
FORM is regular season only: October innings never move it."""
import concurrent.futures as cf, datetime, json, subprocess, urllib.parse, urllib.request

API = "https://statsapi.mlb.com/api/v1"; SEASON = 2026
TODAY = datetime.date.today()

BRIGHT = {"green":"#16a34a","lgreen":"#b1c882","yellow":"#ffc000","orange":"#ff8100","red":"#ff2200","gray":"#9aa0a6"}
TCOLOR = {"green":"#ffffff","lgreen":"#15351c","yellow":"#3a2c00","orange":"#ffffff","red":"#ffffff","gray":"#ffffff"}
PRIMARY = {108:"#BA0021",109:"#A71930",110:"#DF4601",111:"#BD3039",112:"#0E3386",113:"#C6011F",
  114:"#00385D",115:"#33006F",116:"#0C2340",117:"#002D62",118:"#004687",119:"#005A9C",120:"#AB0003",
  121:"#002D72",133:"#003831",134:"#FDB827",135:"#2F241D",136:"#0C2C56",137:"#FD5A1E",138:"#C41E3A",
  139:"#092C5C",140:"#003278",141:"#134A8E",142:"#002B5C",143:"#E81828",144:"#CE1141",145:"#27251F",
  146:"#00A3E0",147:"#003087",158:"#12284B"}

def fetch(u):
    req = urllib.request.Request(u, headers={"User-Agent": "BaseballLens/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r: return json.load(r)

def forma_score(era, whip):
    p = []
    if era is not None: p.append(max(0, min(100, (6.00 - era) / 4.5 * 100)))
    if whip is not None: p.append(max(0, min(100, (2.00 - whip) / 1.2 * 100)))
    return sum(p) / len(p) if p else 0.0

def tier(s):
    return "green" if s >= 75 else "lgreen" if s >= 60 else "yellow" if s >= 40 else "orange" if s >= 25 else "red"

def shade(hx, r=0.5):
    n = int(hx.lstrip("#"), 16); R = round(((n >> 16) & 255) * (1 - r)); G = round(((n >> 8) & 255) * (1 - r)); B = round((n & 255) * (1 - r))
    return f"#{(R << 16) + (G << 8) + B:06x}"

def outs(ip):
    w, _, f = str(ip or 0).partition("."); return int(w or 0) * 3 + int(f or 0)

def num(v):
    try: return float(v)
    except (TypeError, ValueError): return None

# Regular season, one line per man — for a traded pitcher the first split is his
# season across both clubs, the same number his circle shows everywhere else
SEASON_HYD = f"stats(group=[pitching],type=season,season={SEASON},gameType=R)"
def season_line(person):
    for b in person.get("stats", []):
        if b.get("group", {}).get("displayName") == "pitching" and b.get("splits"):
            return b["splits"][0]["stat"]
    return None

def row(person, st):
    f = forma_score(num(st.get("era")), num(st.get("whip")))
    t = tier(f)
    return {"pid": person["id"], "name": person["fullName"], "last_name": person.get("lastName") or person["fullName"].split()[-1],
            "throws": person.get("pitchHand", {}).get("code", ""), "forma": f, "color": BRIGHT[t], "tcolor": TCOLOR[t],
            "gs": int(st.get("gamesStarted", 0) or 0), "gp": int(st.get("gamesPitched", 0) or 0),
            "gs30": 0, "last": ""}

season = fetch(f"{API}/seasons/{SEASON}?sportId=1")["seasons"][0]
END = datetime.date.fromisoformat(season["regularSeasonEndDate"])
SINCE30, SINCE14 = (END - datetime.timedelta(days=30)).isoformat(), (END - datetime.timedelta(days=14)).isoformat()

# ── The field, the seeds, and who has started or is lined up to ────────────────
sched = fetch(f"{API}/schedule?sportId=1&season={SEASON}&gameType=F,D,L,W&hydrate=team,probablePitcher")
games = [g for d in sched.get("dates", []) for g in d["games"]]
teams, locks = {}, {}
for g in games:
    desc = g.get("description", "")
    lg = "AL" if desc.startswith("AL") else "NL" if desc.startswith("NL") else ""
    slot = "A" if "'A'" in desc else "B" if "'B'" in desc else ""
    for side in ("away", "home"):
        t = g["teams"][side]["team"]
        if t.get("placeholder"): continue
        info = teams.setdefault(t["id"], {"tid": t["id"], "name": t["teamName"], "lg": lg, "seed": None})
        # Game 1's home side is the higher seed: WC 'A' 3 v 6, WC 'B' 4 v 5, DS 'A' hosts 1, DS 'B' 2
        if g.get("seriesGameNumber") == 1 and g["gameType"] in ("F", "D") and info["seed"] is None:
            seeds = {("F", "A"): (6, 3), ("F", "B"): (5, 4), ("D", "A"): (None, 1), ("D", "B"): (None, 2)}
            s = seeds.get((g["gameType"], slot), (None, None))[side == "home"]
            if s: info["seed"] = s
        if g["status"]["abstractGameState"] == "Final":
            box = fetch(f"{API}/game/{g['gamePk']}/boxscore")["teams"][side]
            pid = box["pitchers"][0]
            if outs(box["players"][f"ID{pid}"]["stats"]["pitching"].get("inningsPitched")) >= 9:
                locks.setdefault(t["id"], []).append(pid)
        elif g["teams"][side].get("probablePitcher"):
            locks.setdefault(t["id"], []).append(g["teams"][side]["probablePitcher"]["id"])

ROSTER_HYD = urllib.parse.quote(f"person(pitchHand,{SEASON_HYD})")
LOG_HYD = urllib.parse.quote(f"stats(group=[pitching],type=gameLog,season={SEASON},gameType=R)")

def rotation(info):
    tid = info["tid"]
    pool = {}
    for p in fetch(f"{API}/teams/{tid}/roster?rosterType=active&season={SEASON}&hydrate={ROSTER_HYD}")["roster"]:
        st = season_line(p["person"])
        if st and int(st.get("gamesStarted", 0) or 0) >= 1: pool[p["person"]["id"]] = row(p["person"], st)
    missing = [pid for pid in locks.get(tid, []) if pid not in pool]
    if missing:
        for p in fetch(f"{API}/people?personIds={','.join(map(str, missing))}&hydrate={urllib.parse.quote(SEASON_HYD)}")["people"]:
            st = season_line(p) or {}
            pool[p["id"]] = row(p, st)
    for p in fetch(f"{API}/people?personIds={','.join(map(str, pool))}&hydrate={LOG_HYD}")["people"]:
        dates = sorted(sp["date"] for b in p.get("stats", []) for sp in b.get("splits", [])
                       if int(sp["stat"].get("gamesStarted", 0) or 0))
        pool[p["id"]]["gs30"] = sum(d >= SINCE30 for d in dates)
        pool[p["id"]]["last"] = dates[-1] if dates else ""

    four = []
    for pid in locks.get(tid, []):
        if pid in pool and pool[pid] not in four: four.append(pool[pid])
    stretch = [r for r in pool.values() if r not in four and r["gp"] and r["gs"] / r["gp"] >= 0.5 and r["last"] >= SINCE14]
    four += sorted(stretch, key=lambda r: r["forma"], reverse=True)[:max(0, 4 - len(four))]
    if len(four) < 4:
        rest = [r for r in pool.values() if r not in four]
        four += sorted(rest, key=lambda r: (r["gs30"], r["last"]), reverse=True)[:4 - len(four)]
    four = sorted(four[:4], key=lambda r: r["forma"], reverse=True)
    avg = sum(r["forma"] for r in four) / len(four)
    return info | {"four": four, "avgf": avg}

with cf.ThreadPoolExecutor(6) as ex:
    clubs = sorted(ex.map(rotation, teams.values()), key=lambda c: c["avgf"], reverse=True)

print("Postseason rotations by average FORM (regular season):")
for i, c in enumerate(clubs, 1):
    print(f"  {i:2}. {c['name']:<10} {c['lg']}{c['seed']}  {c['avgf']:5.1f}  " +
          "  ".join(f"{r['last_name']} {round(r['forma'])}" for r in c["four"]))

data = {
    "kicker": "Rotation Report",
    "title": "Postseason Rotations",
    "subtitle": "All 12 playoff teams · four starters each · ranked by average FORM",
    "footer": "baseballlens.com",
    "edition": f"Regular-season FORM · {TODAY.strftime('%b %-d, %Y')}",
    "clubs": [{
        "rank": i, "name": c["name"], "tag": f"{c['lg']} · {c['seed']}" if c["seed"] else c["lg"],
        "logo": f"https://www.mlbstatic.com/team-logos/team-cap-on-dark/{c['tid']}.svg",
        "c1": PRIMARY.get(c["tid"], "#12284b"), "c2": shade(PRIMARY.get(c["tid"], "#12284b")),
        "avg": round(c["avgf"]), "avgColor": BRIGHT[tier(c["avgf"])],
        "starters": [{"pid": r["pid"], "name": r["last_name"], "throws": r["throws"], "forma": round(r["forma"]),
                      "color": r["color"], "tcolor": r["tcolor"]} for r in c["four"]],
    } for i, c in enumerate(clubs, 1)],
}
json.dump(data, open("postseason_rotations.json", "w"), ensure_ascii=False, indent=2)
subprocess.run(["python3", "render.py", "postseason_rotations.json", "postseason_rotations.png",
                "--template", "template_postseason_rotations.html", "--height", "1350"], check=True)
