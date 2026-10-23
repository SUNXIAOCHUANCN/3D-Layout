/**
 * pixels（W04）——离屏像素读回与 PNG 编码的共用小工具。
 *
 * 约定（§4.1）：DOM 图像坐标**左上原点**；WebGL `readRenderTargetPixels` 返回
 * **左下原点**（行 0 是画面底部），所以这里统一翻一次行，后续所有 bbox/归一化
 * 坐标都按"左上原点"计算——这是"像素方向"唯一容易错的地方，集中在此处翻转，
 * 其余模块不得再翻。
 *
 * 只 import three 的 WebGL 类型；不碰 React、不碰 core。
 */

import type { WebGLRenderTarget, WebGLRenderer } from 'three'

export interface RgbaImage {
  width: number
  height: number
  /** 左上原点、行优先、RGBA8 */
  data: Uint8Array
}

/** 读回渲染目标像素并翻成左上原点 */
export function readTargetPixels(gl: WebGLRenderer, target: WebGLRenderTarget): RgbaImage {
  const width = target.width
  const height = target.height
  const bottomUp = new Uint8Array(width * height * 4)
  gl.readRenderTargetPixels(target, 0, 0, width, height, bottomUp)
  return { width, height, data: flipRows(bottomUp, width, height) }
}

/** 行翻转（左下原点 → 左上原点） */
export function flipRows(bottomUp: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(bottomUp.length)
  const stride = width * 4
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * stride
    out.set(bottomUp.subarray(src, src + stride), y * stride)
  }
  return out
}

/** 像素 (x,y) 的 RGB（左上原点）；越界返回 null */
export function pixelAt(img: RgbaImage, x: number, y: number): [number, number, number] | null {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null
  const i = (y * img.width + x) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}

interface AnyCanvas {
  getContext(id: '2d'): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
}

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height) as unknown as AnyCanvas
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c as unknown as AnyCanvas
}

/** RGBA → PNG Blob（浏览器内；色彩空间转换交给 canvas，与 gl 输出保持一致） */
export async function encodePng(img: RgbaImage): Promise<Blob> {
  const canvas = makeCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas 不可用，无法编码 PNG')
  const clamped = new Uint8ClampedArray(img.data.length)
  clamped.set(img.data)
  ctx.putImageData(new ImageData(clamped, img.width, img.height), 0, 0)
  const anyCanvas = canvas as unknown as { convertToBlob?: (o?: { type?: string }) => Promise<Blob> }
  if (typeof anyCanvas.convertToBlob === 'function') return anyCanvas.convertToBlob({ type: 'image/png' })
  const el = canvas as unknown as HTMLCanvasElement
  return new Promise<Blob>((resolve, reject) => {
    el.toBlob(b => (b ? resolve(b) : reject(new Error('canvas.toBlob 返回空'))), 'image/png')
  })
}

/** 在给定 canvas 上打开 2D 上下文并铺上 RGB 图（标记图合成用） */
export function paintImage(img: RgbaImage): { ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D; canvas: AnyCanvas } {
  const canvas = makeCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas 不可用，无法合成标记图')
  const clamped = new Uint8ClampedArray(img.data.length)
  clamped.set(img.data)
  ctx.putImageData(new ImageData(clamped, img.width, img.height), 0, 0)
  return { ctx, canvas }
}

/** 已铺好图的 canvas 转 PNG */
export async function canvasToPng(canvas: unknown): Promise<Blob> {
  const anyCanvas = canvas as { convertToBlob?: (o?: { type?: string }) => Promise<Blob> }
  if (typeof anyCanvas.convertToBlob === 'function') return anyCanvas.convertToBlob({ type: 'image/png' })
  const el = canvas as HTMLCanvasElement
  return new Promise<Blob>((resolve, reject) => {
    el.toBlob(b => (b ? resolve(b) : reject(new Error('canvas.toBlob 返回空'))), 'image/png')
  })
}
