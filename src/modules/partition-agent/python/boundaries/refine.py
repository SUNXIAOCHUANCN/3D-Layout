"""Generic multiscale boundary refinement; no terrain labels or colour thresholds.
Adapted from the reproducible Map2Area experiment. NumPy/OpenCV implementation.
"""
import numpy as np
import cv2
from collections import defaultdict
from .errors import AppError

ALGORITHM_VERSION = "generic-dp-v1"

class _Filters:
    @staticmethod
    def gaussian_filter(a, sigma):
        return cv2.GaussianBlur(a, (0,0), sigmaX=sigma[1], sigmaY=sigma[0], borderType=cv2.BORDER_REFLECT_101)

    @staticmethod
    def gaussian_filter1d(a, sigma, axis=0, mode="nearest"):
        if sigma <= 0:return a.copy()
        k=2*int(np.ceil(3*sigma))+1
        original=a.shape
        x=np.moveaxis(a,axis,0).reshape(original[axis],-1)
        result=cv2.GaussianBlur(x,(1,k),sigmaX=0,sigmaY=sigma,borderType=cv2.BORDER_REPLICATE)
        return np.moveaxis(result.reshape(np.moveaxis(a,axis,0).shape),0,axis)

    @staticmethod
    def map_coordinates(field, coords, order=1, mode="nearest"):
        y=np.clip(coords[0],0,field.shape[0]-1);x=np.clip(coords[1],0,field.shape[1]-1)
        x0=np.floor(x).astype(int);y0=np.floor(y).astype(int)
        x1=np.minimum(x0+1,field.shape[1]-1);y1=np.minimum(y0+1,field.shape[0]-1)
        fx=x-x0;fy=y-y0
        return field[y0,x0]*(1-fx)*(1-fy)+field[y0,x1]*fx*(1-fy)+field[y1,x0]*(1-fx)*fy+field[y1,x1]*fx*fy

ndi=_Filters()
from PIL import Image

def resample(p, step=2.5):
    out=[]
    for u,v in zip(p,p[1:]):
        n=max(1,int(np.ceil(np.linalg.norm(v-u)/step)))
        out.extend(u+(v-u)*t for t in np.arange(n)/n)
    return np.vstack([out,p[-1]])

def sample(field, p):
    shape=p.shape[:-1]; q=p.reshape(-1,2)
    return ndi.map_coordinates(field,[q[:,1],q[:,0]],order=1,mode='nearest').reshape(shape)

def remove_loops(p):
    count=0
    for _ in range(100):
        found=False
        for i in range(len(p)-3):
            a=p[i]; ab=p[i+1]-a; c=p[i+2:-1]; cd=p[i+3:]-c
            den=ab[0]*cd[:,1]-ab[1]*cd[:,0]; ok=np.abs(den)>1e-9; safe=np.where(ok,den,1)
            t=((c[:,0]-a[0])*cd[:,1]-(c[:,1]-a[1])*cd[:,0])/safe
            u=((c[:,0]-a[0])*ab[1]-(c[:,1]-a[1])*ab[0])/safe
            hit=np.where(ok&(t>1e-6)&(t<1-1e-6)&(u>1e-6)&(u<1-1e-6))[0]
            if len(hit):
                k=hit[-1];j=i+2+k
                p=np.vstack([p[:i+1],a+t[k]*ab,p[j+1:]])
                count+=1;found=True;break
        if not found:break
    return p,count

