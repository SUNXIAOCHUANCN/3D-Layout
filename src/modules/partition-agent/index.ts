import { useEffect } from 'react'
import { partitionAgent } from './runtime'
export { PartitionAgentPanel } from './Panel'
export { usePartitionAgentStore } from './store'
export function usePartitionAgentModule(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    partitionAgent.start()
    return () => partitionAgent.stop()
  }, [enabled])
}
