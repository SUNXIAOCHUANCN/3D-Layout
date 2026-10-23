/** 稳定 JSON 序列化：键排序递归，用于摘要（definitionHash 等），保证同内容同字节 */

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortValue((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/** 数字按固定精度取整，用于摘要前的浮点稳定化（1e-9 米远小于几何容差） */
export function roundForHash(n: number, decimals = 9): number {
  if (!Number.isFinite(n)) throw new Error(`non-finite number in hash input: ${n}`)
  const f = 10 ** decimals
  return Math.round(n * f) / f
}
