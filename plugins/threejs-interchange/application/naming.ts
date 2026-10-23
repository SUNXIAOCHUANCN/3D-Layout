/** 语义命名：ID 格式校验与目录命名（架构文档 §6） */

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

export function isValidSceneId(id: string): boolean {
  return ID_RE.test(id)
}

export function isValidModelKey(key: string): boolean {
  return ID_RE.test(key)
}

export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_RE.test(id)
}

/** 模型目录 ID：<scene.id>-<model.key>，保留语义并减少跨场景重名 */
export function modelDirName(sceneId: string, modelKey: string): string {
  return `${sceneId}-${modelKey}`
}

export function modelRef(dir: string): string {
  return `models/${dir}`
}

/** suffix-hash 冲突策略的摘要后缀 */
export function hashSuffix(sha256: string): string {
  return sha256.slice(0, 8)
}
