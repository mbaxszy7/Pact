import { z } from 'zod'

import { pactSkillSchema, type PactSkill } from './collaboration.js'

export const SKILL_CATALOG_ITEMS = 4_096
export const SKILL_CATALOG_BYTES = 1_024 * 1_024
export const SKILL_PAGE_ITEMS = 50
export const SKILL_PAGE_BYTES = 64 * 1_024
export const SKILL_INVOCATION_BYTES = 64 * 1_024
export const SKILL_ITEM_BYTES = 8 * 1_024

const agentSchema = z.enum(['claude', 'codex'])
const nameSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\p{L}\p{N}_.:-]+$/u)
const fits = (value: unknown, bytes: number): boolean =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= bytes

/** A disposable native projection; paths and configuration remain in Utility. */
export const nativeSkillSchema = z
  .strictObject({
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    agentId: agentSchema,
    name: nameSchema,
    description: z.string().max(4_096),
    argumentHint: z.string().max(1_024),
    source: z.enum(['system', 'user', 'project', 'plugin', 'native']),
  })
  .refine((value) => fits(value, SKILL_ITEM_BYTES), 'Skill metadata exceeds its byte limit.')
export type NativeSkill = z.infer<typeof nativeSkillSchema>

export const skillSelectionSchema = z.strictObject({
  id: nativeSkillSchema.shape.id,
  agentId: agentSchema,
  name: nameSchema,
  start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  end: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
})
export type SkillSelection = z.infer<typeof skillSelectionSchema>

export const skillSelectionsSchema = z
  .array(skillSelectionSchema)
  .max(SKILL_CATALOG_ITEMS)
  .refine(
    (value) => fits(value, SKILL_INVOCATION_BYTES),
    'Selected Skills exceed their byte limit.',
  )

export const skillCatalogReadSchema = z
  .strictObject({
    sessionId: z.string().uuid(),
    agentId: agentSchema,
    query: z.string().max(512).default(''),
    names: z.array(nameSchema).max(SKILL_CATALOG_ITEMS).optional(),
    generation: z.string().uuid().optional(),
    offset: z.number().int().min(0).max(SKILL_CATALOG_ITEMS).default(0),
    refresh: z.boolean().default(false),
  })
  .refine((value) => fits(value, SKILL_PAGE_BYTES), 'Skill catalog request exceeds its byte limit.')
export type SkillCatalogRead = z.infer<typeof skillCatalogReadSchema>

export const skillCatalogPageSchema = z
  .strictObject({
    agentId: agentSchema,
    generation: z.string().uuid(),
    checkedAt: z.string(),
    skills: z.array(nativeSkillSchema).max(SKILL_PAGE_ITEMS),
    total: z.number().int().min(0).max(SKILL_CATALOG_ITEMS),
    nextOffset: z.number().int().min(0).max(SKILL_CATALOG_ITEMS).nullable(),
  })
  .refine((value) => fits(value, SKILL_PAGE_BYTES), 'Skill page exceeds its byte limit.')
export type SkillCatalogPage = z.infer<typeof skillCatalogPageSchema>

export const skillDocumentReadSchema = z.strictObject({
  sessionId: z.string().uuid(),
  agentId: agentSchema,
  skillId: nativeSkillSchema.shape.id,
  requestId: z.string().uuid(),
})
export type SkillDocumentRead = z.infer<typeof skillDocumentReadSchema>
export const skillDocumentSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      agentId: agentSchema,
      skillId: nativeSkillSchema.shape.id,
      name: nameSchema,
      content: z.string().max(1_024 * 1_024),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
      updatedAt: z.string().datetime(),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      agentId: agentSchema,
      skillId: nativeSkillSchema.shape.id,
      name: nameSchema,
      reason: z.literal('native_document_not_exposed'),
      description: z.string().max(4_096),
      argumentHint: z.string().max(1_024),
    }),
  ])
  .refine((value) => fits(value, 1_024 * 1_024 - 2_048), 'Skill document exceeds its byte limit.')
export type SkillDocument = z.infer<typeof skillDocumentSchema>

export const composerEditingStateSchema = z.strictObject({
  ownerId: z.string().uuid(),
  focused: z.boolean(),
  editable: z.boolean(),
  composing: z.boolean(),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
})
export type ComposerEditingState = z.infer<typeof composerEditingStateSchema>
export const composerEditCommandSchema = z.strictObject({
  ownerId: z.string().uuid(),
  requestId: z.string().uuid(),
  action: z.enum(['undo', 'redo']),
  expiresAt: z.number().int().positive(),
})
export type ComposerEditCommand = z.infer<typeof composerEditCommandSchema>
export const composerEditReceiptSchema = z.strictObject({
  ownerId: z.string().uuid(),
  requestId: z.string().uuid(),
  disposition: z.enum(['handled', 'native_target', 'blocked']),
})
export type ComposerEditReceipt = z.infer<typeof composerEditReceiptSchema>

/** Utility-created admission evidence. Never accepted from Renderer or exposed as a page. */
export const skillBindingSchema = nativeSkillSchema.safeExtend({
  path: z.string().max(4_096).optional(),
})
export const nativeCodexSkillListSchema = z.object({
  data: z
    .array(
      z.object({
        cwd: z.string().max(4_096),
        skills: z
          .array(
            z
              .object({
                name: nameSchema,
                description: z.string().max(4_096),
                path: z.string().min(1).max(4_096),
                scope: z.string().max(128),
                enabled: z.boolean(),
                pluginId: z.string().max(512).nullable().optional(),
              })
              .passthrough(),
          )
          .max(SKILL_CATALOG_ITEMS),
        errors: z.array(z.unknown()).max(SKILL_CATALOG_ITEMS),
      }),
    )
    .max(1),
})

