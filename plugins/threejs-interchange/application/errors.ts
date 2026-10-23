/** 统一错误码与报告结构（架构文档 §10：阶段、路径、错误码、严重级别、建议） */

export type IssueSeverity = 'error' | 'warning' | 'info'

export interface Issue {
  code: string
  severity: IssueSeverity
  message: string
  path?: string
  assetId?: string
  suggestion?: string
}

export class InterchangeError extends Error {
  readonly code: string
  readonly issue: Issue
  constructor(code: string, message: string, extra?: Partial<Issue>) {
    super(message)
    this.code = code
    this.issue = { code, severity: 'error', message, ...extra }
  }
}

export function errorIssue(code: string, message: string, extra?: Partial<Issue>): Issue {
  return { code, severity: 'error', message, ...extra }
}

export function infoIssue(code: string, message: string, extra?: Partial<Issue>): Issue {
  return { code, severity: 'info', message, ...extra }
}

export function warnIssue(code: string, message: string, extra?: Partial<Issue>): Issue {
  return { code, severity: 'warning', message, ...extra }
}

/** 报告里出现任一 error 级条目即阻断提交 */
export function hasBlocking(issues: Issue[]): boolean {
  return issues.some(i => i.severity === 'error')
}
