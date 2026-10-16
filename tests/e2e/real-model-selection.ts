import type { AgentModelCatalog, AgentModelOption } from '../../packages/contracts/src/index.js'

const effortMetadata = (model: AgentModelOption): string =>
  JSON.stringify({
    efforts: [...new Set(model.supportedEfforts)].toSorted(),
    defaultEffort: model.defaultEffort ?? null,
  })

/** Select only a native ID proven equivalent by this actual configuration's catalog. */
export function resolveRealConfiguredModel(
  catalog: AgentModelCatalog,
  configuredModel: string | null,
  preferredNativeId?: string | null,
): AgentModelOption {
  if (catalog.status !== 'available' || !configuredModel)
    throw new Error('Configured real model requires an available actual CLI catalog')
  if (new Set(catalog.models.map((model) => model.id)).size !== catalog.models.length)
    throw new Error('Actual CLI catalog has duplicate native model identities')
  const exact = catalog.models.find((model) => model.id === configuredModel)
  if (exact) return exact
  const equivalent = catalog.models.filter((model) => model.resolvedModel === configuredModel)
  if (!equivalent.length)
    throw new Error('Configured real model is absent from the actual CLI catalog')
  if (new Set(equivalent.map(effortMetadata)).size !== 1)
    throw new Error('Equivalent native model aliases have conflicting effort metadata')
  return (
    equivalent.find((model) => model.id === preferredNativeId) ??
    equivalent.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0]!
  )
}
