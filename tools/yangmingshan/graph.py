import pyarrow.parquet as pq, shapely.wkb as wkb, math, heapq, json, sys
T=pq.read_table('roads.parquet').to_pylist()
def nm(r): return (r['names'] or {}).get('primary') or ''
def d(a,b):
    R=6371000; la1,lo1,la2,lo2=map(math.radians,(a[1],a[0],b[1],b[0]))
    return 2*R*math.asin(math.sqrt(math.sin((la2-la1)/2)**2+math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2))
OK={'motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service'}
# nodes: connector ids; edges: sub-polylines between connectors
G={}; NODE={}
def add(u,v,pts,name):
    L=sum(d(pts[i],pts[i+1]) for i in range(len(pts)-1))
    G.setdefault(u,[]).append((v,L,pts,name)); G.setdefault(v,[]).append((u,L,pts[::-1],name))
for r in T:
    if r['class'] not in OK: continue
    g=list(wkb.loads(r['geometry']).coords); cs=sorted(r['connectors'] or [], key=lambda c:c['at'])
    if len(cs)<2: continue
    cum=[0]
    for i in range(len(g)-1): cum.append(cum[-1]+d(g[i],g[i+1]))
    tot=cum[-1] or 1
    def cut(a,b):
        sa,sb=a*tot,b*tot; out=[]
        for i in range(len(g)-1):
            if cum[i+1]<sa or cum[i]>sb: continue
            def ip(s):
                f=(s-cum[i])/((cum[i+1]-cum[i]) or 1); f=max(0,min(1,f))
                return (g[i][0]+(g[i+1][0]-g[i][0])*f, g[i][1]+(g[i+1][1]-g[i][1])*f)
            p0=ip(max(sa,cum[i])); p1=ip(min(sb,cum[i+1]))
            if not out: out.append(p0)
            out.append(p1)
        return out
    for a,b in zip(cs,cs[1:]):
        pts=cut(a['at'],b['at'])
        if len(pts)>=2:
            NODE[a['connector_id']]=pts[0]; NODE[b['connector_id']]=pts[-1]
            add(a['connector_id'],b['connector_id'],pts,nm(r))
def nearest(lat,lon):
    return min(NODE,key=lambda k:d(NODE[k],(lon,lat)))
def sp(s,t):
    dist={s:0}; prev={}; pq=[(0,s)]
    while pq:
        du,u=heapq.heappop(pq)
        if u==t: break
        if du>dist[u]: continue
        for v,L,pts,name in G.get(u,[]):
            if du+L<dist.get(v,1e18): dist[v]=du+L; prev[v]=(u,pts,name); heapq.heappush(pq,(du+L,v))
    path=[];names=[];u=t
    while u!=s:
        p,pts,name=prev[u]; path=pts[1:]+path if False else path; names.append(name); u=p
    # rebuild forward
    seq=[];u=t
    chain=[]
    while u!=s:
        p,pts,name=prev[u]; chain.append((pts,name)); u=p
    chain.reverse(); out=[chain[0][0][0]]; nl=[]
    for pts,name in chain:
        out+=pts[1:]
        if not nl or nl[-1][0]!=name: nl.append([name,0])
        nl[-1][1]+=sum(d(pts[i],pts[i+1]) for i in range(len(pts)-1))
    return dist[t],out,nl
