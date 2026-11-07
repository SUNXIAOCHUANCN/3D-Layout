import type { AgentAccess } from './protocol'

/**
 * 调用记录器 —— Agent 会话的"黑匣子"，日志第三部分的事实来源。
 * session 是所有工具调用的唯一执行点，在那里埋记录；
 * 轮次由传输层（LlmChatTransport）的用户消息驱动：一条用户指令 = 一轮。
 * 纯状态模块：非传输、非 UI；场景切换 / 清空对话时整体复位。
 * 与 LLM 自述（日志第一、二部分）对照，回忆漏报/多报/记错参数一目了然。
 */

export interface RecordedCall {
  seq: number
  /** 第几轮对话（0 = 用户消息之前的调用，如回环自测） */
  round: number
  time: number
  /** 规范工具名（如 asset.adjust_transform） */
  tool: string
  access: AgentAccess
  args: Record<string, unknown>
  ok: boolean
  error?: string
  /** 归属任务（写调用才有） */
  taskId?: string
}

export interface RecordedTask {
  round: number
  taskId: string
  label: string
  /** null = 尚未裁决（进行中） */
  verdict: 'accepted' | 'rejected' | null
  writes: number
}

const CAP = 500

class Recorder {
  currentRound = 0
  private roundTexts = new Map<number, string>()
  private calls: RecordedCall[] = []
  private tasks: RecordedTask[] = []
  private seq = 0

  /** 新一轮对话开始（用户发出一条指令）；返回轮次号（从 1 起） */
  beginRound(userText: string): number {
    this.currentRound += 1
    this.roundTexts.set(this.currentRound, userText)
    return this.currentRound
  }

  roundTitle(round: number): string {
    return this.roundTexts.get(round) ?? ''
  }

  recordCall(c: Omit<RecordedCall, 'seq' | 'round' | 'time'>): void {
    this.calls.push({ ...c, seq: ++this.seq, round: this.currentRound, time: Date.now() })
    if (this.calls.length > CAP) this.calls.splice(0, this.calls.length - CAP)
  }

  recordTaskBegin(taskId: string, label: string): void {
    this.tasks.push({ round: this.currentRound, taskId, label, verdict: null, writes: 0 })
  }

  recordTaskVerdict(taskId: string, verdict: 'accepted' | 'rejected', writes: number): void {
    const t = this.tasks.find(x => x.taskId === taskId)
    if (t) {
      t.verdict = verdict
      t.writes = writes
    }
  }

  reset(): void {
    this.currentRound = 0
    this.roundTexts.clear()
    this.calls = []
    this.tasks = []
    this.seq = 0
  }

  /** 轮次概要（错误提示用）：如「第 1 轮『把桌子挪近』（8 次调用）」 */
  roundsSummary(): string {
    if (this.currentRound === 0) return '尚无对话轮次'
    const parts: string[] = []
    for (let r = 1; r <= this.currentRound; r++) {
      const n = this.calls.filter(c => c.round === r).length
      const title = this.roundTexts.get(r) ?? ''
      parts.push(`第 ${r} 轮「${title.slice(0, 20)}」（${n} 次调用）`)
    }
    return parts.join('；')
  }

  /** 日志第三部分：某轮的实际调用记录（markdown，编辑器侧事实数据） */
  renderMarkdown(round: number): string {
    const calls = this.calls.filter(c => c.round === round)
    const tasks = this.tasks.filter(t => t.round === round)
    if (calls.length === 0 && tasks.length === 0) {
      throw new Error(`第 ${round} 轮没有任何调用记录。可用轮次：${this.roundsSummary()}`)
    }
    const kindZh: Record<AgentAccess, string> = { read: '读', write: '写', export: '导出', generate: '生成' }
    const count = (a: AgentAccess) => calls.filter(c => c.access === a).length
    const lines: string[] = [
      '## 第三部分：实际工具调用记录（编辑器侧自动生成）',
      '',
      `本轮共 ${calls.length} 次工具调用（读 ${count('read')} / 写 ${count('write')} / 导出 ${count('export')}），${tasks.length} 个任务提案。`,
      '',
      '| # | 时间 | 工具 | 类型 | 参数 | 结果 |',
      '| --- | --- | --- | --- | --- | --- |',
    ]
    const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8)
    const cell = (s: string) => s.replace(/\|/g, '\\|')
    for (const c of calls) {
      const args = cell(JSON.stringify(c.args ?? {}).slice(0, 160))
      const res = c.ok ? '✓' : cell(`✗ ${(c.error ?? '').slice(0, 80)}`)
      lines.push(`| ${c.seq} | ${hhmmss(c.time)} | \`${c.tool}\` | ${kindZh[c.access]} | \`${args}\` | ${res} |`)
    }
    if (tasks.length > 0) {
      lines.push('', '### 任务与裁决', '', '| 任务 | 提案 | 裁决 |', '| --- | --- | --- |')
      for (const t of tasks) {
        const v =
          t.verdict === 'accepted'
            ? `已接受（${t.writes} 次写）`
            : t.verdict === 'rejected'
              ? '已拒绝（全部回滚）'
              : '未裁决'
        lines.push(`| ${t.taskId} | ${cell(t.label)} | ${v} |`)
      }
    }
    return lines.join('\n')
  }
}

export const recorder = new Recorder()
