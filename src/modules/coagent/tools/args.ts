/**
 * 工具参数解析（W05）——模型给的 args 是"不可信输入"，一律在这里收口。
 *
 * 失败统一抛 CoAgentError('invalid_arguments')，由 registry 转成 ToolResult，
 * 模型会看到可读错误并可以自我修正（§4.3）。
 */

import { CoAgentError } from '../contracts'

export function fail(path: string, why: string): never {
  throw new CoAgentError('invalid_arguments', `参数 ${path} ${why}`)
}

export function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.trim().length === 0) fail(key, '必须是非空字符串')
  return v
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') fail(key, '必须是字符串')
  return v
}

export function reqStringArray(args: Record<string, unknown>, key: string, opts: { min?: number } = {}): string[] {
  const v = args[key]
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || x.length === 0)) fail(key, '必须是非空字符串数组')
  if (opts.min !== undefined && v.length < opts.min) fail(key, `至少需要 ${opts.min} 项`)
  return v as string[]
}

export function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) fail(key, '必须是字符串数组')
  return v as string[]
}

export function optNumber(args: Record<string, unknown>, key: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(key, '必须是有限数字')
  if (opts.integer && !Number.isInteger(v)) fail(key, '必须是整数')
  if (opts.min !== undefined && v < opts.min) fail(key, `不能小于 ${opts.min}`)
  if (opts.max !== undefined && v > opts.max) fail(key, `不能大于 ${opts.max}`)
  return v
}

export function reqNumber(args: Record<string, unknown>, key: string, opts: { min?: number; max?: number } = {}): number {
  const v = optNumber(args, key, opts)
  if (v === undefined) fail(key, '必须是数字')
  return v
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') fail(key, '必须是布尔值')
  return v
}

export function reqRecord(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = args[key]
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(key, '必须是对象')
  return v as Record<string, unknown>
}