def intersection_pairs(paths):
    cells=defaultdict(list); pairs=set()
    for ci,p in enumerate(paths):
        for j,(u,v) in enumerate(zip(p,p[1:])):
            keys=[(x,y) for x in range(int(min(u[0],v[0])//12),int(max(u[0],v[0])//12)+1) for y in range(int(min(u[1],v[1])//12),int(max(u[1],v[1])//12)+1)]
            tested=set()
            for key in keys:
                for oi,oj,a,b in cells[key]:
                    if (oi,oj) in tested or (oi==ci and abs(oj-j)<=2):continue
                    tested.add((oi,oj));ab=v-u;cd=b-a
                    den=ab[0]*cd[1]-ab[1]*cd[0]
                    if abs(den)<1e-9:continue
                    delta=a-u;t=(delta[0]*cd[1]-delta[1]*cd[0])/den
                    s=(delta[0]*ab[1]-delta[1]*ab[0])/den
                    if 1e-6<t<1-1e-6 and 1e-6<s<1-1e-6:pairs.add((min(ci,oi),max(ci,oi)))
                cells[key].append((ci,j,u,v))
    return pairs

def refine_boundaries(image, polylines, *, cancelled=lambda: False, search_fraction=.022, smoothness=1.0):
    image=image.convert('RGB');W,H=image.size
    if min(W,H)<8:raise ValueError('Image must be at least 8 pixels in each dimension.')
    for line in polylines:
        values=np.asarray(line,float)
        if values.ndim!=2 or values.shape[1]!=2 or len(values)<2 or not np.isfinite(values).all():
            raise ValueError('Each polyline must contain at least two finite [x,y] coordinates.')
    scale=min(1.,1800/max(W,H)); sw=max(3,round(W*scale));sh=max(3,round(H*scale))
    scales=np.array([sw/W,sh/H]); rgb=np.asarray(image.resize((sw,sh),Image.Resampling.LANCZOS),float)/255
    # Opponent colour channels, with no assumptions about a particular colour.
    r,g,b=rgb.transpose(2,0,1)
    colour=np.stack([.299*r+.587*g+.114*b,(r-g)*.5,(b-(r+g)*.5)*.5],axis=2)
    features=[];maps=[]
    for sigma in (1.2,3.,7.):
        sm=ndi.gaussian_filter(colour,(sigma,sigma,0));gy,gx=np.gradient(sm,axis=(0,1))
        magnitude=np.sqrt(np.sum(gx*gx+gy*gy,axis=2)); norm=max(float(np.percentile(magnitude,97)),float(magnitude.max())*.25,1e-5)
        features.append((sm,gx,gy,norm));maps.append(magnitude/(magnitude+norm))
    # Generic two-sided contrast calibration, from all image positions.
    contrast_norm=[]
    contrast_specs=[(1,min(5,max(1,min(sw,sh)//4))),(2,min(11,max(1,min(sw,sh)//4)))]
    for si,distance in contrast_specs:
        sm=features[si][0]; k=round(distance)
        dx=np.linalg.norm(sm[:,2*k:]-sm[:,:-2*k],axis=2)
        dy=np.linalg.norm(sm[2*k:]-sm[:-2*k],axis=2)
        contrast_norm.append(max(float(np.percentile(np.r_[dx.ravel(),dy.ravel()],97)),float(max(dx.max(),dy.max()))*.25,1e-4))
    radius=max(4,round(min(sw,sh)*search_fraction));offsets=np.arange(-radius,radius+1,dtype=float)
    paths=[];stats=[];coarse=[]
    for index,line in enumerate(polylines):
        if cancelled(): raise AppError("CANCELLED", "运行已取消", 499)
        raw=resample(np.asarray(line,float)*scales);coarse.append(raw)
        # Round corners before image alignment; endpoints remain fixed.
        p=ndi.gaussian_filter1d(raw,2.2,axis=0,mode='nearest')
        p[0]=raw[0];p[-1]=raw[-1];p[:,0]=np.clip(p[:,0],0,sw-1);p[:,1]=np.clip(p[:,1],0,sh-1)
        tangent=np.gradient(ndi.gaussian_filter1d(p,1.2,axis=0),axis=0)
        tangent/=np.maximum(np.linalg.norm(tangent,axis=1,keepdims=True),1e-9)
        normals=np.c_[-tangent[:,1],tangent[:,0]];q=p[:,None,:]+normals[:,None,:]*offsets[None,:,None]
        direction=[]
        for sm,gx,gy,norm in features:
            strength=np.sqrt(sum((sample(gx[:,:,c],q)*normals[:,None,0]+sample(gy[:,:,c],q)*normals[:,None,1])**2 for c in range(3)))
            direction.append(strength/(strength+norm))
        contrasts=[]
        for ii,(si,distance) in enumerate(contrast_specs):
            sm=features[si][0];delta=normals[:,None,:]*distance
            contrast=np.sqrt(sum((sample(sm[:,:,c],q+delta)-sample(sm[:,:,c],q-delta))**2 for c in range(3)))
            contrasts.append(contrast/(contrast+contrast_norm[ii]))
        # Broad agreement favours lasting region changes over narrow ink strokes.
        evidence=.15*direction[0]+.2*direction[1]+.2*direction[2]+.2*contrasts[0]+.25*contrasts[1]
        confidence=ndi.gaussian_filter1d(evidence.max(axis=1),3.)
        confidence=np.clip((confidence-.12)/.58,0,1)
        n,K=evidence.shape;unary=-3.2*evidence+.85*(offsets[None,:]/radius)**2
        ramp=np.minimum(np.arange(n),np.arange(n)[::-1])
        allowed=np.minimum(radius*confidence,ramp*.9)
        invalid=(q[:,:,0]<0)|(q[:,:,0]>sw-1)|(q[:,:,1]<0)|(q[:,:,1]>sh-1)|(abs(offsets)[None,:]>allowed[:,None])
        unary[invalid]=1e9
        dp=np.full(K,1e12);dp[radius]=unary[0,radius];back=np.zeros((n,K),np.int16);target=np.arange(K)
        for i in range(1,n):
            if i % 32 == 0 and cancelled(): raise AppError("CANCELLED", "运行已取消", 499)
            best=np.full(K,1e12);pred=np.zeros(K,np.int16)
            for jump in range(-3,4):
                previous=target+jump;valid=(previous>=0)&(previous<K);ix=target[valid];pv=previous[valid]
                val=dp[pv]+.3*smoothness*jump*jump;take=val<best[ix];ix=ix[take];best[ix]=val[take];pred[ix]=pv[take]
            dp=best+unary[i];back[i]=pred
        ix=np.zeros(n,int);ix[-1]=radius
        for i in range(n-1,0,-1):ix[i-1]=back[i,ix[i]]
        shift=ndi.gaussian_filter1d(offsets[ix],1.5);shift[0]=shift[-1]=0
        out=p+normals*shift[:,None];out,loops=remove_loops(out)
        # Mild smoothing of the actual curve, rather than only the offsets.
        out=ndi.gaussian_filter1d(out,2.0*smoothness,axis=0,mode='nearest');out[0]=raw[0];out[-1]=raw[-1]
        out,moreloops=remove_loops(out);paths.append(out)
        stats.append({'chain':index,'evidence_mean':float(evidence.max(axis=1).mean()),'confidence_mean':float(confidence.mean()),'removed_loops':loops+moreloops})
    restored=[]
    for _ in range(len(paths)+1):
        pairs=intersection_pairs(paths)
        if not pairs:break
        bad={i for pair in pairs for i in pair};changed=False
        for i in bad:
            if i not in restored: paths[i]=coarse[i].copy();restored.append(i);changed=True
        if not changed:break
    for i,p in enumerate(paths):
        # Distances to the input polyline, evaluated in working coordinates.
        raw=np.asarray(polylines[i],float)*scales; ds=np.full(len(p),np.inf)
        for u,v in zip(raw,raw[1:]):
            delta=v-u;t=np.clip(((p-u)*delta).sum(axis=1)/max(float(delta@delta),1e-12),0,1)
            ds=np.minimum(ds,np.linalg.norm(p-u-t[:,None]*delta,axis=1))
        stats[i].update({'mean_distance_original_px':float(ds.mean()/scale),'max_distance_original_px':float(ds.max()/scale),'intersection_fallback':i in restored})
    return {'polylines':[np.round(p/scales,3).tolist() for p in paths], 'stats':stats,'working_size':[sw,sh], 'search_halfwidth_original_px':radius/scale,'remaining_crossing_pairs':sorted(intersection_pairs(paths)), 'fallback_chains':restored}, np.mean(maps,axis=0)

