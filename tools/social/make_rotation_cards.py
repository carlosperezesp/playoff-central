#!/usr/bin/env python3
"""Build 'rotation report' social cards for the best rotations by FORM.
All 30 rotations are scanned; the current rotation is the 5 starters with the most
starts in the last 30 days (game logs, so post-deadline pickups count on their new
team), displayed most->least FORM, plus key injured starters. Stats colored by tier.
In-season trades are marked in purple: an arrow badge on the pitchers who came in,
a strip along the bottom for the starters who were traded away."""
import concurrent.futures as cf, datetime, json, re, subprocess, urllib.parse, urllib.request

API = "https://statsapi.mlb.com/api/v1"; SEASON = 2026
TOP_PER_LEAGUE = 6        # best rotations per league that get a card (ties included)
TRADE_SINCE = "2026-03-01"  # in-season moves only; winter signings are not marked
GONE_MIN_GS = 3           # a departure only counts if he was starting games
TODAY = datetime.date(2026, 8, 5)
RECENT_SINCE = (TODAY - datetime.timedelta(days=30)).isoformat()
EDITION = "The Lens · Aug 5, 2026"

BRIGHT = {"green":"#16a34a","lgreen":"#b1c882","yellow":"#ffc000","orange":"#ff8100","red":"#ff2200","gray":"#9aa0a6"}
TCOLOR = {"green":"#ffffff","lgreen":"#15351c","yellow":"#3a2c00","orange":"#ffffff","red":"#ffffff","gray":"#ffffff"}
PRIMARY = {108:"#BA0021",109:"#A71930",110:"#DF4601",111:"#BD3039",112:"#0E3386",113:"#C6011F",
  114:"#00385D",115:"#33006F",116:"#0C2340",117:"#002D62",118:"#004687",119:"#005A9C",120:"#AB0003",
  121:"#002D72",133:"#003831",134:"#FDB827",135:"#2F241D",136:"#0C2C56",137:"#FD5A1E",138:"#C41E3A",
  139:"#092C5C",140:"#003278",141:"#134A8E",142:"#002B5C",143:"#E81828",144:"#CE1141",145:"#27251F",
  146:"#00A3E0",147:"#003087",158:"#12284B"}
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
GLOG=urllib.parse.quote(f"stats(group=[pitching],type=gameLog,season={SEASON})")
HYD_STATS=urllib.parse.quote(f"stats(group=[pitching],type=season,season={SEASON})")

def recent_starts(pids):
    """{pid: (starts in the last 30 days, date of last start)} from game logs, so a
    pitcher traded at the deadline keeps the starts he made for his old team."""
    pids=[p for p in set(pids) if p]
    if not pids: return {}
    d=fetch(f"{API}/people?personIds={','.join(map(str,pids))}&hydrate={GLOG}")
    out={}
    for p in d.get("people",[]):
        n,last=0,""
        for blk in p.get("stats",[]):
            for sp in blk.get("splits",[]):
                if not int(sp.get("stat",{}).get("gamesStarted",0) or 0): continue
                dt=sp.get("date","")
                if dt>last: last=dt
                if dt>=RECENT_SINCE: n+=1
        out[p["id"]]=(n,last)
    return out

def scan(team):
    """Current rotation for one team: the 5 who have been taking the ball lately.
    A rotation member starts in most of his outings and is either established
    (5+ starts) or in the rotation right now (2+ starts in the last 30 days);
    a team that cannot field 5 is topped up by season innings (bullpen games)."""
    tid,tname=team
    act=fetch(f"{API}/teams/{tid}/roster?rosterType=active&season={SEASON}&hydrate={HYD}")
    pool=[]
    for p in act.get("roster",[]):
        st=pstat(p.get("person",{}))
        if not st: continue
        gs=int(st.get("gamesStarted",0) or 0); gp=int(st.get("gamesPitched",0) or 0)
        if gs>=1 and gp: pool.append(mkrow(p["person"],st)|{"ratio":gs/gp})
    rec=recent_starts([r["pid"] for r in pool])
    for r in pool: r["gs30"],r["last"]=rec.get(r["pid"],(0,""))
    starters=[r for r in pool if r["ratio"]>=0.5 and (r["gs"]>=5 or r["gs30"]>=2)]
    rot=sorted(starters,key=lambda r:(r["gs30"],r["last"]),reverse=True)[:5]
    if len(rot)<5:
        rest=sorted([r for r in pool if r not in rot],key=lambda r:r["ip"],reverse=True)
        rot+=rest[:5-len(rot)]
    rot=sorted(rot,key=lambda r:r["forma"],reverse=True)
    avgf=sum(r["forma"] for r in rot)/len(rot) if rot else 0
    return {"tid":tid,"name":tname,"starters":rot,"avg":round(avgf),"avgf":avgf}

TEAMS=fetch(f"{API}/teams?sportId=1&season={SEASON}")["teams"]
ABBR={t["id"]:t["abbreviation"] for t in TEAMS}
LEAGUE={t["id"]:t["league"]["id"] for t in TEAMS}

def standings():
    div={d["id"]:d["nameShort"] for d in fetch(f"{API}/divisions?sportId=1")["divisions"]}
    d=fetch(f"{API}/standings?leagueId=103,104&season={SEASON}&standingsTypes=regularSeason")
    out={}
    for rec in d.get("records",[]):
        dv=div.get(rec.get("division",{}).get("id"),"")
        for t in rec.get("teamRecords",[]):
            out[t["team"]["id"]]={"w":t["wins"],"l":t["losses"],
                                  "rank":int(t.get("divisionRank") or 0),"div":dv}
    return out

