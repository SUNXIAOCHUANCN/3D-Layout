from __future__ import annotations

import io
import math
from PIL import Image, ImageDraw, ImageFont
from pydantic import Field
from .contracts import BoundaryMap, Contract


class RenderConfig(Contract):
    line_color: str = Field(default="#fff1cc", pattern=r"^#[0-9a-fA-F]{6}$")
    line_width: int = Field(default=4, ge=1, le=100)
    opacity: float = Field(default=1, ge=0, le=1)
    outline_color: str = Field(default="#142c38", pattern=r"^#[0-9a-fA-F]{6}$")
    outline_width: int = Field(default=2, ge=0, le=30)
    dashed: bool = False
    show_labels: bool = True


def render_boundaries(image_bytes: bytes, boundaries: BoundaryMap, config: RenderConfig | None = None) -> bytes:
    config=config or RenderConfig();im=Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    if im.size!=(boundaries.source.width,boundaries.source.height):
        raise ValueError("分界线的来源尺寸与图片不一致")
    overlay=Image.new("RGBA",im.size);d=ImageDraw.Draw(overlay)
    alpha=round(config.opacity*255)
    def rgba(hex):return tuple(int(hex[i:i+2],16) for i in (1,3,5))+(alpha,)
    paths=boundaries.polylines_pixels()
    for path in paths:
        parts=[]
        if config.dashed:
            length=0.;on=config.line_width*4;period=on*1.7
            for a,b in zip(path,path[1:]):
                dist=math.dist(a,b);at=0.
                while at<dist:
                    phase=(length+at)%period;step=min(dist-at,(on-phase) if phase<on else (period-phase))
                    step=max(step,1e-6)
                    if phase<on:
                        parts.append([(a[0]+(b[0]-a[0])*t/dist,a[1]+(b[1]-a[1])*t/dist) for t in (at,min(at+step,dist))])
                    at+=step
                length+=dist
        else:parts=[path]
        for part in parts:
            if config.outline_width:d.line(part,fill=rgba(config.outline_color),width=config.line_width+2*config.outline_width,joint="curve")
            d.line(part,fill=rgba(config.line_color),width=config.line_width,joint="curve")
    if config.show_labels:
        font=None
        for name in ("C:/Windows/Fonts/msyh.ttc","DejaVuSans.ttf"):
            try:font=ImageFont.truetype(name,max(14,min(36,im.width//100)));break
            except OSError:pass
        font=font or ImageFont.load_default()
        by_id={b.id:p for b,p in zip(boundaries.boundaries,paths)}
        for region in boundaries.regions:
            pts=[p for bid in region.boundary_ids for p in by_id[bid]]
            # Bounding-box centre is a display hint, not a guaranteed interior point.
            x=(min(p[0] for p in pts)+max(p[0] for p in pts))/2;y=(min(p[1] for p in pts)+max(p[1] for p in pts))/2
            text=region.id+" "+region.name;bb=d.textbbox((0,0),text,font=font);w=bb[2]-bb[0];h=bb[3]-bb[1]
            d.rounded_rectangle((x-w/2-8,y-h/2-6,x+w/2+8,y+h/2+6),radius=4,fill=(20,44,56,alpha))
            d.text((x-w/2,y-h/2-bb[1]),text,font=font,fill=(255,255,255,alpha))
    buf=io.BytesIO();Image.alpha_composite(im,overlay).save(buf,"PNG");return buf.getvalue()
