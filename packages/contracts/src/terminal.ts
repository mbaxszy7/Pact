import { z } from 'zod'

export const MAX_TERMINALS_PER_PROJECT = 8
export const MAX_TOTAL_TERMINALS = 8
export const MAX_TERMINAL_TITLE_LENGTH = 64
export const MIN_TERMINAL_COLS = 2
export const MAX_TERMINAL_COLS = 400
export const MIN_TERMINAL_ROWS = 1
export const MAX_TERMINAL_ROWS = 160
export const MAX_TERMINAL_INPUT_BYTES = 32 * 1024
export const MAX_TERMINAL_OUTPUT_CHUNK_BYTES = 32 * 1024
export const TERMINAL_FLOW_HIGH_WATERMARK_BYTES = 256 * 1024
export const TERMINAL_FLOW_LOW_WATERMARK_BYTES = 64 * 1024
export const MAX_TERMINAL_DELTA_RING_BYTES = 256 * 1024
export const MAX_TERMINAL_SNAPSHOT_CHUNK_BYTES = 40 * 1024
export const TERMINAL_STARTUP_DEADLINE_MS = 5_000
export const MAX_TERMINAL_LAST_EXIT_NOTICE_BYTES = 1024

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export const terminalStateSchema = z.enum([
  'starting',
  'running',
  'closing',
  'unconfirmed',
  'exited',
  'error',
])
export type TerminalState = z.infer<typeof terminalStateSchema>

export const terminalInputModesSchema = z.strictObject({
  bracketedPaste: z.boolean(),
  applicationCursor: z.boolean(),
})
export type TerminalInputModes = z.infer<typeof terminalInputModesSchema>

export const terminalSummarySchema = z.strictObject({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  index: z.number().int().min(1).max(MAX_TOTAL_TERMINALS),
  title: z.string().min(1).max(MAX_TERMINAL_TITLE_LENGTH),
  shell: z.string().min(1).max(256),
  cwd: z.string().min(1).max(1024),
  state: terminalStateSchema,
  hasActiveChild: z.boolean(),
  childCount: z.number().int().min(0).max(4096),
  foregroundCommand: z.string().min(1).max(128).nullable().optional(),
  exitCode: z.number().int().min(-0x7fffffff).max(0x7fffffff).nullable().optional(),
  exitSignal: z.string().min(1).max(32).nullable().optional(),
  errorMessage: z.string().min(1).max(512).optional(),
  cols: z.number().int().min(MIN_TERMINAL_COLS).max(MAX_TERMINAL_COLS),
  rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS),
  seq: z.number().int().nonnegative(),
  inputEpoch: z.number().int().positive(),
  inputModes: terminalInputModesSchema,
})
export type TerminalSummary = z.infer<typeof terminalSummarySchema>

export const terminalListInputSchema = z.strictObject({
  projectId: z.string().uuid(),
})
export type TerminalListInput = z.infer<typeof terminalListInputSchema>

export const terminalListResultSchema = z.strictObject({
  projectId: z.string().uuid(),
  terminals: z.array(terminalSummarySchema).max(MAX_TERMINALS_PER_PROJECT),
  activeTerminalId: z.string().uuid().nullable().optional(),
})
export type TerminalListResult = z.infer<typeof terminalListResultSchema>

export const terminalCreateInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  requestId: z.string().uuid(),
  cols: z.number().int().min(MIN_TERMINAL_COLS).max(MAX_TERMINAL_COLS).optional(),
  rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS).optional(),
  title: z.string().min(1).max(MAX_TERMINAL_TITLE_LENGTH).optional(),
})
export type TerminalCreateInput = z.infer<typeof terminalCreateInputSchema>

export const terminalSubscribeInputSchema = z.strictObject({
  terminalId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
})
export type TerminalSubscribeInput = z.infer<typeof terminalSubscribeInputSchema>

export const terminalSubscribeResultSchema = z.strictObject({
  subscribed: z.literal(true),
  terminal: terminalSummarySchema,
})
export type TerminalSubscribeResult = z.infer<typeof terminalSubscribeResultSchema>