def ordinal(n): return f"{n}{'th' if 10<=n%100<20 else {1:'st',2:'nd',3:'rd'}.get(n%10,'th')}"

def moves(tid):
    """In-season trades/waiver claims: {pid: from-abbr} coming in, list of pids going out."""
    d=fetch(f"{API}/transactions?teamId={tid}&startDate={TRADE_SINCE}&endDate={TODAY}")
    came,left={},{}
    for x in d.get("transactions",[]):
        if x.get("typeCode") not in ("TR","CL") or not x.get("person"): continue
        to=(x.get("toTeam") or {}).get("id"); fr=(x.get("fromTeam") or {}).get("id")
        pid=x["person"]["id"]
        if to==tid and fr in ABBR and fr!=tid: came[pid]=ABBR[fr]
        elif fr==tid and to in ABBR and to!=tid: left[pid]=ABBR[to]
    return came,left

def gone_rows(left):
    """Departures worth naming: the ones who were making starts. -> display strings."""
    if not left: return []
    d=fetch(f"{API}/people?personIds={','.join(map(str,left))}&hydrate={HYD_STATS}")
    rows=[]
    for p in d.get("people",[]):
        st=pstat(p)
        if not st: continue
        gs=int(st.get("gamesStarted",0) or 0)
        if gs<GONE_MIN_GS: continue
        f=round(forma_score(float(st.get("era",99) or 99),float(st.get("whip",9) or 9)))
        rows.append({"name":p["fullName"],"gs":gs,"forma":f,
                     "to":left[p["id"]],"color":BRIGHT[tier(f)]})
    return sorted(rows,key=lambda r:r["gs"],reverse=True)[:3]

teams=[(t["id"],t["teamName"]) for t in TEAMS]
with cf.ThreadPoolExecutor(8) as ex:
    scans=list(ex.map(scan,teams))
scans.sort(key=lambda s:s["avgf"],reverse=True)
print("Rotation ranking (avg FORM of the current 5):")
for i,s in enumerate(scans,1):
    print(f"  {i:2}. {s['name']:<12} {s['avgf']:>5.1f}  " +
          "  ".join(f"{r['name'].split()[-1]} {r['forma']}" for r in s["starters"]))

# best TOP_PER_LEAGUE rotations in each league, keeping whoever ties the cutoff
picked=[]
for lg in (103,104):
    ls=[s for s in scans if LEAGUE.get(s["tid"])==lg]
    cut=ls[TOP_PER_LEAGUE-1]["avgf"]
    picked+=[s for s in ls if s["avgf"]>=cut]
STAND=standings()

out=[]
for sc in picked:
    tid,tname=sc["tid"],sc["name"]
    starters=sc["starters"]
    forty=fetch(f"{API}/teams/{tid}/roster?rosterType=40Man&season={SEASON}&hydrate={HYD}")
    act=fetch(f"{API}/teams/{tid}/roster?rosterType=active&season={SEASON}&hydrate={HYD}")
    active_ids={p["person"]["id"] for p in act.get("roster",[])}
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

    came,left=moves(tid)
    gone=gone_rows(left)
    if gone: inj=inj[:1]   # the departures strip takes the last row the card has room for
    for r in starters+inj: r["acq"]=came.get(r["pid"],"")

    avg=sc["avg"]; sd=STAND.get(tid,{})
    rec=f"{sd['w']}-{sd['l']} · {ordinal(sd['rank'])} {sd['div']}" if sd else ""
    c1=PRIMARY[tid]
    data={
      "kicker":"Rotation Report","team":tname,
      "subtitle":rec,
      "teamLogo":cap(tid),"cardColor":c1,"cardColor2":shade(c1),
      "avgForma":avg,"avgColor":BRIGHT[tier(avg)],
      "starters":[{"name":r["name"],"throws":r["throws"],"forma":r["forma"],"rookie":r["rookie"],
                   "color":r["color"],"tcolor":r["tcolor"],"pid":r["pid"],"acq":r["acq"],
                   "statline":statline(r,True)} for r in starters],
      "injured":[{"name":r["name"],"throws":r["throws"],"forma":r["forma"],"rookie":r["rookie"],
                  "color":r["color"],"tcolor":r["tcolor"],"pid":r["pid"],"status":r["status"],
                  "acq":r["acq"],"statline":statline(r,True)} for r in inj],
      "injLabel":"On the IL" if len(inj)>1 else "Key Injury",
      "gone":gone,
      "footer":"baseballlens.com","edition":EDITION}
    slug=tname.lower().replace(" ","")
    jf=f"rotation_{slug}.json"; pf=f"rotation_{slug}.png"
    json.dump(data,open(jf,"w"),ensure_ascii=False,indent=2)
    subprocess.run(["python3","render.py",jf,pf,"--template","template_rotation.html"],check=True)
    print(f"  -> {pf}  {tname} {rec}  avg {avg}  in:{[r['name'] for r in starters+inj if r['acq']]}"
          f"  out:{[g['name'] for g in gone]}")
    out.append(pf)
print("DONE:",out)
