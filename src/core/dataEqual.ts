/** Reference-aware comparison of scene JSON. Shared terrain arrays take O(1). */
export function dataEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => dataEqual(value, b[i]))
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  // Optional undefined properties are omitted in JSON and after persistence.
  const keys = Object.keys(left).filter(key => left[key] !== undefined)
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length
    && keys.every(key => Object.hasOwn(right, key) && dataEqual(left[key], right[key]))
}
