#!/usr/bin/env python3
"""Build 'rotation report' social cards for the top-5 rotations by FORM.
Active rotation (top-5 starters by IP, incl. two-way), displayed most->least FORM,
plus key injured starters. Each stat colored by quality tier."""
import json, re, subprocess, urllib.request

API = "https://statsapi.mlb.com/api/v1"; SEASON = 2026
TEAMS = [(116, "Tigers"), (147, "Yankees"), (119, "Dodgers"), (158, "Brewers"), (144, "Braves")]

BRIGHT = {"green":"#16a34a","lgreen":"#b1c882","yellow":"#ffc000","orange":"#ff8100","red":"#ff2200","gray":"#9aa0a6"}
TCOLOR = {"green":"#ffffff","lgreen":"#15351c","yellow":"#3a2c00","orange":"#ffffff","red":"#ffffff","gray":"#ffffff"}
PRIMARY = {116:"#0C2340",147:"#003087",119:"#005A9C",158:"#12284B",144:"#CE1141"}
CURRENT_YEAR = 2026; ROOKIE_IP_LIMIT = 50
NON_ROOKIE_OVERRIDES = {808963}  # Roki Sasaki — exceeded service-time limit, not a rookie

def ip_to_outs(ip):
    if ip is None: return 0
    w,_,f = str(ip).partition("."); whole=int(w or 0); frac=int(f or 0)
    return whole*3 + (frac if frac in (1,2) else 0)

def rookie_map(pids):
    """Match the app's isRookieCareerEligible (pitcher): prior-season IP < 50,
    debuted in CURRENT_YEAR-1 or later, not in the manual override set."""
    pids=[p for p in set(pids) if p]
    if not pids: return {}
    d=fetch(f"{API}/people?personIds={','.join(map(str,pids))}&hydrate=stats(type=yearByYear,group=pitching)")
    out={}
    for p in d.get("people",[]):
        pid=p["id"]
        if pid in NON_ROOKIE_OVERRIDES: out[pid]=False; continue
        debut=int(p["mlbDebutDate"][:4]) if p.get("mlbDebutDate") else None
        prior_outs=0
        for g in p.get("stats",[]):
            if (g.get("group",{}).get("displayName","").lower()=="pitching"
                    and g.get("type",{}).get("displayName","").lower()=="yearbyyear"):
                for sp in g.get("splits",[]):
                    if int(sp.get("season",9999))<CURRENT_YEAR:
                        prior_outs+=ip_to_outs(sp.get("stat",{}).get("inningsPitched"))
        if debut and debut < CURRENT_YEAR-1: out[pid]=False
        else: out[pid]=(prior_outs/3) < ROOKIE_IP_LIMIT
    return out

def forma_score(era, whip):
    p=[]
    if era is not None: p.append(max(0,min(100,(6.00-era)/4.5*100)))
    if whip is not None: p.append(max(0,min(100,(2.00-whip)/1.2*100)))
    return sum(p)/len(p) if p else 0.0

def tier(s):
    if s is None or s<0: return "gray"
    return "green" if s>=75 else "lgreen" if s>=60 else "yellow" if s>=40 else "orange" if s>=25 else "red"

# per-stat color tiers (lower-is-better for ERA/WHIP; higher-is-better for the rest)
def _t(val, cuts, colors):
    for c, col in zip(cuts, colors):
        if val < c: return BRIGHT[col]
    return BRIGHT[colors[-1]]
def c_era(e):  return _t(e, [2.75,3.50,4.25,5.00], ["green","lgreen","yellow","orange","red"])
def c_whip(w): return _t(w, [1.05,1.15,1.30,1.45], ["green","lgreen","yellow","orange","red"])
def c_ip(ip):  # higher better
    return BRIGHT["green"] if ip>=90 else BRIGHT["lgreen"] if ip>=75 else BRIGHT["yellow"] if ip>=55 else BRIGHT["orange"] if ip>=35 else BRIGHT["red"]
def c_k(k):
    return BRIGHT["green"] if k>=100 else BRIGHT["lgreen"] if k>=80 else BRIGHT["yellow"] if k>=60 else BRIGHT["orange"] if k>=40 else BRIGHT["red"]
def c_rec(w,l):
    g=w+l
    if not g: return BRIGHT["gray"]
    p=w/g
    return BRIGHT["green"] if p>=.600 else BRIGHT["lgreen"] if p>=.500 else BRIGHT["yellow"] if p>=.400 else BRIGHT["orange"] if p>=.300 else BRIGHT["red"]

def shade(hx,r=0.5):
    n=int(hx.lstrip("#"),16); R=round(((n>>16)&255)*(1-r));G=round(((n>>8)&255)*(1-r));B=round((n&255)*(1-r))
    return f"#{(R<<16)+(G<<8)+B:06x}"

def fetch(u):
    req=urllib.request.Request(u,headers={"User-Agent":"BaseballLens/1.0"})
    with urllib.request.urlopen(req,timeout=30) as r: return json.load(r)

def pstat(person):
    for blk in person.get("stats",[]):
        if blk.get("group",{}).get("displayName")=="pitching":
            sp=blk.get("splits",[])
            if sp: return sp[0].get("stat",{})
    return None

