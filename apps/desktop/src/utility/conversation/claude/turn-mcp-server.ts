import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'

import type { AgentCollaborationSourceReader, AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationTask,
  CollaborationTurnAuthorization,
  NormalizedAgentEvent,
  RuntimeAgentId,
} from '@pact/contracts'

import {
  COLLABORATION_PLAN_CHUNK_BYTES,
  COLLABORATION_PUBLISHED_PLAN_MAX_BYTES,
  collaborationInputOutcomeAllowed,
  collaborationInputResultSchema,
  collaborationPlanRetentionInputSchema,
  collaborationPublishPlanInputSchema,
  collaborationPublishPlanInputShape,
  collaborationReviewInputSchema,
  collaborationSourceAnyReadSchema,
  peerRequestToolInputShapeFor,
  sessionTitleInputSchema,
  sessionTitleInputShape,
} from '@pact/contracts'

import type { NativePermissionWait } from '../native-permission-wait'
import type { PeerAssistanceTurn } from '../peer-assistance-policy'

import {
  collaborationInputResultDescription,
  collaborationInputResultReceiptText,
  collaborationInstructions,
  collaborationPlanRetentionReceiptText,
  collaborationSourceToolDescription,
  frozenSourceInstructions,
} from '../collaboration-prompt'
import { readFrozenSourceTool } from '../frozen-source-reader'
import {
  PEER_ASSISTANCE_INSTRUCTIONS,
  PEER_ASSISTANCE_RECORDED_RESULT,
  PEER_ASSISTANCE_TOOL_DESCRIPTION,
} from '../peer-assistance-policy'

export interface ClaudeOpenPlanPublishState {
  chunks: Buffer[]
  byteLength: number
  completedMarkdown?: string
}

export interface ClaudeTurnMcpServerParams {
  readonly serverName: string
  readonly input: AgentRunInput
  readonly workflow: CollaborationTask | undefined
  readonly authorization: CollaborationTurnAuthorization | undefined
  readonly hasSourceReader: boolean
  readonly sourceReader: AgentCollaborationSourceReader | undefined
  readonly sourceGrant: { runId: string; grant: string; active: boolean } | undefined
  readonly nativeInputResult: boolean
  readonly nativeReview: boolean
  readonly nativeOpenPlanPublish: boolean
  readonly nativeRetention: boolean
  readonly peerAssistanceAllowed: boolean
  readonly peerTargetAgentId: RuntimeAgentId
  readonly peerAssistance: PeerAssistanceTurn
  readonly peerRequests: Array<Extract<NormalizedAgentEvent, { type: 'peer.assistance.requested' }>>
  readonly openPlanPublish: ClaudeOpenPlanPublishState
  readonly permissionWait: NativePermissionWait
  readonly isRetired: () => boolean
  readonly canRetainPlan: () => boolean
}

/**
 * Builds the per-run in-process Claude SDK MCP server exposing workflow, title,
 * peer assistance, open-mode plan publish, plan retention, and frozen source tools.
 */
