import { readFileSync } from 'node:fs'

const requestPath = new URL('../src/modules/llm-shared/request.ts', import.meta.url)
const SHARED_IMPORT = /^import \{[^}]*\} from '\.\.\/llm-shared\/request'[ \t]*$/m
const RUN_LOG_IMPORT = /^import \{ runLog \} from '\.\/runLog'[ \t]*$/m

/**
 * 两个 llmClient.ts 都依赖 llm-shared/request.ts（运行时 import），llm-agent 副本还依赖 runLog。
 * data: URL 模块无法解析相对路径，所以把无依赖的 request.ts 拼在前面，并把这些 import 换成等价的最小实现：
 *   - joinUrl 只是 joinLlmUrl 的别名
 *   - runLog.event 在服务端没有对应日志文件，用空实现
 * 再交给 stripTypeScriptTypes。server/tasks.mjs 与 model-client.test.mjs 共用这一份加载逻辑。
 */
export function modelClientSource(channel = 'llm-agent') {
  const shared = readFileSync(requestPath, 'utf8')
  const file = new URL(`../src/modules/${channel}/llmClient.ts`, import.meta.url)
  const client = readFileSync(file, 'utf8')
    .replace(SHARED_IMPORT, 'const joinUrl = joinLlmUrl')
    .replace(RUN_LOG_IMPORT, 'const runLog = { event() {} }')
  for (const leftover of ["from '../llm-shared/request'", "from './runLog'"]) {
    if (client.includes(leftover)) {
      throw new Error(`${channel}/llmClient.ts 仍有无法在 data: URL 中解析的依赖：${leftover}`)
    }
  }
  return `${shared}\n${client}`
}
