import { usePartitionAgentStore } from './store'
// Runtime diagnostics never contain prompts, credentials, or generated result data.
export const runLog = { event(type: string, _payload: unknown) {
  usePartitionAgentStore.setState(s => ({ events: [...s.events.slice(-99), `${new Date().toLocaleTimeString()} ${type}`] }))
} }