export function createClaudeTurnMcpServer(params: ClaudeTurnMcpServerParams) {
  const {
    serverName,
    input,
    workflow,
    authorization,
    hasSourceReader,
    sourceReader,
    sourceGrant,
    nativeInputResult,
    nativeReview,
    nativeOpenPlanPublish,
    nativeRetention,
    peerAssistanceAllowed,
    peerTargetAgentId,
    peerAssistance,
    peerRequests,
    openPlanPublish,
    permissionWait,
    isRetired,
    canRetainPlan,
  } = params

  const peerServer = createSdkMcpServer({
    name: serverName,
    version: '1.0.0',
    alwaysLoad: true,
    timeout: 10_000,
    instructions: workflow
      ? collaborationInstructions(workflow, authorization)
      : hasSourceReader
        ? `${PEER_ASSISTANCE_INSTRUCTIONS}\n${frozenSourceInstructions}`
        : PEER_ASSISTANCE_INSTRUCTIONS,
    tools: [
      ...(nativeInputResult
        ? [
            tool(
              'submit_input_result',
              collaborationInputResultDescription,
              collaborationInputResultSchema.shape,
              async (raw) => {
                if (isRetired()) throw new Error('This input result belongs to a retired root.')
                const result = collaborationInputResultSchema.parse(raw)
                if (
                  !workflow ||
                  !collaborationInputOutcomeAllowed(workflow, authorization, result.outcome)
                )
                  throw new Error('This root is not authorized to submit that input result.')
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: collaborationInputResultReceiptText,
                    },
                  ],
                }
              },
              {
                alwaysLoad: true,
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
            ),
          ]
        : []),
      ...(nativeReview
        ? [
            tool(
              'submit_review',
              'Submit this root independent review conclusion after its complete natural-language report. needs_user requires up to three questions with optional choices; omit questions for other verdicts. Pact binds the reviewed sources and actor; this does not start another turn.',
              collaborationReviewInputSchema.shape,
              async (raw) => {
                if (isRetired()) throw new Error('This review belongs to a retired root turn.')
                const parsed = collaborationReviewInputSchema.parse(raw)
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: 'Verdict validated. Include a non-empty natural-language review report in your assistant response before ending this root turn; Pact will bind it after normal completion.',
                    },
                  ],
                  structuredContent: { pactReview: parsed },
                }
              },
              {
                alwaysLoad: true,
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
            ),
          ]
        : []),
      ...(input.promptEnvelope.requestSessionTitle
        ? [
            tool(
              'publish_session_title',
              'Supply a concise title during this same root Turn; never starts another model or edits the project.',
              sessionTitleInputShape,
              async (raw) => {
                const parsed = sessionTitleInputSchema.safeParse(raw)
                return {
                  content: [
                    {
                      type: 'text',
                      text: parsed.success
                        ? 'Title validated. Continue your substantive answer.'
                        : 'Invalid Session title.',
                    },
                  ],
                  isError: !parsed.success,
                }
              },
              {
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
            ),
          ]
        : []),
      ...(peerAssistanceAllowed
        ? [
            tool(
              'request_peer_assistance',
              PEER_ASSISTANCE_TOOL_DESCRIPTION,
              peerRequestToolInputShapeFor(peerTargetAgentId),
              async (request) => {
                const admission = peerAssistance.accept(request)
                if (!admission.ok)
                  return {
                    content: [{ type: 'text', text: admission.error }],
                    isError: true,
                  }
                const accepted = admission.request
                peerRequests.push({
                  agentId: 'claude',
                  type: 'peer.assistance.requested',
                  turnId: input.runId,
                  proposalId: randomUUID(),
                  targetAgentId: accepted.target,
                  kind: accepted.kind,
                  ...(accepted.reason ? { reason: accepted.reason } : {}),
                })
                return {
                  content: [
                    {
                      type: 'text',
                      text: PEER_ASSISTANCE_RECORDED_RESULT,
                    },
                  ],
                }
              },
              {
                alwaysLoad: true,
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
            ),
          ]
        : []),
      ...(nativeOpenPlanPublish
        ? [
            tool(
              'publish_plan',
              'Publish an updated Plan Markdown version in open collaboration mode. Pass text (<= 48 KiB UTF-8 per call), optional byte offset, and complete=true on the final chunk (or omit complete/offset to send a small plan in one call). Only use when revising or updating the Plan itself.',
              collaborationPublishPlanInputShape,
              async (raw) => {
                if (isRetired() || permissionWait.waiting) {
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: 'Publishing a Plan update is currently unavailable.',
                      },
                    ],
                    isError: true,
                  }
                }
                if (openPlanPublish.completedMarkdown !== undefined) {
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: 'A published Plan has already been finalized in this root turn.',
                      },
                    ],
                    isError: true,
                  }
                }
                const parsed = collaborationPublishPlanInputSchema.safeParse(raw)
                if (!parsed.success) {
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: parsed.error.issues[0]?.message ?? 'Invalid publish_plan arguments.',
                      },
                    ],
                    isError: true,
                  }
                }
                const expectedOffset = openPlanPublish.byteLength
                const offset = parsed.data.offset ?? expectedOffset
                if (offset !== expectedOffset) {
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: `Expected Plan byte offset ${expectedOffset}, got ${offset}.`,
                      },
                    ],
                    isError: true,
                  }
                }
                const chunk = Buffer.from(parsed.data.text, 'utf8')
                const nextByteLength = openPlanPublish.byteLength + chunk.byteLength
                if (chunk.byteLength > COLLABORATION_PLAN_CHUNK_BYTES) {
                  return {
                    content: [{ type: 'text' as const, text: 'Plan chunk exceeds 48 KiB.' }],
                    isError: true,
                  }
                }
                if (nextByteLength > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: 'Published Plan exceeds the 2 MiB size limit.',
                      },
                    ],
                    isError: true,
                  }
                }
                const final = parsed.data.complete ?? true
                openPlanPublish.chunks.push(chunk)
                openPlanPublish.byteLength = nextByteLength
                if (final) {
                  const markdown = Buffer.concat(openPlanPublish.chunks).toString('utf8')
                  if (!markdown.trim()) {
                    openPlanPublish.chunks.pop()
                    openPlanPublish.byteLength = expectedOffset
                    return {
                      content: [{ type: 'text' as const, text: 'Provide non-empty plan text.' }],
                      isError: true,
                    }
                  }
                  openPlanPublish.completedMarkdown = markdown
                  openPlanPublish.chunks = []
                }
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: final
                        ? 'Plan accepted. Finish your root turn normally so Pact records the new Plan version.'
                        : `Plan chunk recorded (${openPlanPublish.byteLength} bytes). Continue with the next byte offset.`,
                    },
                  ],
                }
              },
              {
                alwaysLoad: true,
                annotations: {
                  readOnlyHint: false,
                  destructiveHint: false,
                  idempotentHint: false,
                  openWorldHint: false,
                },
              },
            ),
          ]
        : []),
    ],
  })

  if (nativeRetention) {
    peerServer.instance.registerTool(
      'retain_current_plan',
      {
        description:
          'Explicitly retain the current frozen official plan after handling the supplied input without changing that plan. Use an empty object. This does not approve implementation or replace independent review.',
        inputSchema: collaborationPlanRetentionInputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { 'anthropic/alwaysLoad': true },
      },
      async (raw: unknown) => {
        collaborationPlanRetentionInputSchema.parse(raw)
        if (!canRetainPlan()) throw new Error('The current root cannot retain an unchanged plan.')
        return {
          content: [
            {
              type: 'text' as const,
              text: collaborationPlanRetentionReceiptText,
            },
          ],
        }
      },
    )
  }

  if (hasSourceReader) {
    peerServer.instance.registerTool(
      'read_collaboration_source',
      {
        description: collaborationSourceToolDescription,
        inputSchema: collaborationSourceAnyReadSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { 'anthropic/alwaysLoad': true },
      },
      async (raw: unknown) => {
        if (isRetired() || sourceGrant?.active !== true)
          throw new Error('This source reader belongs to a retired root Turn.')
        const page = readFrozenSourceTool(sourceGrant, raw, sourceReader, undefined)
        return { content: [{ type: 'text' as const, text: JSON.stringify(page) }] }
      },
    )
  }

  return peerServer
}
