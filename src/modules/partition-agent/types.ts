import type { LlmTurn } from './llmClient'
import type { BoundaryMap } from './geometry'
export interface PartitionConfig { prompt_text: string; max_rounds: number; max_duration_seconds: number; max_points: number; max_operations: number; canvas_width: number }
export interface PartitionRound { round: number; status: 'drawn' | 'reviewed' | 'rejected'; note: string }
export type Point = [number, number]
export interface Region { id: string; name: string; design: string; polygon: Point[] }
export interface Partition {
  regions: Region[]
  owners: Record<string, string>
  workflowId: string
  workflowRevision: number
  runId: string
  createdAt: string
  preview?: string
  rawPreview?: string
  boundaryMap?: BoundaryMap
  rawBoundaryMap?: BoundaryMap
  refinementReport?: Record<string, unknown>
  stopReason?: 'model_finished' | 'max_rounds' | 'time_limit'
  drawingHistory?: PartitionRound[]
  config?: PartitionConfig
}
export interface ChatMessage { role: 'user' | 'assistant' | 'note'; text: string }
export interface SceneSession {
  schemaVersion: 1
  sceneId: string
  updatedAt: number
  sessionId: string
  workflowId: string
  partition: Partition | null
  partitionConfig?: Partial<PartitionConfig>
  turns: LlmTurn[]
  chat: ChatMessage[]
}
export interface WorkerStatus { id: string; regionId: string; task: string; status: 'running' | 'completed' | 'failed' | 'stopped'; detail: string }
export const GLOBAL = '__global__'
export function emptySession(sceneId: string): SceneSession {
  return { schemaVersion: 1, sceneId, updatedAt: Date.now(), sessionId: crypto.randomUUID(), workflowId: 'builtin-llm-partition-v1', partition: null, turns: [], chat: [] }
}
