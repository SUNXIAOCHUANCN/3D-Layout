from __future__ import annotations

import copy
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Canvas(Contract):
    width: FiniteFloat = Field(gt=0, le=100000)
    height: FiniteFloat = Field(gt=0, le=100000)


class Source(Contract):
    artifact_id: str
    sha256: str
    width: int = Field(ge=2)
    height: int = Field(ge=2)


class Vertex(Contract):
    id: str = Field(min_length=1, max_length=80)
    x: FiniteFloat
    y: FiniteFloat


class Boundary(Contract):
    id: str = Field(min_length=1, max_length=80)
    start: str
    end: str
    points: list[tuple[FiniteFloat, FiniteFloat]] = Field(default_factory=list, max_length=100000)


class Region(Contract):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    boundary_ids: list[str] = Field(min_length=1, max_length=1000)
    design: str = Field(default="", max_length=2000)


class BoundaryMap(Contract):
    schema_version: Literal[1] = 1
    source: Source
    canvas: Canvas
    vertices: list[Vertex] = Field(max_length=10000)
    boundaries: list[Boundary] = Field(max_length=5000)
    regions: list[Region] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def geometry(self):
        vertices = {v.id: v for v in self.vertices}
        boundaries = {b.id: b for b in self.boundaries}
        if len(vertices) != len(self.vertices) or len(boundaries) != len(self.boundaries):
            raise ValueError("顶点和边界 ID 必须各自唯一")
        if len({r.id for r in self.regions}) != len(self.regions):
            raise ValueError("区域 ID 必须唯一")
        locations = [(v.x, v.y) for v in self.vertices]
        for b in self.boundaries:
            if b.start not in vertices or b.end not in vertices:
                raise ValueError(f"边界 {b.id} 引用了不存在的端点")
            if b.start == b.end and len(b.points) < 2:
                raise ValueError(f"闭合边界 {b.id} 至少需要两个中间点")
            locations.extend(b.points)
            xy = self.polyline(b)
            if sum((xy[i][0]-xy[i-1][0])**2+(xy[i][1]-xy[i-1][1])**2 for i in range(1,len(xy))) < 1e-10:
                raise ValueError(f"边界 {b.id} 长度为零")
        if any(not (0 <= x <= self.canvas.width and 0 <= y <= self.canvas.height) for x,y in locations):
            raise ValueError("坐标必须位于 Canvas 范围内")
        usage = {}
        for r in self.regions:
            if len(set(r.boundary_ids)) != len(r.boundary_ids):
                raise ValueError(f"区域 {r.id} 重复引用同一条边界")
            degree = {}; adjacency = {}
            for bid in r.boundary_ids:
                if bid not in boundaries:
                    raise ValueError(f"区域 {r.id} 引用了不存在的边界 {bid}")
                b = boundaries[bid]; usage[bid] = usage.get(bid,0)+1
                for v,other in ((b.start,b.end),(b.end,b.start)):
                    degree[v] = degree.get(v,0)+1; adjacency.setdefault(v,set()).add(other)
            if any(d != 2 for d in degree.values()):
                raise ValueError(f"区域 {r.id} 的边界没有组成闭合环；公共端点须共用同一顶点 ID")
            seen=set();todo=[next(iter(degree))]
            while todo:
                v=todo.pop()
                if v in seen:continue
                seen.add(v);todo.extend(adjacency[v]-seen)
            if len(seen)!=len(degree):raise ValueError(f"区域 {r.id} 的边界环不连通")
        if any(n>2 for n in usage.values()):raise ValueError("一条公共边界最多由两个区域引用")
        return self

    def polyline(self, boundary: Boundary) -> list[tuple[float,float]]:
        v={v.id:v for v in self.vertices};a=v[boundary.start];b=v[boundary.end]
        return [(a.x,a.y),*boundary.points,(b.x,b.y)]

    def polylines_pixels(self) -> list[list[tuple[float,float]]]:
        sx=(self.source.width-1)/self.canvas.width;sy=(self.source.height-1)/self.canvas.height
        return [[(x*sx,y*sy) for x,y in self.polyline(b)] for b in self.boundaries]


def apply_drawing(current: BoundaryMap, reply: dict, max_operations: int, max_points: int) -> BoundaryMap:
    """Atomic, declarative drawing commands. Never execute model-supplied code."""
    data=current.model_dump(mode="json")
    if "drawing" in reply:
        drawing=reply["drawing"]
        if not isinstance(drawing,dict) or set(drawing)-{"vertices","boundaries","regions"}:
            raise ValueError("drawing 仅允许 vertices、boundaries、regions")
        data.update(copy.deepcopy(drawing))
    else:
        operations=reply.get("operations")
        if not isinstance(operations,list) or not operations or len(operations)>max_operations:
            raise ValueError(f"operations 需要1到{max_operations}条绘制指令")
        for op in operations:
            if not isinstance(op,dict):raise ValueError("绘制指令必须是对象")
            kind=op.get("op")
            if kind=="set_regions":data["regions"]=op.get("regions",[]);continue
            collection={"set_vertex":"vertices","delete_vertex":"vertices","set_boundary":"boundaries","delete_boundary":"boundaries"}.get(kind)
            if collection is None:raise ValueError(f"不支持的绘制操作 {kind}")
            if kind.startswith("set_"):
                item=op.get("vertex" if collection=="vertices" else "boundary")
                if not isinstance(item,dict) or not item.get("id"):raise ValueError("绘制对象缺少 id")
                data[collection]=[v for v in data[collection] if v["id"]!=item["id"]]+[copy.deepcopy(item)]
            else:data[collection]=[v for v in data[collection] if v["id"]!=op.get("id")]
    if len(data.get("vertices",[]))+sum(len(b.get("points",[])) for b in data.get("boundaries",[]))>max_points:
        raise ValueError(f"绘图总点数超过节点限制 {max_points}")
    result=BoundaryMap.model_validate(data)
    if not result.boundaries:raise ValueError("至少需要一条分界线")
    return result
