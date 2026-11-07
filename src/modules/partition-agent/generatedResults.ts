const results = new Map<string, { contextId: string; value: unknown }>()

export function clearGeneratedResults(contextId: string): void { for (const [id, r] of results) if (r.contextId === contextId) results.delete(id) }
export function saveGeneratedResult(value: unknown, contextId = ''): string {
  const id = crypto.randomUUID()
  results.set(id, { contextId, value })
  return id
}
export function getGeneratedResult(id: string, contextId = ''): unknown {
  const result = results.get(id)
  if (!result || result.contextId !== contextId) throw new Error('Python 结果不存在或不属于当前运行')
  return result.value
}
