import type { SceneDocument } from './types'
import type { HistoryEntry, EditSource } from './edit'

export interface HistoryUnit {
  txId: number
  label: string
  source: EditSource
  entries: HistoryEntry[]
}

export interface Workspace {
  document: SceneDocument
  journal: HistoryUnit[]
  redoStack: HistoryUnit[]
  txCounter: number
}

export interface WorkspaceResponse {
  revision: number
  workspace: Workspace
  projectionError: string | null
}