export type SkillBinding = z.infer<typeof skillBindingSchema>
export const frozenSkillInvocationSchema = z
  .strictObject({
    version: z.literal('pact-skills-v1'),
    arguments: z.string(),
    selections: skillSelectionsSchema,
    bindings: z
      .array(skillBindingSchema)
      .max(SKILL_CATALOG_ITEMS * 2)
      .refine(
        (value) => fits(value, SKILL_INVOCATION_BYTES),
        'Skill bindings exceed their byte limit.',
      ),
  })
  .refine(
    ({ arguments: _arguments, ...metadata }) => fits(metadata, SKILL_INVOCATION_BYTES),
    'Skill invocation metadata exceeds its total byte limit.',
  )
export interface FrozenSkillInvocation {
  version: 'pact-skills-v1'
  arguments: string
  selections: SkillSelection[]
  bindings: SkillBinding[]
}

type AgentRoute = { type: 'agent'; agentId: 'claude' | 'codex' } | { type: 'all' }
export interface ComposerCommandPrefix {
  pact?: PactSkill
  route?: AgentRoute
  skills: Array<{ name: string; start: number; end: number }>
  argumentsStart: number
  error?: string
}

/** Only the leading command area is syntax. History and quoted context never enter this parser. */
export function parseComposerCommandPrefix(
  content: string,
  selections: readonly Pick<SkillSelection, 'name' | 'start' | 'end'>[] = [],
): ComposerCommandPrefix {
  const result: ComposerCommandPrefix = { skills: [], argumentsStart: 0 }
  if (selections.length > SKILL_CATALOG_ITEMS || !fits(selections, SKILL_INVOCATION_BYTES))
    return { ...result, error: 'The Skill command area exceeds its capacity.' }
  const atoms = new Map<number, Pick<SkillSelection, 'name' | 'start' | 'end'>>()
  let previousEnd = 0
  for (const entry of selections.toSorted((a, b) => a.start - b.start)) {
    if (
      !Number.isInteger(entry.start) ||
      !Number.isInteger(entry.end) ||
      entry.start < previousEnd ||
      entry.end <= entry.start ||
      entry.end > content.length ||
      !nameSchema.safeParse(entry.name).success ||
      content.slice(entry.start, entry.end) !== `/${entry.name}`
    )
      return { ...result, error: 'The selected Skill token changed. Select it again.' }
    atoms.set(entry.start, entry)
    previousEnd = entry.end
  }
  let offset = 0
  while (offset < content.length) {
    const whitespace = /^\s*/u.exec(content.slice(offset))![0].length
    offset += whitespace
    const atom = atoms.get(offset)
    if (atom) {
      if (result.skills.length >= SKILL_CATALOG_ITEMS) {
        result.error = 'The Skill command area exceeds its capacity.'
        break
      }
      result.skills.push({ name: atom.name, start: atom.start, end: atom.end })
      offset = atom.end
      // An opaque chip ends at its stored range. Adjacent ordinary text is task content,
      // even when it starts with a character that could otherwise be command syntax.
      if (offset < content.length && !/\s/u.test(content[offset]!) && !atoms.has(offset)) break
      continue
    }
    const token = /^(?:@(claude|codex|all)|\/([\p{L}\p{N}_.:-]+))(?=\s|$)/iu.exec(
      content.slice(offset),
    )
    if (!token) break
    const pact = pactSkillSchema.safeParse(token[2])
    if (token[1]) {
      if (result.route) {
        result.error = 'Choose one target Agent for this message.'
        break
      }
      const target = token[1].toLowerCase()
      result.route =
        target === 'all'
          ? { type: 'all' }
          : { type: 'agent', agentId: target === 'claude' ? 'claude' : 'codex' }
    } else if (pact.success) {
      if (result.pact) {
        result.error = 'Choose one Pact Skill for this task.'
        break
      }
      result.pact = pact.data
    } else {
      if (result.skills.length >= SKILL_CATALOG_ITEMS) {
        result.error = 'The Skill command area exceeds its capacity.'
        break
      }
      result.skills.push({ name: token[2]!, start: offset, end: offset + token[0].length })
    }
    offset += token[0].length
  }
  if (result.pact && (result.skills.length || selections.length))
    result.error = 'Use a Pact Skill or native Skills in one request, not both.'
  if (result.pact && result.route?.type === 'all')
    result.error = 'Choose one Agent to start this Pact task.'
  result.argumentsStart = offset
  return result
}

export function skillArguments(content: string, selections: SkillSelection[]): string {
  const prefix = parseComposerCommandPrefix(content, selections)
  if (prefix.error) throw new Error(prefix.error)
  const ranges = selections.filter((entry) => entry.start >= prefix.argumentsStart)
  let result = '',
    offset = prefix.argumentsStart
  for (const entry of ranges.toSorted((a, b) => a.start - b.start)) {
    if (entry.start < offset || content.slice(entry.start, entry.end) !== `/${entry.name}`)
      throw new Error('The selected Skill token changed. Select it again.')
    result += content.slice(offset, entry.start)
    offset = entry.end
  }
  return (result + content.slice(offset)).trim()
}