export const terminalUnsubscribeInputSchema = z.strictObject({
  subscriptionId: z.string().uuid(),
})
export type TerminalUnsubscribeInput = z.infer<typeof terminalUnsubscribeInputSchema>

export const terminalUnsubscribeResultSchema = z.strictObject({
  unsubscribed: z.literal(true),
})
export type TerminalUnsubscribeResult = z.infer<typeof terminalUnsubscribeResultSchema>

export const terminalAckOutputInputSchema = z.strictObject({
  subscriptionId: z.string().uuid(),
  terminalId: z.string().uuid(),
  ackedSeq: z.number().int().nonnegative(),
  ackedBytes: z
    .number()
    .int()
    .positive()
    .max(TERMINAL_FLOW_HIGH_WATERMARK_BYTES * 2),
})
export type TerminalAckOutputInput = z.infer<typeof terminalAckOutputInputSchema>

export const terminalAckOutputResultSchema = z.strictObject({
  acknowledged: z.literal(true),
})
export type TerminalAckOutputResult = z.infer<typeof terminalAckOutputResultSchema>

export const terminalReleaseProjectViewsInputSchema = z.strictObject({
  projectId: z.string().uuid(),
})
export type TerminalReleaseProjectViewsInput = z.infer<
  typeof terminalReleaseProjectViewsInputSchema
>

export const terminalReleaseProjectViewsResultSchema = z.strictObject({
  released: z.literal(true),
})
export type TerminalReleaseProjectViewsResult = z.infer<
  typeof terminalReleaseProjectViewsResultSchema
>

export const terminalVisibilityInputSchema = z.strictObject({
  terminalId: z.string().uuid(),
  visible: z.boolean(),
  rendererRetained: z.boolean().optional(),
  backpressurePaused: z.boolean().optional(),
})
export type TerminalVisibilityInput = z.infer<typeof terminalVisibilityInputSchema>

export const terminalVisibilityResultSchema = z.strictObject({
  updated: z.literal(true),
})
export type TerminalVisibilityResult = z.infer<typeof terminalVisibilityResultSchema>

export const terminalWriteInputSchema = z
  .strictObject({
    terminalId: z.string().uuid(),
    streamId: z.string().uuid(),
    chunkSeq: z.number().int().nonnegative(),
    expectedEpoch: z.number().int().positive(),
    data: z.string().min(1).max(MAX_TERMINAL_INPUT_BYTES),
  })
  .refine(
    (value) => utf8Bytes(value.data) <= MAX_TERMINAL_INPUT_BYTES,
    'Terminal input exceeds its 32 KiB byte limit.',
  )
export type TerminalWriteInput = z.infer<typeof terminalWriteInputSchema>

export const terminalWriteResultSchema = z.strictObject({
  written: z.literal(true),
  acceptedSeq: z.number().int().nonnegative(),
})
export type TerminalWriteResult = z.infer<typeof terminalWriteResultSchema>

export const terminalResizeInputSchema = z.strictObject({
  terminalId: z.string().uuid(),
  cols: z.number().int().min(MIN_TERMINAL_COLS).max(MAX_TERMINAL_COLS),
  rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS),
})
export type TerminalResizeInput = z.infer<typeof terminalResizeInputSchema>

export const terminalResizeResultSchema = z.strictObject({
  resized: z.literal(true),
})
export type TerminalResizeResult = z.infer<typeof terminalResizeResultSchema>

export const terminalCloseInputSchema = z.strictObject({
  terminalId: z.string().uuid(),
  force: z.boolean().optional(),
})
export type TerminalCloseInput = z.infer<typeof terminalCloseInputSchema>

export const terminalCloseResultSchema = z.strictObject({
  terminalId: z.string().uuid(),
  closed: z.boolean(),
  confirmationRequired: z.boolean().optional(),
  hasActiveChild: z.boolean().optional(),
  foregroundCommand: z.string().min(1).max(128).nullable().optional(),
})
export type TerminalCloseResult = z.infer<typeof terminalCloseResultSchema>