def cap(tid): return f"https://www.mlbstatic.com/team-logos/team-cap-on-dark/{tid}.svg"

def mkrow(person, st):
    era=float(st.get("era",99) or 99); whip=float(st.get("whip",9) or 9)
    f=forma_score(era,whip); t=tier(f)
    return {"pid":person["id"],"name":person.get("fullName","?"),
            "throws":person.get("pitchHand",{}).get("code","?"),
            "forma":round(f),"color":BRIGHT[t],"tcolor":TCOLOR[t],
            "era_s":st.get("era","-"),"whip_s":st.get("whip","-"),"ip_s":st.get("inningsPitched","-"),
            "era":era,"whip":whip,
            "ip":float(st.get("inningsPitched",0) or 0),"gs":int(st.get("gamesStarted",0) or 0),
            "w":int(st.get("wins",0) or 0),"l":int(st.get("losses",0) or 0),"so":int(st.get("strikeOuts",0) or 0)}

def statline(r, full=True):
    line=[{"v":r["era_s"],"l":"ERA","c":c_era(r["era"])},
          {"v":r["whip_s"],"l":"WHIP","c":c_whip(r["whip"])}]
    if full:
        line.append({"v":f"{r['w']}-{r['l']}","l":"","c":c_rec(r["w"],r["l"])})
    line.append({"v":r["ip_s"],"l":"IP","c":c_ip(r["ip"])})
    if full:
        line.append({"v":str(r["so"]),"l":"K","c":c_k(r["so"])})
    return line

HYD=f"person(pitchHand,stats(group=[pitching],type=season,season={SEASON}))"
out=[]
for tid,tname in TEAMS:
    act=fetch(f"{API}/teams/{tid}/roster?rosterType=active&season={SEASON}&hydrate={HYD}")
    forty=fetch(f"{API}/teams/{tid}/roster?rosterType=40Man&season={SEASON}&hydrate={HYD}")
    active_ids={p["person"]["id"] for p in act.get("roster",[])}
    starters=[]
    for p in act.get("roster",[]):
        st=pstat(p.get("person",{}))
        if not st: continue
        gs=int(st.get("gamesStarted",0) or 0); gp=int(st.get("gamesPitched",0) or 0)
        if gs>=5 and gp and gs/gp>=0.5: starters.append(mkrow(p["person"],st))
    # pick the 5 rotation members by innings, then DISPLAY most->least FORM
    starters=sorted(starters,key=lambda r:r["ip"],reverse=True)[:5]
    starters=sorted(starters,key=lambda r:r["forma"],reverse=True)
    inj=[]
    for p in forty.get("roster",[]):
        if p["person"]["id"] in active_ids: continue
        status=(p.get("status",{}) or {}).get("description","")
        if "injured" not in status.lower(): continue
        st=pstat(p.get("person",{}))
        if not st or int(st.get("gamesStarted",0) or 0)<5: continue
        r=mkrow(p["person"],st)
        m=re.search(r"(\d+)\s*-?\s*Day",status,re.I); r["status"]=f"{m.group(1)}-DAY IL" if m else "IL"
        inj.append(r)
    inj=sorted(inj,key=lambda r:(r["gs"],r["forma"]),reverse=True)[:2]

    rmap=rookie_map([r["pid"] for r in starters+inj])
    for r in starters+inj: r["rookie"]=rmap.get(r["pid"],False)

    avg=round(sum(r["forma"] for r in starters)/len(starters)) if starters else 0
    c1=PRIMARY[tid]
    data={
      "kicker":"Rotation Report","team":tname,
      "subtitle":f"Top-5 starter form · avg {avg}",
      "teamLogo":cap(tid),"cardColor":c1,"cardColor2":shade(c1),
      "avgForma":avg,"avgColor":BRIGHT[tier(avg)],
      "starters":[{"name":r["name"],"throws":r["throws"],"forma":r["forma"],"rookie":r["rookie"],
                   "color":r["color"],"tcolor":r["tcolor"],"pid":r["pid"],
                   "statline":statline(r,True)} for r in starters],
      "injured":[{"name":r["name"],"throws":r["throws"],"forma":r["forma"],"rookie":r["rookie"],
                  "color":r["color"],"tcolor":r["tcolor"],"pid":r["pid"],"status":r["status"],
                  "statline":statline(r,True)} for r in inj],
      "injLabel":"On the IL" if len(inj)>1 else "Key Injury",
      "footer":"baseballlens.com","edition":"The Lens · Jun 22, 2026"}
    slug=tname.lower()
    jf=f"rotation_{slug}.json"; pf=f"rotation_{slug}.png"
    json.dump(data,open(jf,"w"),ensure_ascii=False,indent=2)
    subprocess.run(["python3","render.py",jf,pf,"--template","template_rotation.html"],check=True)
    print(f"  -> {pf}  {tname} avg {avg}  forma:{[r['forma'] for r in starters]}  injured:{[r['name'] for r in inj]}")
    out.append(pf)
print("DONE:",out)
