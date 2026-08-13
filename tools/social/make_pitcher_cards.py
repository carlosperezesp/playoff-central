#!/usr/bin/env python3
"""Build 'in focus' pitcher form cards: Tarik Skubal + the top 5 qualified SP by FORM."""
import datetime, json, math, subprocess, urllib.request

API="https://statsapi.mlb.com/api/v1"; SEASON=2026
EDITION=f"{SEASON} Season · {datetime.date.today():%b %-d}"
SKUBAL=669373
BRIGHT={"green":"#16a34a","lgreen":"#b1c882","yellow":"#ffc000","orange":"#ff8100","red":"#ff2200","gray":"#9ca3af"}
# primary from TEAM_META in js/app.js; accent = on-brand secondary (must stay light: it backs dark text)
TEAM={116:("#0C2340","#fa4616"), 158:("#12284B","#ffc52f"), 147:("#003087","#ffffff"),
      144:("#CE1141","#ffffff"), 119:("#005A9C","#ffffff"), 114:("#00385D","#ffffff")}

def fetch(u):
    req=urllib.request.Request(u,headers={"User-Agent":"BaseballLens/1.0"})
    with urllib.request.urlopen(req,timeout=25) as r: return json.load(r)
def forma(era,whip):
    p=[]
    if era is not None:p.append(max(0,min(100,(6-era)/4.5*100)))
    if whip is not None:p.append(max(0,min(100,(2-whip)/1.2*100)))
    return sum(p)/len(p) if p else 0
def tier(s): return "green" if s>=75 else "lgreen" if s>=60 else "yellow" if s>=40 else "orange" if s>=25 else "red"
def ipf(ip):
    ip=str(ip); return int(ip.split(".")[0])+int(ip.split(".")[1])/3 if "." in ip else float(ip or 0)
def shade(hx,r=0.45):
    n=int(hx.lstrip("#"),16); R=round(((n>>16)&255)*(1-r));G=round(((n>>8)&255)*(1-r));B=round((n&255)*(1-r))
    return f"#{(R<<16)+(G<<8)+B:06x}"
def cap(oid): return f"https://www.mlbstatic.com/team-logos/team-cap-on-dark/{oid}.svg"

# 1) rank qualified pitchers by forma
d=fetch(f"{API}/stats?stats=season&season={SEASON}&sportId=1&group=pitching&gameType=R"
        f"&playerPool=qualified&sortStat=earnedRunAverage&limit=60&hydrate=team(league)")
rows=[]
for s in d["stats"][0]["splits"]:
    st=s["stat"]; era=float(st.get("era",99)); whip=float(st.get("whip",9))
    rows.append({"id":s["player"]["id"],"name":s["player"]["fullName"],
                 "team":s.get("team",{}).get("name",""),"teamId":s.get("team",{}).get("id"),
                 "era":era,"whip":whip,"forma":forma(era,whip)})
rows.sort(key=lambda r:r["forma"],reverse=True)
picks=rows[:5]

# 2) Skubal goes first — as his own card if he didn't qualify into the top 5
if not any(p["id"]==SKUBAL for p in picks):
    sp=fetch(f"{API}/people/{SKUBAL}/stats?stats=season&season={SEASON}&group=pitching&gameType=R")["stats"][0]["splits"][-1]
    st=sp["stat"]; era=float(st["era"]); whip=float(st["whip"])
    picks=[{"id":SKUBAL,"name":"Tarik Skubal","team":sp["team"]["name"],"teamId":sp["team"]["id"],
            "era":era,"whip":whip,"forma":forma(era,whip)}]+picks

print("Cards:")
out_files=[]
for p in picks:
    pid=p["id"]; tid=p["teamId"]
    person=fetch(f"{API}/people/{pid}")["people"][0]
    num=person.get("primaryNumber",""); pos=person.get("primaryPosition",{}).get("abbreviation","SP")
    if pos=="P": pos="SP"
    gl=fetch(f"{API}/people/{pid}/stats?stats=gameLog&season={SEASON}&group=pitching&gameType=R")
    games=[]
    for g in gl["stats"][0]["splits"]:
        st=g["stat"]
        if not int(st.get("gamesStarted",0) or 0): continue   # dots are starts only
        ip=ipf(st.get("inningsPitched","0"))
        er=int(st.get("earnedRuns",0)or 0);h=int(st.get("hits",0)or 0);bb=int(st.get("baseOnBalls",0)or 0)
        col=BRIGHT[tier(forma(er*9/ip,(h+bb)/ip))] if ip>0 else BRIGHT["gray"]
        oid=g.get("opponent",{}).get("id"); m,dd=g["date"].split("-")[1:]
        games.append({"color":col,"logo":cap(oid),"date":f"{int(m)}/{int(dd)}"})
    cols=min(math.ceil(len(games)/2),14)   # keep the dots to two balanced rows
    c1,acc=TEAM.get(tid,("#22303a","#ffffff"))
    data={"mode":"pitcher_form","editable":False,
      "kicker":"In Focus",
      "photo":f"https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_426,q_auto:best/v1/people/{pid}/headshot/silo/current",
      "name":p["name"],"team":p["team"],"teamLogo":cap(tid),
      "number":str(num),"position":pos,
      "cardColor":c1,"cardColor2":shade(c1),"accent":acc,"statColor":BRIGHT[tier(p["forma"])],
      "strip":[{"key":"forma","label":"Form","value":str(round(p["forma"]))},
               {"label":"ERA","value":f"{p['era']:.2f}"},{"label":"WHIP","value":f"{p['whip']:.2f}"}],
      "gamesTitle":f"His {len(games)} starts in 2026",
      "games":games,"dotsWidth":cols*52+(cols-1)*16,
      "legend":[{"label":"Elite","color":"#16a34a"},{"label":"Above avg","color":"#b1c882"},
                {"label":"Average","color":"#ffc000"},{"label":"Below avg","color":"#ff8100"},{"label":"Poor","color":"#ff2200"}],
      "legendNote":"Each dot is one start, graded by that game's ERA & WHIP on the Baseball Lens scale.",
      "footer":"baseballlens.com","edition":EDITION}
    slug=p["name"].split()[-1].lower()
    jf=f"sp_{slug}.json"; pf=f"sp_{slug}.png"
    json.dump(data,open(jf,"w"),ensure_ascii=False,indent=2)
    subprocess.run(["python3","render.py",jf,pf,"--template","template_pitcher.html"],check=True)
    print(f"  -> {pf}  {p['name']} ({p['team']}) form {round(p['forma'])}, ERA {p['era']:.2f}, WHIP {p['whip']:.2f}, {len(games)} starts")
    out_files.append(pf)
print("DONE:",out_files)
