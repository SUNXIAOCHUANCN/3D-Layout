/**
 * clarify（W07）——把"澄清问答"变成一次新的规划请求。
 *
 * 约定：澄清不是新会话，而是同一诉求的补充信息。把原请求与用户回答拼在一起重新
 * 规划，并在文本里显式标注"补充说明"，避免模型把答案当成一条新指令。
 * 纯函数，便于单测。
 */

export interface ClarifyState {
  /** 触发澄清的那句原始请求 */
  originalRequest: string
  /** 模型给出的问题 */
  question: string
  /** 模型给出的选项（可为空） */
  options: string[]
}

export const MAX_CLARIFY_ANSWER_CHARS = 500
export const MAX_COMPOSED_CHARS = 1_200

export function composeClarifiedRequest(original: string, answer: string): string {
  const a = answer.trim().slice(0, MAX_CLARIFY_ANSWER_CHARS)
  const o = original.trim()
  const composed = a.length > 0 ? `${o}\n补充说明：${a}` : o
  return composed.slice(0, MAX_COMPOSED_CHARS)
}

/** 回答是否可用（空白答案不允许提交） */
export function isUsableAnswer(answer: string): boolean {
  return answer.trim().length > 0
}
