/**
 * 插件本地服务入口：
 *   pnpm start [-- --root <工程根>] [--port 5175]
 * 默认工程根 = 插件上一级（即 3D-Layout 根）。
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startService } from './http.js'

function arg(name: string): string | undefined {
  const argv = process.argv
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const pluginDir = resolve(dirname_of(import.meta.url), '..') // main.ts 位于 server/ 下
const root = resolve(arg('root') ?? resolve(pluginDir, '..', '..'))
const port = Number(arg('port') ?? 5175)

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[interchange] 非法端口：${arg('port')}`)
  process.exit(1)
}

function dirname_of(url: string): string {
  return fileURLToPath(new URL('.', url))
}

let service: Awaited<ReturnType<typeof startService>>
try {
  service = await startService({ root, port })
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await isOwnService(port))) {
    // dev.bat 双击重复启动是常态：已有自己的服务在跑就静默复用
    console.log(`[interchange] 端口 ${port} 已有插件服务在运行，复用现有实例`)
    process.exit(0)
  }
  throw err
}

async function isOwnService(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/interchange/status`)
    const body = (await res.json()) as { name?: string }
    return body.name === 'threejs-interchange'
  } catch {
    return false
  }
}

process.on('SIGINT', () => {
  console.log('[interchange] 收到退出信号，关闭服务（已提交文件保留在工程内）')
  service.close()
  process.exit(0)
})
