"""Local image/geometry worker. stdin/stdout JSON; never executes model code or calls a model."""
import base64
import hashlib
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from boundaries.contracts import BoundaryMap, Canvas, Source, apply_drawing
from boundaries.refine import ALGORITHM_VERSION, intersection_pairs, refine_boundaries
from boundaries.render import RenderConfig, render_boundaries
from canvas import CanvasConfig, RefineConfig, _drawing_prompt, _review_image
from images import fit_image_bytes


def decode(value):
    if not isinstance(value, str) or not value.startswith("data:image/") or ";base64," not in value:
        raise ValueError("需要图片 data URL")
    raw = base64.b64decode(value.split(",", 1)[1], validate=True)
    image = Image.open(io.BytesIO(raw))
    if image.width * image.height > 16_000_000 or min(image.size) < 8:
        raise ValueError("图片尺寸须至少 8 像素且不超过 1600 万像素")
    image.load()
    return raw, image


def encode(raw, mime="image/png"):
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def dump_map(drawing):
    payload = drawing.model_dump(mode="json")
    # Some older Pydantic builds normalize Literal[1] to True on revalidation.
    payload["schema_version"] = 1
    return payload


def execute(request):
    preset = json.loads(Path(__file__).with_name("preset.json").read_text(encoding="utf-8"))
    config = CanvasConfig.model_validate({**preset["canvas"], **request.get("config", {}), "model_profile_id": "local-profile"})
    action = request.get("action")
    if action == "health":
        return {"available": True, "algorithm": ALGORITHM_VERSION}
    raw, image = decode(request.get("image"))
    if action == "initialize":
        fit = fit_image_bytes(raw, request["image"].split(";", 1)[0][5:], preset["fit"])
        fitted = Image.open(io.BytesIO(fit.data))
        drawing = BoundaryMap(source=Source(artifact_id="local-birdseye", sha256=hashlib.sha256(fit.data).hexdigest(), width=fitted.width, height=fitted.height), canvas=Canvas(width=config.canvas_width, height=config.canvas_width * fitted.height / fitted.width), vertices=[], boundaries=[])
        return {"image": encode(fit.data, fit.mime), "drawing": dump_map(drawing), "fitNote": fit.note}
    drawing = BoundaryMap.model_validate(request.get("drawing"))
    if image.size != (drawing.source.width, drawing.source.height) or hashlib.sha256(raw).hexdigest() != drawing.source.sha256:
        raise ValueError("分界线与本次鸟瞰图不匹配")
    if action == "prepare":
        preview = decode(request["preview"])[0] if request.get("preview") else None
        prompt = _drawing_prompt(config, drawing, request["round"], request.get("history", []), request.get("feedback", ""))
        return {"prompt": prompt, "review": encode(_review_image(raw, preview))}
    if action == "apply":
        candidate = apply_drawing(drawing, request["command"], config.max_operations, config.max_points)
        if not candidate.regions:
            raise ValueError("请提供至少一个闭合且有名称的区域")
        scale = min(1, 1800 / max(candidate.source.width, candidate.source.height))
        if intersection_pairs([np.asarray(p) * scale for p in candidate.polylines_pixels()]):
            raise ValueError("存在非端点交叉，请拆分交点并共用顶点，或调整边界以消除自交")
        preview = render_boundaries(raw, candidate, config.render)
        return {"drawing": dump_map(candidate), "preview": encode(preview)}
    if action == "refine":
        c = RefineConfig.model_validate(preset["refine"])
        result, _ = refine_boundaries(image, drawing.polylines_pixels(), search_fraction=c.search_fraction, smoothness=c.smoothness)
        if result["remaining_crossing_pairs"]:
            raise ValueError("输入或处理后的界线存在交叉，请先修正绘图")
        data = dump_map(drawing)
        sx, sy = drawing.canvas.width / (drawing.source.width - 1), drawing.canvas.height / (drawing.source.height - 1)
        for boundary, path in zip(data["boundaries"], result["polylines"]):
            boundary["points"] = [[max(0, min(drawing.canvas.width, x * sx)), max(0, min(drawing.canvas.height, y * sy))] for x, y in path[1:-1]]
        refined = BoundaryMap.model_validate(data)
        preview = render_boundaries(raw, refined, RenderConfig.model_validate(preset["render"]))
        return {"drawing": dump_map(refined), "preview": encode(preview), "report": {"algorithm": ALGORITHM_VERSION, **{k: v for k, v in result.items() if k != "polylines"}}}
    raise ValueError("不支持的本地分区操作")


if __name__ == "__main__":
    try:
        result = {"ok": True, "data": execute(json.loads(sys.stdin.buffer.read().decode("utf-8")))}
    except Exception as error:
        result = {"ok": False, "error": str(error), "kind": "validation" if isinstance(error, (ValueError, TypeError, KeyError)) else "infrastructure"}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
