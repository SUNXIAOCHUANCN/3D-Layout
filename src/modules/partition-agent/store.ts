import { create } from 'zustand'
import type { SceneSession, WorkerStatus } from './types'
interface State {
  session: SceneSession | null
  busy: boolean
  loading: boolean
  progress: string
  error: string
  workers: WorkerStatus[]
  events: string[]
  partitionPreview: string | null
}
export const usePartitionAgentStore = create<State>(() => ({ session: null, busy: false, loading: false, progress: '', error: '', workers: [], events: [], partitionPreview: null }))
