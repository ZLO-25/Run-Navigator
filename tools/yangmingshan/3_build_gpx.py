import json, math, struct, numpy as np
exec(open('graph.py').read().split('OK=')[0])
L=json.load(open('legs.json'))
H=np.fromfile('N25E121.hgt','>i2').reshape(3601,3601).astype(float)
def ele(lon,lat):
    y=(26-lat)*3600; x=(lon-121)*3600; i=int(y); j=int(x); fy=y-i; fx=x-j
    v=H[i:i+2,j:j+2]; return (v[0,0]*(1-fx)*(1-fy)+v[0,1]*fx*(1-fy)+v[1,0]*(1-fx)*fy+v[1,1]*fx*fy)
def cut(pts,length):
    out=[pts[0]]; s=0
    for a,b in zip(pts,pts[1:]):
        dd=d(a,b)
        if s+dd>=length:
            f=(length-s)/dd; out.append((a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f)); return out
        out.append(b); s+=dd
    raise Exception('too short %d'%s)
def plen(p): return sum(d(a,b) for a,b in zip(p,p[1:]))
A,B,C=L['A'],L['B'],L['C']
LA=plen(A); MC=5516-60   # 半馬折返：馬槽橋前約 60 m
T1=(21097.5-2*(LA+MC))/2
T2=(42195-2*LA-2*T1)/2
print('A',round(LA),'T1',round(T1),'T2 from top',round(T2))
def course(t2):
    b=cut(B,T1); c=cut(C,t2)
    return A+b[1:]+b[::-1][1:]+c[1:]+c[::-1][1:]+A[::-1][1:]
for name,t2,dist in [('42k',T2,42195),('21k',MC,21097.5)]:
    P=course(t2); print(name, round(plen(P)))
    # resample 20 m and elevation
    cum=[0]
    for a,b in zip(P,P[1:]): cum.append(cum[-1]+d(a,b))
    out=[]; j=0; s=0; tot=cum[-1]
    while s<=tot:
        while j<len(P)-2 and cum[j+1]<s: j+=1
        seg=cum[j+1]-cum[j]; f=(s-cum[j])/seg if seg else 0
        lon=P[j][0]+(P[j+1][0]-P[j][0])*f; lat=P[j][1]+(P[j+1][1]-P[j][1])*f
        out.append((lat,lon,ele(lon,lat))); s+=20
    out.append((P[-1][1],P[-1][0],ele(*P[-1])))
    e=np.array([o[2] for o in out]); es=np.convolve(np.pad(e,5,mode='edge'),np.ones(11)/11,'valid')
    gain=sum(max(0,es[i+1]-es[i]) for i in range(len(es)-1))
    print(name,'pts',len(out),'ele',round(e.min()),round(e.max()),'gain',round(gain))
    with open(f'route-{name}.gpx','w') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Run-Navigator（Overture Maps 道路＋SRTM 海拔）" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>陽明山 %s</name><trkseg>\n'%name)
        for (la,lo,_),ev in zip(out,es): f.write(f'<trkpt lat="{la:.6f}" lon="{lo:.6f}"><ele>{ev:.1f}</ele></trkpt>\n')
        f.write('</trkseg></trk>\n</gpx>\n')
json.dump({'LA':LA,'T1':T1,'T2':T2,'MC':MC},open('keys.json','w'))
