import json, math, sys
from PIL import Image, ImageDraw, ImageFont
import pyarrow.parquet as pq, shapely.wkb as wkb
FONT='/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
import glob; FONT=(glob.glob('/usr/share/fonts/**/wqy-zenhei.ttc',recursive=True) or [FONT])[0]
f=lambda s:ImageFont.truetype(FONT,s)
ROOT='/home/claude/run-navigator/app/src/main/assets/races/'
roads=pq.read_table('/tmp/claude-0/ym/roads.parquet').to_pylist()
COL={'up3':(200,40,40),'up2':(232,100,80),'up1':(240,165,160),'flat':(110,118,125),'dn1':(160,200,240),'dn2':(70,140,220),'dn3':(30,80,170)}
def gk(g): return 'up3' if g>=7 else 'up2' if g>=4 else 'up1' if g>=2 else 'dn3' if g<=-7 else 'dn2' if g<=-4 else 'dn1' if g<=-2 else 'flat'
def draw(rid, title, sub):
    r=json.load(open(ROOT+rid+'/race.json')); rt=json.load(open(ROOT+rid+'/route.json'))
    lat,lon,el=rt['lat'],rt['lon'],rt['elev']; N=len(lat); st=rt['total_m']/(N-1)
    la0,la1,lo0,lo1=min(lat),max(lat),min(lon),max(lon)
    cx=math.cos(math.radians((la0+la1)/2))
    W,H=1400,1200; pad=120; top=170
    sx=(W-2*pad)/((lo1-lo0)*cx); sy=(H-top-pad)/(la1-la0); s=min(sx,sy)
    ox=(W-(lo1-lo0)*cx*s)/2; oy=top+((H-top-pad)-(la1-la0)*s)/2
    P=lambda la,lo:(ox+(lo-lo0)*cx*s, oy+(la1-la)*s)
    im=Image.new('RGBA',(W,H),(250,250,248,255)); dr=ImageDraw.Draw(im)
    for rd in roads:
        if rd['class'] not in ('primary','secondary','tertiary','unclassified','residential','trunk'): continue
        g=list(wkb.loads(rd['geometry']).coords)
        pts=[P(y,x) for x,y in g]
        if all(not(0<=p[0]<=W and top-40<=p[1]<=H) for p in pts): continue
        dr.line(pts,fill=(222,222,218),width=3 if rd['class'] in('primary','secondary') else 2)
    # route colored (outbound half only is same as return; draw all)
    far=max(range(N),key=lambda i:0)  # placeholder
    tk=[l['km'] for l in r['landmarks'] if '折返' in l['name']][-1]
    iT=round(tk*1000/st)
    for i in range(iT):
        g=(el[i+1]-el[i])/st*100
        dr.line([P(lat[i],lon[i]),P(lat[i+1],lon[i+1])],fill=COL[gk(g)],width=9)
    # km ticks every 5k (outbound only label)
    # landmarks grouped
    groups=[]; PLACED=[]; LABELS=[]
    for l in r['landmarks']:
        i=min(N-1,round(l['km']*1000/st)); p=P(lat[i],lon[i])
        for gp in groups:
            if math.dist(gp['p'],p)<30: gp['items'].append(l); break
        else: groups.append({'p':p,'items':[l]})
    for gp in groups:
        PLACED.append((gp['p'][0]-19,gp['p'][1]-19,gp['p'][0]+19,gp['p'][1]+19))
    for gp in groups:
        x,y=gp['p']; it=gp['items']
        lab='／'.join(dict.fromkeys(l['n'] for l in it))
        name=it[0]['name'].replace('（回程）','')
        if len(it[0]['n'])>1 or len(lab)>2:
            pass
        fill=(30,30,30) if not any('折返' in l['name'] for l in it) else (190,40,40)
        txt=name+('' if len(it)==1 else '（'+'、'.join(f"{l['km']:g}K" for l in it)+'）') if len(it)>1 else f"{name}  {it[0]['km']:g}K"
        ft=f(21)
        best=None
        for dx,dy,anc in [(26,0,'lm'),(-26,0,'rm'),(0,-30,'mm'),(0,30,'mm'),(26,-28,'lm'),(-26,-28,'rm'),(26,28,'lm'),(-26,28,'rm'),(0,-56,'mm'),(0,56,'mm')]:
            bb=dr.textbbox((x+dx,y+dy),txt,font=ft,anchor=anc)
            if bb[0]<5 or bb[2]>W-5: continue
            hit=sum(1 for o in PLACED if not(bb[2]<o[0] or bb[0]>o[2] or bb[3]<o[1] or bb[1]>o[3]))
            if best is None or hit<best[0]: best=(hit,dx,dy,anc,bb)
            if hit==0: break
        _,dx,dy,anc,bb=best; PLACED.append(bb)
        LABELS.append((bb,(x+dx,y+dy),txt,ft,fill,anc))
    for bb,pt,txt,ft,fill,anc in LABELS:
        dr.rectangle([bb[0]-3,bb[1]-2,bb[2]+3,bb[3]+2],fill=(250,250,248,235)); dr.text(pt,txt,font=ft,fill=fill,anchor=anc)
    for gp in groups:
        x,y=gp['p']; it=gp['items']; rr=17
        fill=(30,30,30) if not any('折返' in l['name'] for l in it) else (190,40,40)
        dr.ellipse([x-rr,y-rr,x+rr,y+rr],fill=fill,outline=(255,255,255),width=3)
        n0=it[0]['n']; dr.text((x,y),n0,font=f(18 if len(n0)<2 else 15),fill='white',anchor='mm')
    dr.text((40,30),title,font=f(36),fill=(20,20,20))
    dr.text((40,80),sub,font=f(20),fill=(110,110,110))
    ly=118; lx=40
    for k,t in [('up3','陡上 ≥7%'),('up2','上坡 4–7%'),('up1','緩上 2–4%'),('flat','平路'),('dn1','緩下'),('dn2','下坡 4–7%'),('dn3','陡下 ≥7%')]:
        dr.line([(lx,ly+12),(lx+44,ly+12)],fill=COL[k],width=9); dr.text((lx+52,ly+12),t,font=f(19),fill=(60,60,60),anchor='lm'); lx+=170
    # north + scale
    dr.line([(W-60,H-150),(W-60,H-210)],fill=(30,30,30),width=4); dr.polygon([(W-60,H-222),(W-70,H-200),(W-50,H-200)],fill=(30,30,30)); dr.text((W-60,H-130),'N',font=f(26),fill=(30,30,30),anchor='mm')
    km_px=1000/111320/cx*cx*s  # 1 km in lon degrees * cx * s
    km_px=s*(1000/110574)
    dr.line([(W-60-km_px,H-60),(W-60,H-60)],fill=(30,30,30),width=5); dr.text((W-60-km_px/2,H-80),'1 km',font=f(20),fill=(30,30,30),anchor='mm')
    im.convert('RGB').save(ROOT+rid+'/map.png',optimize=True)
draw('yangmingshan-42k-2026','陽明山國家公園馬拉松 全馬 路線（6:00 鳴槍・限時 6 小時）','去回同一條路，只畫去程的坡度（回程顏色相反）；紅圈＝折返點。路線為依官方描述自繪，非官方 GPX')
draw('yangmingshan-21k-2026','陽明山國家公園馬拉松 半馬 路線（6:00 鳴槍・限時 4 小時）','去回同一條路，只畫去程的坡度（回程顏色相反）；紅圈＝折返點。路線為依官方描述自繪，非官方 GPX')
