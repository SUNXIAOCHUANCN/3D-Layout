import type { LlmTurn } from './llmClient'

const MAX_IMAGE_CHARS = 4_000_000
const MAX_IMAGE_BATCHES = 3
export const HISTORY_BUDGET = 100_000

export function retainImages(turns: LlmTurn[]) {
  let batches = 0
  let chars = 0
  for (const turn of [...turns].reverse()) {
    if (turn.role === 'user' && turn.images?.length) {
      const size = turn.images.reduce((total, image) => total + image.dataUrl.length, 0)
      if (++batches === 1 || (batches <= MAX_IMAGE_BATCHES && chars + size <= MAX_IMAGE_CHARS)) chars += size
      else {
        turn.images = undefined
        turn.text += '（此批图片已移出当前上下文。）'
      }
    }
    if (turn.role !== 'toolResults') continue
    const results = turn.results.filter(result => result.images?.length)
    if (!results.length) continue
    batches++
    const size = results.reduce((total, result) => total + result.images!.reduce((sum, image) => sum + image.dataUrl.length, 0), 0)
    if (batches === 1 || (batches <= MAX_IMAGE_BATCHES && chars + size <= MAX_IMAGE_CHARS)) {
      chars += size
      continue
    }
    for (const result of results) {
      result.images = undefined
      result.content = { ...result.content as object, note: '此历史截图已移出当前上下文，需要时请重新截图。' }
    }
  }
}

export function historyText(turns: LlmTurn[]) {
  return JSON.stringify(turns.map(turn => {
    if (turn.role === 'toolResults') {
      return { ...turn, results: turn.results.map(({ images, ...result }) => ({
        ...result, ...(images?.length ? { imageCount: images.length } : {}),
      })) }
    }
    return turn.role === 'user' ? { role: turn.role, text: turn.text } : turn
  }))
}

// Select a boundary by remaining text size, never inside a tool exchange.
export function compactionCut(turns: LlmTurn[]) {
  const target = HISTORY_BUDGET * 0.4
  let cut = 0
  while (cut < turns.length - 2 && historyText(turns.slice(cut)).length > target) {
    cut++
    if (turns[cut]?.role === 'toolResults') cut++
  }
  return cut
}

export function boundHistoricalResults(turns: LlmTurn[]) {
  for (const turn of turns) {
    if (turn.role !== 'toolResults') continue
    for (const result of turn.results) {
      const encoded = JSON.stringify(result.content)
      if (!encoded || encoded.length <= 16_000) continue
      result.content = {
        note: '大型历史结果已缩减，详情请按对象或分页重新查询。',
        excerpt: encoded.slice(0, 6_000),
        originalCharacters: encoded.length,
      }
    }
  }
}

export function fatalApiError(error: unknown) {
  return /HTTP (?:401|402|403)|insufficient_balance/i.test(String(error))
}
