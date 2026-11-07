import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DrawingValidationError } from './processingErrors'

/** Runs only the bundled image/geometry worker, never model-supplied code. */
export function processBoundaries(root: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  const dir = resolve(root, 'src/modules/partition-agent/python')
  const local = resolve(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const python = process.env.LAYOUT_PARTITION_PYTHON || (existsSync(local) ? local : 'python')
  return new Promise((resolveResult, reject) => {
    signal.throwIfAborted()
    const child = spawn(python, [resolve(dir, 'worker.py')], { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    let stdout = '', stderr = '', settled = false
    const finish = (error?: Error, data?: unknown) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolveResult(data)
    }
    const abort = () => { child.kill(); finish(new Error('本地分区处理已停止')) }
    const timer = setTimeout(() => { child.kill(); finish(new Error('本地分区处理超时')) }, 120000)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 55 * 1024 * 1024) { child.kill(); finish(new Error('本地处理结果过大')) } })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-3000) })
    child.on('error', () => finish(new Error('无法启动本地 Python，请运行插件 python/setup.ps1 安装独立图像处理环境。')))
    child.stdin.on('error', () => { /* Process close supplies the useful error. */ })
    child.on('close', code => {
      if (settled) return
      if (code !== 0) { finish(new Error(`本地图像处理失败，请检查插件 Python 依赖：${stderr}`)); return }
      try {
        const response = JSON.parse(stdout)
        if (!response.ok) finish(response.kind === 'validation' ? new DrawingValidationError(response.error) : new Error(response.error || '本地分区处理失败'))
        else finish(undefined, response.data)
      } catch { finish(new Error('本地分区处理返回了无效数据')) }
    })
    child.stdin.end(JSON.stringify(input))
  })
}
