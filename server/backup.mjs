import { DatabaseSync, backup } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.LAYOUT_ROOT ?? fileURLToPath(new URL('..', import.meta.url))
const source = join(root, '.data', 'layout.sqlite')
if (!existsSync(source)) throw new Error('数据库尚未创建，请先启动界面并加载场景')
const directory = resolve(process.argv[2] ?? join(root, '.data', 'backups'))
mkdirSync(directory, { recursive: true })
const target = join(directory, `layout-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
const db = new DatabaseSync(source)
try { await backup(db, target); console.log(`数据库备份：${target}\n模型资源请同时备份 assets/；完整恢复步骤见 server/README.md`) }
finally { db.close() }
