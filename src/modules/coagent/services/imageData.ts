/**
 * imageData（W08.2）——Blob → dataURL 的单一实现。
 *
 * 判定器与执行器都需要把"真实证据图"送进模型；模型协议要的是 dataURL，
 * 而证据库/渲染层拿到的是 Blob。这里保持纯函数，不依赖 GPU/DOM 单例：
 * - 浏览器有 FileReader 时走 FileReader；
 * - node 测试没有 FileReader，用 arrayBuffer + btoa（Blob 在 Node 18+ 原生可用）。
 */

import { CoAgentError } from '../contracts'

export async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new CoAgentError('capture_failed', '读取证据图失败'))
      r.readAsDataURL(blob)
    })
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  // 分块拼字符串，避免超大图逐字符 += 的 O(n²) 风险
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
}
