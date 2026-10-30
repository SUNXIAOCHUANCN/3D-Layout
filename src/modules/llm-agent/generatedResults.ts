const results = new Map<string, unknown>()

export function clearGeneratedResults(): void { results.clear() }
export function saveGeneratedResult(value: unknown): string {
  const id = crypto.randomUUID()
  results.set(id, value)
  return id
}
export function getGeneratedResult(id: string): unknown {
  if (!results.has(id)) throw new Error('Python 结果不存在或不属于当前运行')
  return results.get(id)
}