export const terminalSnapshotInputSchema = z.strictObject({
  terminalId: z.string().uuid(),
  fromSeq: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  pinnedVersion: z.number().int().nonnegative().optional(),
})
export type TerminalSnapshotInput = z.infer<typeof terminalSnapshotInputSchema>

export const terminalDeltaChunkSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  previousSeq: z.number().int().nonnegative(),
  data: z.string(),
})
export type TerminalDeltaChunk = z.infer<typeof terminalDeltaChunkSchema>

export const terminalSnapshotResultSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('delta'),
      terminal: terminalSummarySchema,
      fromSeq: z.number().int().nonnegative(),
      toSeq: z.number().int().nonnegative(),
      chunks: z.array(terminalDeltaChunkSchema).max(256),
    })
    .refine(
      (value) => utf8Bytes(JSON.stringify(value)) <= 48 * 1024,
      'Terminal delta catch-up exceeds IPC budget.',
    ),
  z
    .strictObject({
      kind: z.literal('snapshot'),
      terminal: terminalSummarySchema,
      snapshotVersion: z.number().int().nonnegative(),
      cols: z.number().int().min(MIN_TERMINAL_COLS).max(MAX_TERMINAL_COLS),
      rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS),
      offset: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
      text: z.string(),
      nextOffset: z.number().int().nonnegative().nullable(),
      inputModes: terminalInputModesSchema,
    })
    .refine(
      (value) => utf8Bytes(JSON.stringify(value)) <= 48 * 1024,
      'Terminal snapshot page exceeds IPC budget.',
    ),
])
export type TerminalSnapshotResult = z.infer<typeof terminalSnapshotResultSchema>

export const terminalOutputEventSchema = z
  .strictObject({
    terminalId: z.string().uuid(),
    projectId: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    previousSeq: z.number().int().nonnegative(),
    utf8Bytes: z.number().int().positive().max(MAX_TERMINAL_OUTPUT_CHUNK_BYTES),
    data: z.string(),
  })
  .refine(
    (value) =>
      utf8Bytes(value.data) === value.utf8Bytes &&
      utf8Bytes(value.data) <= MAX_TERMINAL_OUTPUT_CHUNK_BYTES &&
      utf8Bytes(JSON.stringify(value)) <= 48 * 1024,
    'Terminal output event exceeds chunk or IPC budget.',
  )
export type TerminalOutputEvent = z.infer<typeof terminalOutputEventSchema>

export const terminalStateEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('upsert'),
    terminal: terminalSummarySchema,
  }),
  z.strictObject({
    kind: z.literal('removed'),
    terminalId: z.string().uuid(),
    projectId: z.string().uuid(),
    reason: z.enum(['closed', 'exited_cleaned']),
  }),
])
export type TerminalStateEvent = z.infer<typeof terminalStateEventSchema>

export const terminalQuitSummaryRowSchema = z.strictObject({
  terminalId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().min(1).max(MAX_TERMINAL_TITLE_LENGTH),
  state: terminalStateSchema,
  hasActiveChild: z.boolean(),
  foregroundCommand: z.string().min(1).max(128).nullable().optional(),
})
export type TerminalQuitSummaryRow = z.infer<typeof terminalQuitSummaryRowSchema>

export const terminalLastExitNoticeSchema = z
  .strictObject({
    version: z.literal(1),
    createdAt: z.string().datetime(),
    unconfirmedCount: z.number().int().positive().max(MAX_TOTAL_TERMINALS),
    reason: z.enum(['utility_exited_unconfirmed', 'shutdown_timeout', 'worker_cleanup_failed']),
  })
  .refine(
    (value) => utf8Bytes(`${JSON.stringify(value)}\n`) <= MAX_TERMINAL_LAST_EXIT_NOTICE_BYTES,
    'Terminal last exit notice exceeds 1 KiB budget.',
  )
export type TerminalLastExitNotice = z.infer<typeof terminalLastExitNoticeSchema>

export const terminalLastExitNoticeResultSchema = terminalLastExitNoticeSchema.nullable()
export type TerminalLastExitNoticeResult = z.infer<typeof terminalLastExitNoticeResultSchema>
