import type { ModelMeta } from './types'

/** Compact standardized introduction shared by Agent snapshots and library search. */
export function describeModel(ref: string, meta: ModelMeta) {
  return {
    ref, name: meta.name, category: meta.category ?? null,
    dimensions: meta.dimensions,
    ...(meta.bounds ? { bounds: meta.bounds } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.tags ? { tags: meta.tags } : {}),
    ...(meta.retrievalTerms ? { retrievalTerms: meta.retrievalTerms } : {}),
    ...(meta.scaleStatus ? { scaleStatus: meta.scaleStatus } : {}),
    ...(meta.frontStatus ? { frontStatus: meta.frontStatus } : {}),
    ...(meta.style ? { style: meta.style } : {}),
  }
}
