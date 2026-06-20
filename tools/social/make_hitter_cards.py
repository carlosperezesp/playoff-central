import json, re, urllib.request, subprocess
API="https://statsapi.mlb.com/api/v1"; SEASON=2026
def fetch(u):
    req=urllib.request.Request(u,headers={"User-Agent":"BaseballLens/1.0"})
    with urllib.request.urlopen(req,timeout=25) as r: return json.load(r)

BRIGHT={"green":"#16a34a","lgreen":"#b1c882","yellow":"#ffc000","orange":"#ff8100","red":"#ff2200"}

# per-game OPS, computed from that game's raw counting stats (the gameLog's own
# obp/slg/ops fields are season-to-date, NOT single-game).
def game_ops(st):
    ab=int(st.get("atBats",0) or 0); h=int(st.get("hits",0) or 0)
    bb=int(st.get("baseOnBalls",0) or 0); hbp=int(st.get("hitByPitch",0) or 0)
    sf=int(st.get("sacFlies",0) or 0); tb=int(st.get("totalBases",0) or 0)
    den=ab+bb+hbp+sf
    obp=(h+bb+hbp)/den if den else 0
    slg=tb/ab if ab else 0
    return obp+slg

# the user's day-of OPS scale
def day_tier(ops):
    if ops==0: return "red"          # .000 — the 0-fer, a ghost game
    if ops<0.5: return "orange"      # up to .499 — quiet
    if ops<1.0: return "yellow"      # .500–.999 — solid
    if ops<1.5: return "lgreen"      # 1.000–1.499 — big day
    return "green"                   # 1.500+ — demolished

def fmt3(x):  # baseball rate, no leading zero (.324, 1.065)
    s=f"{x:.3f}"
    return s[1:] if s.startswith("0.") else s

def shade(hx,r=0.45):
    n=int(hx.lstrip("#"),16); R=round(((n>>16)&255)*(1-r));G=round(((n>>8)&255)*(1-r));B=round((n&255)*(1-r))
    return f"#{(R<<16)+(G<<8)+B:06x}"
def cap(oid): return f"https://www.mlbstatic.com/team-logos/team-cap-on-dark/{oid}.svg"

# primary team color (from the site's TEAM_META); accent = on-brand secondary, white otherwise
PRIMARY={108:"#BA0021",109:"#A71930",110:"#DF4601",111:"#BD3039",112:"#0E3386",113:"#C6011F",
  114:"#00385D",115:"#33006F",116:"#0C2340",117:"#002D62",118:"#004687",119:"#005A9C",120:"#AB0003",
  121:"#002D72",133:"#003831",134:"#FDB827",135:"#2F241D",136:"#0C2C56",137:"#FD5A1E",138:"#C41E3A",
  139:"#092C5C",140:"#003278",141:"#134A8E",142:"#002B5C",143:"#E81828",144:"#CE1141",145:"#27251F",
  146:"#00A3E0",147:"#003087"}
ACCENT={117:"#EB6E1F",133:"#EFB21E",121:"#FF5910",110:"#000000",134:"#27251F",146:"#000000"}

# 1) rank qualified hitters by OPS
d=fetch(f"{API}/stats?stats=season&season={SEASON}&sportId=1&group=hitting&gameType=R"
        f"&playerPool=qualified&sortStat=onBasePlusSlugging&limit=12&hydrate=team(league)")
rows=[]
for s in d["stats"][0]["splits"]:
    st=s["stat"]
    rows.append({"id":s["player"]["id"],"name":s["player"]["fullName"],
                 "team":s.get("team",{}).get("name",""),"teamId":s.get("team",{}).get("id"),
                 "ops":float(st.get("ops",0) or 0),"hr":int(st.get("homeRuns",0) or 0),
                 "avg":float(st.get("avg",0) or 0)})
rows.sort(key=lambda r:r["ops"],reverse=True)
print("Top 5 by OPS:")
for i,r in enumerate(rows[:5],1): print(f"  #{i} {r['name']} ({r['team']}) OPS {fmt3(r['ops'])}")

out_files=[]
for rank in range(1,6):
    p=rows[rank-1]; pid=p["id"]; tid=p["teamId"]
    person=fetch(f"{API}/people/{pid}")["people"][0]
    num=person.get("primaryNumber",""); pos=person.get("primaryPosition",{}).get("abbreviation","DH")
    gl=fetch(f"{API}/people/{pid}/stats?stats=gameLog&season={SEASON}&group=hitting&gameType=R")
    games=[]; tally={"green":0,"lgreen":0,"yellow":0,"orange":0,"red":0}
    for g in gl["stats"][0]["splits"]:
        st=g["stat"]
        if int(st.get("plateAppearances",0) or 0)==0: continue   # didn't bat (def/PR cameo)
        t=day_tier(game_ops(st)); tally[t]+=1
        m,dd=g["date"].split("-")[1:]
        games.append({"color":BRIGHT[t],"date":f"{int(m)}/{int(dd)}"})
    c1=PRIMARY.get(tid,"#22303a"); acc=ACCENT.get(tid,"#ffffff")
    data={"mode":"hitter_day","editable":False,
      "kicker":"In Focus",
      "photo":f"https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_426,q_auto:best/v1/people/{pid}/headshot/silo/current",
      "name":p["name"],"team":p["team"],"teamLogo":cap(tid),
      "number":str(num),"position":pos,
      "cardColor":c1,"cardColor2":shade(c1),"accent":acc,"statColor":BRIGHT["green"],
      "strip":[{"key":"ops","label":"OPS","value":fmt3(p["ops"])},
               {"label":"HR","value":str(p["hr"])},{"label":"AVG","value":fmt3(p["avg"])}],
      "gamesTitle":f"His {len(games)} games in 2026",
      "games":games,
      "legend":[{"label":"Demolished","color":"#16a34a"},{"label":"Big day","color":"#b1c882"},
                {"label":"Solid","color":"#ffc000"},{"label":"Quiet","color":"#ff8100"},{"label":"Ghost","color":"#ff2200"}],
      "legendNote":"Each dot is one game by that day's OPS: green **1.500+**, light-green **1.000+**, yellow **.500+**, orange **under .500**, red a **.000** ghost game.",
      "footer":"baseballlens.com","edition":"2026 Season"}
    slug=re.sub(r"[^a-z0-9]","",p["name"].split()[-1].lower())
    jf=f"hit_{slug}.json"; pf=f"hit_{slug}.png"
    json.dump(data,open(jf,"w"),ensure_ascii=False,indent=2)
    subprocess.run(["python3","render.py",jf,pf,"--template","template_hitter.html"],check=True)
    print(f"  -> {pf}  ({p['name']}, OPS {fmt3(p['ops'])}, {len(games)} games | "
          f"G{tally['green']} LG{tally['lgreen']} Y{tally['yellow']} O{tally['orange']} R{tally['red']})")
    out_files.append(pf)
print("DONE:",out_files)
