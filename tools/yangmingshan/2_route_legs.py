exec(open('graph.py').read())
N=lambda a,b: nearest(a,b)
top=N(25.1676,121.5631); S=N(25.1503,121.5512); qtg=N(25.1671,121.5742); zh=N(25.1776,121.5572); cg=N(25.2205,121.6150)
L1,p1,n1=sp(S,top); L2,p2,n2=sp(top,zh); L3,p3,n3=sp(zh,cg); Lq,pq_,nq=sp(top,qtg)
print([(n,round(l)) for n,l in n3])
print('qtg',[(n,round(l)) for n,l in nq])
import pyarrow.parquet as pq
PL=[((r['names'] or {}).get('primary') or '', r['bbox']['ymin'], r['bbox']['xmin']) for r in pq.read_table('places.parquet').to_pylist()]
path=p2+p3[1:]
cum=[0]
for i in range(len(path)-1): cum.append(cum[-1]+d(path[i],path[i+1]))
for key in ['小油坑','馬槽','七股','大油坑','八煙','三重橋','重光','竹子湖站','冷水坑','中湖','林口','磺溪','溫泉']:
    best=None
    for n,la,lo in PL:
        if key in n:
            i=min(range(len(path)),key=lambda i:d(path[i],(lo,la)))
            dd=d(path[i],(lo,la))
            if dd<250 and (best is None or dd<best[0]): best=(dd,n,cum[i])
    print(key,best and (round(best[0]),best[1],round(best[2])))
json.dump({'A':p1,'B':pq_,'C':path},open('legs.json','w'))
print(round(L1),round(Lq),round(L2+L3))
