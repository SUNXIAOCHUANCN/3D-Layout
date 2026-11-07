"""图像解码校验与规范化（纯函数，供进程池调用；不依赖框架与数据库）。"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple

from PIL import Image, ImageOps

ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP"}


class ImageRejected(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class NormalizedImage:
    sha256: str
    size_bytes: int
    width: int
    height: int
    png_bytes: bytes
    thumb_bytes: bytes
    transform_note: str


def _check_limits(size_bytes: int, img: Image.Image, max_bytes: int, max_pixels: int) -> None:
    if size_bytes > max_bytes:
        raise ImageRejected("UPLOAD_TOO_LARGE", f"文件大小超限: {size_bytes} > {max_bytes}")
    if img.width * img.height > max_pixels:
        raise ImageRejected(
            "UPLOAD_TOO_LARGE",
            f"像素数超限: {img.width * img.height} > {max_pixels}（拒绝而非静默缩图）",
        )


def normalize_image(
    raw: bytes,
    *,
    filename: str | None,
    max_bytes: int,
    max_pixels: int,
    thumb_size: int,
) -> NormalizedImage:
    """解码校验 → EXIF 转正 → 统一 PNG → 缩略图。原文件字节另存，不在此处修改。"""
    if not raw:
        raise ImageRejected("INVALID_IMAGE", "空文件")
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception as exc:  # 只看扩展名不够，必须验证解码结果
        raise ImageRejected("INVALID_IMAGE", f"无法解码为图片: {exc}") from exc
    fmt = (img.format or "").upper()
    if fmt not in ALLOWED_FORMATS:
        raise ImageRejected("UNSUPPORTED_FORMAT", f"仅支持 PNG/JPEG/WebP，收到 {fmt or '未知'}")
    _check_limits(len(raw), img, max_bytes, max_pixels)

    notes: list[str] = []
    exif_transposed = ImageOps.exif_transpose(img)
    if exif_transposed is not img and exif_transposed.size != img.size:
        notes.append("exif_rotate")
    img = exif_transposed

    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() or fmt == "PNG" else "RGB")
        notes.append(f"convert:{img.mode}")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png_bytes = buf.getvalue()

    thumb = img.copy()
    thumb.thumbnail((thumb_size, thumb_size))
    tbuf = io.BytesIO()
    thumb.save(tbuf, format="PNG")
    thumb_bytes = tbuf.getvalue()

    if notes:
        notes.append("reencode:png")
    return NormalizedImage(
        sha256=hashlib.sha256(raw).hexdigest(),
        size_bytes=len(raw),
        width=img.width,
        height=img.height,
        png_bytes=png_bytes,
        thumb_bytes=thumb_bytes,
        transform_note=";".join(notes) if notes else "none",
    )


def png_dimensions(png_bytes: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(png_bytes)) as img:
        return img.width, img.height


def image_dimensions(data: bytes) -> tuple[int, int]:
    """通用尺寸读取：按内容嗅探格式，PNG/JPEG/WebP 均可（文件扩展名不可信）。"""
    with Image.open(io.BytesIO(data)) as img:
        return img.width, img.height


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------- image.fit：压缩适配（image.fit 节点用） ----------
# 云端实测限制（2026-10-31，ModelScope Qwen-Image-2.1）：图片 ≤5 MiB 且宽高各 ≤2048。
# 压缩策略=三级损失阶梯：已合规原字节直通；超限等比缩到最长边恰好达标；
# 字节仍超则质量从 95 往下取第一个装得下的档位，整档超限按 0.85 缩边重来。

FIT_QUALITY_LADDER = (95, 92, 90, 88, 85, 82, 80, 75, 70, 65, 60)
FIT_FORMAT_MIME = {"jpeg": "image/jpeg", "webp": "image/webp", "png": "image/png"}


class FitResult(NamedTuple):
    data: bytes
    mime: str
    note: str


def _fit_encode(img: Image.Image, fmt: str, quality: int, icc: bytes | None) -> bytes:
    kw: dict = {}
    if icc:
        kw["icc_profile"] = icc
    buf = io.BytesIO()
    if fmt == "jpeg":
        # 高质量段 4:4:4 保色彩，低段 4:2:0 换体积；参数固定保证确定性
        img.save(buf, "JPEG", quality=quality, subsampling=0 if quality >= 90 else 2, optimize=True, **kw)
    elif fmt == "webp":
        img.save(buf, "WEBP", quality=quality, method=4, **kw)
    else:
        img.save(buf, "PNG", **kw)
    return buf.getvalue()


def _fit_prepare(img: Image.Image, fmt: str, has_alpha: bool) -> Image.Image:
    """按目标格式整理通道：JPEG 不支持透明，先铺白底合成；WebP/PNG 保留 RGBA。"""
    if fmt == "jpeg":
        if has_alpha:
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            return bg
        return img.convert("RGB")
    return img if img.mode in ("RGB", "RGBA") else img.convert("RGBA" if has_alpha else "RGB")


def _fit_open(data: bytes) -> tuple[Image.Image, bytes | None, bool]:
    """解码 + EXIF 转正 + 通道归一（RGB/RGBA）；返回 (图, ICC 配置, 是否含透明)。"""
    img = Image.open(io.BytesIO(data))
    img.load()
    img = ImageOps.exif_transpose(img)
    icc = img.info.get("icc_profile")
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() or (img.mode == "P" and "transparency" in img.info) else "RGB")
    return img, icc, img.mode == "RGBA"


def fit_image_bytes(data: bytes, src_mime: str, config: dict) -> FitResult:
    """压缩适配纯函数（供线程池调用）。确定性：同输入同配置产出同字节。"""
    mode = config.get("mode", "auto")
    img, icc, has_alpha = _fit_open(data)

    if mode == "manual":
        edge = int(config["edge"])
        fmt = str(config["format"])
        quality = int(config.get("quality", 90))
        scale = min(edge / max(img.width, img.height), 1.0)  # 只缩不放
        if scale < 1:
            img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        work = _fit_prepare(img, fmt, has_alpha)
        out = _fit_encode(work, fmt, quality, icc)
        note = f"{work.width}x{work.height} {fmt}" + ("" if fmt == "png" else f" q{quality}")
        if has_alpha and fmt == "jpeg":
            note += " flatten_white"
        return FitResult(out, FIT_FORMAT_MIME[fmt], note)

    # ---- auto 模式 ----
    max_edge = int(config.get("max_edge", 2048))
    max_bytes = float(config.get("max_mb", 5.0)) * 1024 * 1024
    src_w, src_h = img.width, img.height
    if max(src_w, src_h) <= max_edge and len(data) <= max_bytes:
        return FitResult(data, src_mime, "passthrough")

    fmt = "webp" if has_alpha else "jpeg"
    scale = min(max_edge / max(src_w, src_h), 1.0)
    if scale < 1:
        img = img.resize((round(src_w * scale), round(src_h * scale)), Image.LANCZOS)

    # 透明图先试无损 WebP（线条图/分区图通常无损也能装下）
    if fmt == "webp":
        kw: dict = {"lossless": True, "method": 4}
        if icc:
            kw["icc_profile"] = icc
        buf = io.BytesIO()
        _fit_prepare(img, fmt, has_alpha).save(buf, "WEBP", **kw)
        if len(buf.getvalue()) <= max_bytes:
            return FitResult(buf.getvalue(), "image/webp", f"{img.width}x{img.height} webp lossless")

    for _ in range(6):  # 整档超限则缩边 0.85 重来；最多 6 轮必然收敛
        for q in FIT_QUALITY_LADDER:
            out = _fit_encode(_fit_prepare(img, fmt, has_alpha), fmt, q, icc)
            if len(out) <= max_bytes:
                return FitResult(out, FIT_FORMAT_MIME[fmt], f"{img.width}x{img.height} {fmt} q{q}")
        if max(img.width, img.height) <= 64:
            break
        img = img.resize((max(1, round(img.width * 0.85)), max(1, round(img.height * 0.85))), Image.LANCZOS)
    raise ImageRejected("FIT_FAILED", f"无法在 {max_bytes / 1048576:.1f}MB 内编码该图像（已多轮缩边仍超限）")
