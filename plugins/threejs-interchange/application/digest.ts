/** SHA-256 摘要，浏览器与 Node 通用（WebCrypto 全局可用） */

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

export function bytesLength(bytes: Uint8Array | ArrayBuffer): number {
  return bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength
}

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
