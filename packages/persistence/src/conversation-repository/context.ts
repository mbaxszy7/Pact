import type {
  AgentRun,
  AnchoredComment,
  CollaborationActionInput,
  CollaborationDocument,
  CollaborationInputBatchReference,
  CollaborationInputObservation,
  CollaborationLimits,
  CollaborationOpenPlanFinalIntentInput,
  CollaborationOpenPlanPublishIntent,
  collaborationPlanSettlementSchema,
  CollaborationReplyIntentBasis,
  CollaborationRetainedPlan,
  CollaborationReviewObservation,
  CollaborationTask,
  CollaborationTurnAuthorization,
  ConversationActivityChange,
  ConversationGetInput,
  ConversationMessage,
  ConversationMessageChange,
  ConversationObservation,
  ConversationPage,
  ConversationPatch,
  ConversationQueueState,
  InitialTaskRolesProposal,
  InputRoutingProposal,
  NativeAgentContext,
  NativeRebuildOperation,
  NormalizedAgentEvent,
  OriginSideChat,
  PreparedInformationControl,
  PreparedInputMetadata,
  RebuildInputRecovery,
  RebuildReturnedInputRecord,
  RelayDecisionReceipt,
  RunFailureKind,
  RuntimeAgentId,
  SchedulingHandoff,
  TaskStageRoles,
  UserInformationDeclaration,
  WorkflowRelayCandidateId,
} from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import type { PactDrizzleDatabase } from '../drizzle-database.js'
import type {
  agentRuns,
  collaborationActionReceipts,
  collaborationInputs,
  conversationBodyInputs,
  conversationInputBatches,
  conversationMessages,
  conversationQueueOperations,
  nativeAgentContexts,
  nativeRebuildOperations,
  relayDecisions,
  sessions,
  sessionSettingsRevisions,
  workflowTurns,
} from '../schema/index.js'
import type { WorkspaceArchiveRepository } from '../workspace-archive-repository.js'
import type { SourceQueries } from './helpers.js'
import type {
  BeginRunInput,
  BeginRunResult,
  ConversationInputReceipt,
  ConversationInputWrite,
  FrozenCollaborationAuthorization,
  HandoffSourceRef,
  InputBatchReference,
  PatchInput,
  PreparedInputDispatch,
  PreparedInputSource,
  RelayWorkflowSnapshot,
  RelayWorkflowTurnSource,
  SealedBodyFact,
} from './types.js'

export interface ConversationRepositoryHost {
  readonly database: PactDrizzleDatabase
  readonly archives: WorkspaceArchiveRepository
  readonly schedulingListeners: Set<() => void>
  schedulingRecoveryEpoch: string | undefined
  readonly observations: Map<string, ConversationObservation>
  readonly handoffSourceAgentsCache: Map<string, RuntimeAgentId[] | null>
  completeReadCount: number
  pageReadCount: number
  patchCount: number
  eventTransactionCount: number
  readonly streamLookups: {
    text: { queries: number; returnedRows: number }
    activity: { queries: number; returnedRows: number }
  }
  readonly sourceQueries: SourceQueries

  recordSchedulingRecoveryOrigin(fault: NonNullable<SchedulingHandoff['fault']>): void
  refreshSchedulingRecoveryFacts(sessionId: string): void
  cancelSchedulingRecoveryFaults(sessionId: string): void
  schedulingChanged(): void
  recordSchedulingBusinessActivity(runId: string, completeResponse: boolean): void
  schedulingSettings(): {
    enabled: boolean
    provider: 'openai'
    model: 'gpt-6-luna'
    credential: {
      configured: boolean
      revision: number
    }
    showIndicator: boolean
    revision: number
    updatedAt: string
  }
  schedulingConfigurationGeneration(): number
  nativeIssueMetadata(sessionId: string): import('@pact/contracts').SessionIssues
  nativeMetadataTransaction<T>(sessionId: string, work: (transaction: PactDrizzleDatabase) => T): T
  imagesForMessages(messageIds: string[]): Map<string, ConversationImage[]>
  imagesForMessage(messageId: string, sessionId?: string): ConversationImage[]
  messageImageMetadata(messageId: string): Pick<ConversationMessage, 'images'>
  resolveMessageImages(sessionId: string, ids: string[], ownerKey?: string): ConversationImage[]
  sweepConversationInputs(ownerKey?: string): void
  bodyHasText(row: typeof conversationBodyInputs.$inferSelect): boolean
  bodyInput(
    inputId: string,
    sessionId: string,
    ownerKey: string,
    allowCommitted?: boolean,
  ): typeof conversationBodyInputs.$inferSelect
  bodyCapacity(
    ownerKey: string,
    addedBytes: number,
    newIdentity?: boolean,
    addedParts?: number,
  ): void
  writeConversationInput(input: ConversationInputWrite, ownerKey: string): ConversationInputReceipt
  appendBodyPart(
    row: typeof conversationBodyInputs.$inferSelect,
    offset: number,
    text: string,
  ): ConversationInputReceipt
  readBody(
    row: typeof conversationBodyInputs.$inferSelect,
    collect: boolean,
  ): { text: string; hash: string }
  sealBody(row: typeof conversationBodyInputs.$inferSelect): ConversationInputReceipt
  forkOperation(sessionId: string):
    | {
        id: string
        sessionId: string
        sourceSessionId: string
        sourceMessageId: string
        sourceSequence: number
        revision: number
        ready: boolean
        sides: {
          agentId: 'agy' | 'claude' | 'codex'
          state: 'error' | 'forking' | 'initializing' | 'prepared' | 'ready' | 'unconfirmed'
          nativeSessionId?: string | undefined
          reason?: string | undefined
          canInitialize: boolean
          canContinue: boolean
        }[]
      }
    | undefined
  metadataPatch(
    sessionId: string,
    options?: { draftsChanged?: boolean },
  ): {
    documentProjection?:
      | {
          runId: string
          document: {
            id: string
            sha256: string
            bytes: number
            chars: number
          }
          preparationId: string
          status: 'failed' | 'ready'
          message?: string | undefined
        }
      | undefined
    version: 'conversation-patch-v1'
    runContexts?:
      | {
          runId: string
          order: {
            sequence: number
            rank: number
            id: string
          }
          earlierResponseCount: number
          settled: boolean
        }[]
      | undefined
    queue?:
      | {
          enabled: boolean
          revision: number
          input: {
            id: string
            revision: number
            recipient: 'agy' | 'all' | 'claude' | 'codex'
            preview: string
            workflowCommand: boolean
            state: 'dispatching' | 'paused' | 'queued' | 'unknown'
            delivery?:
              | {
                  runId: string
                  canRemove: boolean
                }
              | undefined
            reason?: string | undefined
            replacesTask?:
              | {
                  kind: 'build' | 'plan' | 'review'
                  actor: 'agy' | 'claude' | 'codex'
                }
              | undefined
            imageCount: number
            commentCount: number
            skillCount: number
          } | null
          returnedInput?:
            | {
                inputId: string
                operationId: string
                expectedRevision: number
                claimId?: string | undefined
                installedCommentsRevision?: number | undefined
                state: 'installed' | 'pending'
              }
            | null
            | undefined
        }
      | undefined
    commentDraftReceipt?:
      | {
          requestId: string
          commentId: string
        }
      | undefined
    sessionId: string
    observation: {
      incarnation: string
      sequence: number
    }
    sendDisposition?: 'held_for_information' | undefined
    preparedInputContinuation?:
      | {
          batchId: string
          revision: number
          clientMessageId: string
          preview: string
          body: {
            id: string
            sha256: string
            bytes: number
            chars: number
          }
          commentCount: number
          hasAnswer: boolean
          phase: 'paused' | 'preparing'
          agentId: 'agy' | 'claude' | 'codex'
          settingsRevision: number
          queueRevision: number
          continuationFingerprint: string
          execution: {
            model: string | null
            effort: string | null
            speed: 'fast' | 'native' | 'standard'
            permissionMode: 'ask' | 'auto' | 'full' | 'native'
          }
          canContinue: boolean
          blockedReason:
            | 'collaboration_active'
            | 'native_interaction'
            | 'native_recovery'
            | 'preparation_active'
            | 'queue_changed'
            | 'session_unavailable'
            | 'source_unavailable'
            | null
        }
      | null
      | undefined
    relaySchedulingDecision?:
      | {
          sessionId: string
          decisionId: string
          revision: number
          version: 'relay-decision-v2'
          handoffId: string
          title: string
          reason: string
          consequence: string
          sources: {
            id: string
            label: string
          }[]
          request:
            | {
                category: 'arrangement_change'
                operation:
                  | {
                      kind: 'reassign_roles'
                      taskId: string
                      afterRunId: string
                      expectedTaskRevision: number
                      expectedRoleRevision: number
                      previousRoles: {
                        version: 'task-stage-roles-v1'
                        revision: number
                        planAuthor: 'agy' | 'claude' | 'codex'
                        planReviewer: 'agy' | 'claude' | 'codex'
                        codeAuthor: 'agy' | 'claude' | 'codex'
                        codeReviewer: 'agy' | 'claude' | 'codex'
                      }
                      proposedRoles: {
                        version: 'task-stage-roles-v1'
                        revision: number
                        planAuthor: 'agy' | 'claude' | 'codex'
                        planReviewer: 'agy' | 'claude' | 'codex'
                        codeAuthor: 'agy' | 'claude' | 'codex'
                        codeReviewer: 'agy' | 'claude' | 'codex'
                      }
                      futureStages: ['implement', 'respond', 'repair', 'code_review']
                      scopeFingerprint: string
                    }
                  | {
                      kind: 'rebuild_native_context'
                      agentId: 'agy' | 'claude' | 'codex'
                      expectedGeneration: number
                      expectedNativeSessionId: string | null
                      expectedRunId: string | null
                      expectedRebuildId: string | null
                      abandonOldWork: boolean
                    }
              }
            | {
                category: 'new_authorization'
                operation: {
                  kind: 'extend_plan_review'
                  taskId: string
                  afterRunId: string
                  actor: 'agy' | 'claude' | 'codex'
                  inputSequence: number
                  planReference: {
                    version: number
                    author?: 'agy' | 'claude' | 'codex' | undefined
                    sourceRunId: string
                    sourceMessageId: string
                    document: {
                      id: string
                      sha256: string
                      bytes: number
                      chars: number
                    }
                  }
                  expectedDiscussionRounds: number
                  maximum: number
                  scopeFingerprint: string
                }
              }
            | {
                category: 'necessary_information'
                consumer: {
                  kind: 'prepared_input_clarification'
                  batchId: string
                  clientMessageId: string
                  requestFingerprint: string
                  sourceFingerprint: string
                  defaultAgentId: 'agy' | 'claude' | 'codex'
                  declaredFieldId?: string | undefined
                }
                field: {
                  fieldId: string
                  prompt: string
                  input:
                    | {
                        kind: 'single'
                        options: {
                          id: string
                          label: string
                        }[]
                      }
                    | {
                        kind: 'text'
                        maxLength: number
                      }
                }
              }
        }
      | null
      | undefined
    session: {
      id: string
      title: string
      titleSource: 'agent' | 'local' | 'placeholder' | 'user'
      status:
        | 'archived'
        | 'building'
        | 'completed'
        | 'discussing'
        | 'draft'
        | 'idle'
        | 'paused'
        | 'plan_ready'
        | 'reviewing'
        | 'waiting_for_user'
      activity: {
        state:
          | 'agent_working'
          | 'completed'
          | 'error'
          | 'idle'
          | 'interrupted'
          | 'paused'
          | 'recovering'
          | 'waiting_for_user'
        agentId?: 'agy' | 'claude' | 'codex' | undefined
        attemptCount?: number | undefined
      }
      hasUnread: boolean
      updatedAt: string
    }
    messages: {
      message: {
        historicalBackgroundReport?: true | undefined
        outputSnapshot?:
          | {
              ordinal: number
              frozen: boolean
              canonical: boolean
              order: {
                sequence: number
                rank: number
                id: string
              }
            }
          | undefined
        skills?:
          | {
              id: string
              agentId: 'agy' | 'claude' | 'codex'
              name: string
              start: number
              end: number
            }[]
          | undefined
        images?:
          | {
              id: string
              name: string
              mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
              bytes: number
              width: number
              height: number
              sha256: string
            }[]
          | undefined
        id: string
        sessionId: string
        runId?: string | undefined
        replyToMessageId?: string | undefined
        role: 'assistant' | 'system' | 'user'
        agentId?: 'agy' | 'claude' | 'codex' | undefined
        route?:
          | {
              type: 'primary'
              agentId: 'agy' | 'claude' | 'codex'
            }
          | {
              type: 'agent'
              agentId: 'agy' | 'claude' | 'codex'
            }
          | {
              type: 'all'
              firstAgentId: 'agy' | 'claude' | 'codex'
              secondAgentId: 'agy' | 'claude' | 'codex'
            }
          | undefined
        pendingAgentId?: 'agy' | 'claude' | 'codex' | undefined
        sourceMessageId?: string | undefined
        originSideChat?:
          | {
              sideChatId: string
              cutoffId: string
              sideChatTitle: string
            }
          | undefined
        contentRevision: number
        state: 'complete' | 'incomplete' | 'streaming'
        sequence: number
        createdAt: string
        updatedAt: string
      }
      mode: 'advance' | 'append' | 'invalidate' | 'metadata' | 'replace'
      text?: string | undefined
      previousRevision?: number | undefined
      contentBytes?: number | undefined
      hasActivities: boolean
      hasComments: boolean
    }[]
    removedMessageIds?: string[] | undefined
    runs: {
      outputSnapshots?:
        | {
            count: number
            lastInputMessageId: string
            lastInputSequence: number
            settled: boolean
          }
        | undefined
      collaboration?:
        | {
            taskId: string
            kind: 'build' | 'plan' | 'review'
            stage:
              | 'code_review'
              | 'collaborate'
              | 'implement'
              | 'plan'
              | 'plan_review'
              | 'repair'
              | 'reply'
              | 'respond'
            planVersion?: number | undefined
          }
        | undefined
      forkSourceRunId?: string | undefined
      id: string
      sessionId: string
      userMessageId: string
      agentId: 'agy' | 'claude' | 'codex'
      status: 'completed' | 'failed' | 'interrupted' | 'recovering' | 'running' | 'starting'
      attemptCount: number
      settingsRevision: number
      model: string | null
      permissionMode?: 'ask' | 'auto' | 'full' | 'native' | undefined
      effort: string | null
      speed?: 'fast' | 'native' | 'standard' | undefined
      observedSpeed?: 'fast' | 'standard' | undefined
      speedDetail?: string | undefined
      nativeSessionId?: string | undefined
      nativeTurnId?: string | undefined
      bindingGeneration?: number | undefined
      executorId?: string | undefined
      controlDisposition?: 'abandoned' | 'retained' | undefined
      dispatchPhase?: 'accepted' | 'ended' | 'not_sent' | 'possibly_sent' | 'rejected' | undefined
      nativeOutcome?: 'completed' | 'failed' | 'interrupted' | undefined
      responseMessageId?: string | undefined
      nativeEffectsState?: 'not_dispatched' | 'pending' | 'settled' | 'unknown' | undefined
      nativeEffectsReason?: string | undefined
      workspaceRecordingUnavailableReason?: string | undefined
      reexecutedFromRunId?: string | undefined
      failureKind?:
        | 'agent_process_crash'
        | 'authentication_required'
        | 'context_limit'
        | 'context_resume_failed'
        | 'native_session_occupied'
        | 'permission_blocked'
        | 'protocol_error'
        | 'quota_or_rate_limit'
        | 'response_too_large'
        | 'runtime_incompatible'
        | 'transient_transport'
        | 'unknown_delivery'
        | 'user_stopped'
        | undefined
      failureMessage?: string | undefined
      handoffMessageCount?: number | undefined
      handoffSourceAgents?: ('agy' | 'claude' | 'codex')[] | undefined
      peerProposal?:
        | {
            id: string
            targetAgentId: 'agy' | 'claude' | 'codex'
            kind: 'challenge' | 'fact_check' | 'review' | 'supplement'
            reason?: string | undefined
            state: 'accepted' | 'dismissed' | 'pending' | 'superseded'
            acceptedMessageId?: string | undefined
          }
        | undefined
      workspaceChanges?:
        | {
            id: string
            runId: string
            sessionId: string
            projectId: string
            agentId: 'agy' | 'claude' | 'codex'
            state: 'mixed' | 'ready' | 'recording' | 'recovery_required' | 'undone'
            revision?: number | undefined
            fileCount: number
            additions: number
            deletions: number
            countsAvailable?: boolean | undefined
            undoUnavailableReason: string | null
            effectsUncertain?: boolean | undefined
            createdAt: string
            finalizedAt: string | null
          }
        | undefined
      createdAt: string
      updatedAt: string
    }[]
    latestRunId?: string | undefined
    activities: {
      activity: {
        id: string
        sessionId: string
        runId: string
        agentId: 'agy' | 'claude' | 'codex'
        nativeId: string
        kind: 'reasoning' | 'tool'
        toolName?: string | undefined
        title: string
        detailRevision: number
        status: 'completed' | 'failed' | 'running'
        sequence: number
        createdAt: string
        updatedAt: string
      }
      mode: 'advance' | 'append' | 'invalidate' | 'metadata' | 'replace'
      detail?: string | undefined
      previousRevision?: number | undefined
      detailBytes?: number | undefined
    }[]
    activityStates: {
      runId: string
      status: 'completed' | 'failed'
    }[]
    nativeContexts?:
      | {
          sessionId: string
          agentId: 'agy' | 'claude' | 'codex'
          permissionRequests?:
            | {
                id: string
                operationId?: string | undefined
                kind?: 'approval' | 'form' | 'questions' | 'url' | undefined
                title: string
                detail: string
                actions?:
                  | {
                      id: string
                      label: string
                      kind: 'allow' | 'cancel' | 'decline' | 'rule'
                      scope?: string | undefined
                      confirmation?: string | undefined
                    }[]
                  | undefined
                defaultToNo?: boolean | undefined
                sessionScope?: string | undefined
                createdAt: string
              }[]
            | undefined
          nativeSessionId: string
          bindingGeneration?: number | undefined
          executorId?: string | undefined
          continuationState?:
            | 'checking'
            | 'ready'
            | 'rebuilding'
            | 'recovery_required'
            | 'responding'
            | 'waiting_user'
            | undefined
          recoveryReason?: string | undefined
          recoveryAction?: 'none' | 'rebuild' | 'retry' | undefined
          rebuildOperation?:
            | {
                id: string
                oldGeneration: number
                stage:
                  | 'completed'
                  | 'creating'
                  | 'failed'
                  | 'preparing'
                  | 'seeding'
                  | 'superseded'
                  | 'unconfirmed'
                provisionalNativeSessionId?: string | undefined
                sourceHash?: string | undefined
                failureReason?: string | undefined
                checkAction?: 'inspect' | 'rebuild' | undefined
              }
            | undefined
          state:
            | 'active'
            | 'interrupted'
            | 'missing'
            | 'rebuilding'
            | 'superseded'
            | 'unavailable'
            | 'uncertain'
          lastRunId?: string | undefined
          recoveryFailureKind?:
            | 'agent_process_crash'
            | 'authentication_required'
            | 'context_limit'
            | 'context_resume_failed'
            | 'native_session_occupied'
            | 'permission_blocked'
            | 'protocol_error'
            | 'quota_or_rate_limit'
            | 'response_too_large'
            | 'runtime_incompatible'
            | 'transient_transport'
            | 'unknown_delivery'
            | 'user_stopped'
            | undefined
          recoveryFailureMessage?: string | undefined
          rebuildMessageCount?: number | undefined
          rebuiltThroughSequence?: number | undefined
          updatedAt: string
        }[]
      | undefined
    rebuildOperations?:
      | {
          agentId: 'agy' | 'claude' | 'codex'
          operation: {
            id: string
            oldGeneration: number
            stage:
              | 'completed'
              | 'creating'
              | 'failed'
              | 'preparing'
              | 'seeding'
              | 'superseded'
              | 'unconfirmed'
            provisionalNativeSessionId?: string | undefined
            sourceHash?: string | undefined
            failureReason?: string | undefined
            checkAction?: 'inspect' | 'rebuild' | undefined
          }
        }[]
      | undefined
    rebuildInputRecovery?:
      | {
          inputBatchRef?:
            | {
                id: string
                revision: number
                memberCount: number
              }
            | undefined
          operationId: string
          agentId: 'agy' | 'claude' | 'codex'
          messageId: string
          bindingGeneration: number
          state: 'installed' | 'pending'
          route:
            | {
                type: 'primary'
                agentId: 'agy' | 'claude' | 'codex'
              }
            | {
                type: 'agent'
                agentId: 'agy' | 'claude' | 'codex'
              }
            | {
                type: 'all'
                firstAgentId: 'agy' | 'claude' | 'codex'
                secondAgentId: 'agy' | 'claude' | 'codex'
              }
          commentIds: string[]
          draftEligibility?:
            | {
                commentsRevision: number
                canRestore: boolean
              }
            | undefined
        }
      | null
      | undefined
    forkOperation?:
      | {
          id: string
          sessionId: string
          sourceSessionId: string
          sourceMessageId: string
          sourceSequence: number
          revision: number
          ready: boolean
          sides: {
            agentId: 'agy' | 'claude' | 'codex'
            state: 'error' | 'forking' | 'initializing' | 'prepared' | 'ready' | 'unconfirmed'
            nativeSessionId?: string | undefined
            reason?: string | undefined
            canInitialize: boolean
            canContinue: boolean
          }[]
        }
      | undefined
    forkBlocked?: boolean | undefined
    sessionIssues?:
      | {
          sessionId: string
          inputGate: 'open' | 'read_only' | 'send_blocked'
          agents: {
            agentId: 'agy' | 'claude' | 'codex'
            generation: number
            nativeSessionId?: string | undefined
            runId?: string | undefined
            rebuildId?: string | undefined
            phase:
              | 'background_check'
              | 'background_checking'
              | 'background_stopping'
              | 'background_working'
              | 'checking'
              | 'rebuild_offer'
              | 'rebuilding'
              | 'resolved'
              | 'unconfirmed'
              | 'warning'
            backgroundStop?:
              | {
                  runId: string
                  nativeSessionId: string
                  bindingGeneration: number
                  executorId: string
                }
              | undefined
            title: string
            reason: string
            inputDisposition: 'not_submitted' | 'possibly_submitted' | 'submitted'
            resultDisposition: 'complete' | 'incomplete' | 'pending' | 'unavailable'
            action: 'inspect_rebuild' | 'none' | 'rebuild' | 'retry_check'
            actionReason?: string | undefined
            abandon: boolean
            previousCreationUnconfirmed: boolean
          }[]
        }
      | undefined
    collaborationNotification?:
      | {
          taskId: string
          revision: number
          runId: string
          state: 'auto_continue' | 'complete' | 'failure' | 'needs_user' | 'working'
          agentId?: 'agy' | 'claude' | 'codex' | undefined
        }
      | undefined
    pendingNativeInteractions?:
      | {
          agentId: 'agy' | 'claude' | 'codex'
          bindingGeneration: number
          executorId?: string | undefined
          request: {
            id: string
            operationId?: string | undefined
            kind?: 'approval' | 'form' | 'questions' | 'url' | undefined
            title: string
            detail: string
            actions?:
              | {
                  id: string
                  label: string
                  kind: 'allow' | 'cancel' | 'decline' | 'rule'
                  scope?: string | undefined
                  confirmation?: string | undefined
                }[]
              | undefined
            defaultToNo?: boolean | undefined
            sessionScope?: string | undefined
            createdAt: string
          }
        }[]
      | undefined
    pendingRoutedContinuation?: boolean | undefined
    comments?:
      | {
          revision: number
          upserts: {
            id: string
            sessionId: string
            body: string
            anchor:
              | {
                  type: 'message'
                  messageId: string
                  plan?:
                    | {
                        runId: string
                        version: number
                      }
                    | undefined
                  report?:
                    | {
                        runId: string
                        target: {
                          type: 'summary'
                        }
                      }
                    | undefined
                  contentHash: string
                  textBasis: 'markdown-visible-v1' | 'markdown-visible-v2' | 'plain-visible-v1'
                  startOffset: number
                  endOffset: number
                  quote: string
                }
              | {
                  type: 'file'
                  path: string
                  contentHash: string
                  startLine: number
                  startColumn: number
                  endLine: number
                  endColumn: number
                  quote: string
                }
              | {
                  type: 'cutoff_message'
                  sourceSessionId: string
                  cutoffId: string
                  messageId: string
                  textBasis?:
                    | 'markdown-visible-v1'
                    | 'markdown-visible-v2'
                    | 'plain-visible-v1'
                    | undefined
                  quote: string
                  startOffset: number
                  endOffset: number
                  contentSha256: string
                }
              | {
                  type: 'unavailable'
                  quote: string
                  reason: string
                }
            status: 'draft' | 'sent'
            position: number
            createdAt: string
            updatedAt: string
            sentWithMessageId?: string | undefined
          }[]
          removedIds: string[]
          sent?:
            | {
                messageId: string
                commentIds: string[]
              }
            | undefined
        }
      | undefined
    receivedInputIds?: string[] | undefined
    queuedInputIds?: string[] | undefined
    resync?:
      | {
          messages: boolean
          drafts: boolean
          activityRunIds: string[]
        }
      | undefined
  }
  sessionHasNativeWork(sessionId: string): boolean
  inputBatchForMessage(
    sessionId: string,
    messageId: string,
  ): CollaborationInputBatchReference | undefined
  inputBatchForRun(runId: string): CollaborationInputBatchReference | undefined
  preparedInputSources(batchId: string, check?: () => void): PreparedInputSource[]
  userInformation(
    batch: typeof conversationInputBatches.$inferSelect,
  ):
    | { document: CollaborationDocument; declaration: UserInformationDeclaration; text: string }
    | undefined
  freezeUserInformation(
    batchId: string,
    declaration: UserInformationDeclaration,
    runId?: string,
  ): void
  preparedInputHandoff(batchId: string): SchedulingHandoff
  preparedSourceText(
    receipt: Pick<PreparedInputDispatch, 'batchId' | 'sessionId'>,
    source: PreparedInputSource,
    check?: () => void,
  ): string
  preparedInformation(
    batch: typeof conversationInputBatches.$inferSelect,
  ): PreparedInformationControl | undefined
  writePreparedInformation(batchId: string, control: PreparedInformationControl): void
  supersedePausedPreparedInput(sessionId: string, exceptBatchId: string): void
  preparedExecutionFacts(batch: typeof conversationInputBatches.$inferSelect): {
    metadata: PreparedInputMetadata
    session: typeof sessions.$inferSelect
    fingerprint: string
  }
  readPreparedInput(
    input: Extract<ConversationGetInput, { scope: 'prepared-input' }>,
  ): ConversationPage
  isCancelledPreparedInformation(batch: typeof conversationInputBatches.$inferSelect): boolean
  closeCancelledPreparedInformation(batch: typeof conversationInputBatches.$inferSelect): void
  restorePreparedInformationDrafts(
    batch: typeof conversationInputBatches.$inferSelect,
    reason: NonNullable<PreparedInformationControl['pauseReason']>,
    disposition?: 'paused' | 'cancelled',
  ): boolean
  preparedOriginalRequest(batch: typeof conversationInputBatches.$inferSelect): {
    input: {
      sessionId: string
      clientMessageId: string
      batchId: string
      content: string
      expectedCommentsRevision: number
      commentIds: string[]
      routeIntent: 'implicit'
      composerRevision: number
      userInformation?: UserInformationDeclaration
      route?: { type: 'primary' }
      inputId?: string
    }
    receipt: PreparedInputDispatch
  }
  cancelPreparedInputDispatch(
    receipt: Pick<PreparedInputDispatch, 'batchId' | 'sessionId'>,
    reason: NonNullable<PreparedInputMetadata['cancellationReason']>,
  ): boolean
  preparedInputRecipient(
    receipt: PreparedInputDispatch,
    proposal?: InputRoutingProposal | InitialTaskRolesProposal,
  ): RuntimeAgentId
  preparedInitialTaskRoles(
    receipt: PreparedInputDispatch,
    proposal?: InitialTaskRolesProposal,
  ): TaskStageRoles | undefined
  admittedPreparedInputSelection(
    receipt: PreparedInputDispatch,
    proposal?: InputRoutingProposal | InitialTaskRolesProposal,
  ): InputRoutingProposal | InitialTaskRolesProposal | undefined
  finalizePreparedInputDispatch(input: BeginRunInput, runId: string, messageId: string): void
  freezeInputBatch(input: {
    sessionId: string
    clientMessageId: string
    commentsRevision: number
    actor: RuntimeAgentId
    taskId?: string
    runId?: string
    messageId?: string
    inputId?: string
    pendingReceiptId?: string
    preserveDraftComments?: boolean
    userInformation?: UserInformationDeclaration
    batchId?: string
    check?: () => void
  }): InputBatchReference
  freezeCollaborationAuthorization(
    task: CollaborationTask,
    runId: string,
    batch: InputBatchReference,
    sourceManifestRef?: CollaborationDocument,
    userAuthority?: CollaborationTurnAuthorization['userAuthority'],
    relayWorkRef?: CollaborationDocument,
    previousTask?: CollaborationTask,
  ): void
  sealInputBatchSources(batchId: string, runId: string): void
  latestSteerGrant(runId: string): typeof conversationQueueOperations.$inferSelect | undefined
  documentReference(sessionId: string, id: string): CollaborationDocument
  messageDocument(
    sessionId: string,
    runId: string,
    messageId: string,
  ): CollaborationDocument | undefined
  runHasRecordedCodeChanges(sessionId: string, runId: string): boolean
  recordWorkflowPlan(runId: string, plan: { nativeId: string; text: string }): void
  recordWorkflowPlanRetained(runId: string, evidence: CollaborationRetainedPlan): void
  recordWorkflowPlanUnavailable(runId: string): void
  recordOpenPlanFinalIntent(
    runId: string,
    intent: CollaborationOpenPlanFinalIntentInput,
  ): CollaborationOpenPlanPublishIntent | undefined
  workflowOpenPlanPublishIntents(runId: string): CollaborationOpenPlanPublishIntent[]
  readOpenPlanPublishIntentText(runId: string, callKey: string): string | undefined
  projectAppliedPlanUnavailable(
    run: AgentRun,
    turn: Pick<typeof workflowTurns.$inferSelect, 'applied' | 'authorizationJson'>,
    snapshot: CollaborationTask,
  ): CollaborationTask
  workflowPlanCaptureFailed(runId: string): boolean
  workflowPlanSettlement(
    runId: string,
  ): ReturnType<typeof collaborationPlanSettlementSchema.parse> | undefined
  workflowPlanSettled(runId: string): boolean
  workflowPlanRetention(
    runId: string,
    nativeId: string | null,
  ): CollaborationRetainedPlan | undefined
  workflowPlanHasUnansweredInput(runId: string): boolean
  workflowPlanRecoveryState(
    runId: string,
  ): import('./workflow-plan-queries.js').WorkflowPlanRecoveryState | undefined
  needsWorkflowPlanRecovery(runId: string): boolean
  settleWorkflowPlan(
    task: CollaborationTask,
    run: AgentRun,
    auth: CollaborationTurnAuthorization,
    turn: typeof workflowTurns.$inferSelect,
  ): boolean
  recoverAppliedWorkflowResult(runId: string): void
  workflowInputResult(runId: string): CollaborationInputObservation | undefined
  recordWorkflowInputResult(runId: string, result: CollaborationInputObservation): void
  currentReplyIntent(
    task: CollaborationTask,
    run: AgentRun,
    auth: CollaborationTurnAuthorization,
  ): CollaborationReplyIntentBasis | undefined
  finishAskOnly(
    task: CollaborationTask,
    run: AgentRun,
    auth: CollaborationTurnAuthorization,
    nativeCompleted: boolean,
    notice?: string,
  ): void
  restoreAskCheckpoint(
    task: CollaborationTask,
    intent: CollaborationReplyIntentBasis,
    outcome: 'restored' | 'failed',
    notice?: string,
  ): void
  settleWorkflowInput(
    task: CollaborationTask,
    run: AgentRun,
    auth: CollaborationTurnAuthorization,
    turn: typeof workflowTurns.$inferSelect,
    planSettled: boolean,
  ): boolean
  workflowReviewResult(runId: string): CollaborationReviewObservation | undefined
  recordWorkflowReview(runId: string, result: CollaborationReviewObservation): void
  registerWorkflowInput(sessionId: string, messageId: string, askOnly?: boolean): void
  isInTaskReviewCommand(
    task: CollaborationTask | undefined,
    command: 'plan' | 'build' | 'review' | undefined,
  ): boolean
  collaborationTurnAuthorization(runId: string): FrozenCollaborationAuthorization | undefined
  quotedSource(
    sessionId: string,
    messageId: string,
  ): {
    sourceMessageId: string
    sourceRevision: number
    batchId: string | null
    documentsJson: string
  }
  freezeRunSources(runId: string, refs: ReadonlyArray<HandoffSourceRef>, workflow: boolean): void
  sourceDocumentAuthorized(runId: string, document: CollaborationDocument): boolean
  collaborationContextSuffix(messageId: string): string
  readRunArtifacts(
    sessionId: string,
    userMessageIds: string[],
  ): NonNullable<Extract<ConversationPage, { scope: 'messages' }>['runArtifacts']>
  receivedBodyPreview(inputId: string): string
  activePairForSession(
    sessionId: string,
    revision?: number,
  ): [RuntimeAgentId, RuntimeAgentId] | undefined
  queuedSteerDelivery(
    row: typeof collaborationInputs.$inferSelect,
  ): { run: AgentRun; operationId: string; rebuildId: string | undefined } | undefined
  queueState(sessionId: string): ConversationQueueState
  advanceQueue(sessionId: string, reason?: string | null): void
  requireInstalledQueueReturn(sessionId: string, operationId: string): void
  consumeQueuedReturn(sessionId: string, operationId?: string): void
  readQueuedInputSource(
    input: Extract<ConversationGetInput, { scope: 'queued-input' }>,
  ): Extract<ConversationPage, { scope: 'queued-input' }>
  receivedCollaborationInput(
    sessionId: string,
    includeCancelled?: boolean,
  ):
    | {
        id: string
        sessionId: string
        taskId: string | null
        anchorRunId: string
        inputId: string
        metadataJson: string
        digest: string
        actor: 'agy' | 'claude' | 'codex'
        policy: 'immediate_safe_point' | 'next_round'
        state: 'accepted' | 'blocked' | 'cancelled' | 'materialized'
        materializedRunId: string | null
        createdAt: string
        deadline: string
        queueState:
          | 'delivered'
          | 'dispatching'
          | 'paused'
          | 'queued'
          | 'removed'
          | 'returned'
          | 'unknown'
        queueReason: string | null
        queueRevision: number
        preview: string
      }
    | undefined
  assertDecisionInput(
    input: Pick<
      import('@pact/contracts').ConversationSendInput,
      | 'sessionId'
      | 'content'
      | 'replyToDecision'
      | 'freezeDrafts'
      | 'imageIds'
      | 'commentIds'
      | 'skills'
      | 'route'
      | 'returnedInputOperationId'
      | 'queueReturnOperationId'
    >,
  ): void
  receiveCollaborationInput(
    input: import('@pact/contracts').ConversationSendInput,
    inputId: string,
    actor: RuntimeAgentId,
    policy: 'immediate_safe_point' | 'next_round',
    ownerKey: string,
    waitingForWork?: boolean,
    anchorRunId?: string,
    rolePolicy?: CollaborationTask['rolePolicy'],
    options?: {
      originSideChat?: OriginSideChat
      syncMainOperationId?: string
    },
  ): ConversationPatch
  readReceivedInput(sessionId: string):
    | {
        id: string
        sessionId: string
        taskId: string | null
        anchorRunId: string
        inputId: string
        metadataJson: string
        digest: string
        actor: 'agy' | 'claude' | 'codex'
        policy: 'immediate_safe_point' | 'next_round'
        state: 'accepted' | 'blocked' | 'cancelled' | 'materialized'
        materializedRunId: string | null
        createdAt: string
        deadline: string
        queueState:
          | 'delivered'
          | 'dispatching'
          | 'paused'
          | 'queued'
          | 'removed'
          | 'returned'
          | 'unknown'
        queueReason: string | null
        queueRevision: number
        preview: string
        manuallyResumed: boolean
        content: string
        metadata: {
          steerSkillInvocation?:
            | {
                id: string
                sha256: string
                bytes: number
                chars: number
              }
            | undefined
          replyIntentBasis?:
            | {
                kind: 'ask_only' | 'explanation_only' | 'repair_role_request'
                inputId: string
                inputDigest: string
                priorInputSequence: number
                taskRevision: number
                review?:
                  | {
                      runId: string
                      actor: 'agy' | 'claude' | 'codex'
                      stage: 'code_review' | 'plan_review'
                      verdict: 'accepted' | 'changes_requested' | 'incomplete' | 'needs_user'
                      supplementPlanReturn?: true | undefined
                      inputSequence: number
                      planReference?:
                        | {
                            version: number
                            author?: 'agy' | 'claude' | 'codex' | undefined
                            sourceRunId: string
                            sourceMessageId: string
                            document: {
                              id: string
                              sha256: string
                              bytes: number
                              chars: number
                            }
                          }
                        | undefined
                      scopeRef?:
                        | {
                            id: string
                            sha256: string
                            bytes: number
                            chars: number
                          }
                        | undefined
                      document: {
                        id: string
                        sha256: string
                        bytes: number
                        chars: number
                      }
                    }
                  | undefined
                stageRoles?:
                  | {
                      version: 'task-stage-roles-v1'
                      revision: number
                      planAuthor: 'agy' | 'claude' | 'codex'
                      planReviewer: 'agy' | 'claude' | 'codex'
                      codeAuthor: 'agy' | 'claude' | 'codex'
                      codeReviewer: 'agy' | 'claude' | 'codex'
                    }
                  | undefined
                planReference?:
                  | {
                      version: number
                      author?: 'agy' | 'claude' | 'codex' | undefined
                      sourceRunId: string
                      sourceMessageId: string
                      document: {
                        id: string
                        sha256: string
                        bytes: number
                        chars: number
                      }
                    }
                  | undefined
                askCheckpoint?:
                  | {
                      stage:
                        | 'code_review'
                        | 'collaborate'
                        | 'implement'
                        | 'plan'
                        | 'plan_review'
                        | 'repair'
                        | 'reply'
                        | 'respond'
                      actor: 'agy' | 'claude' | 'codex'
                      status: 'failed' | 'questions' | 'ready' | 'waiting'
                      automation: 'active' | 'paused'
                      pauseReason?:
                        | 'failure'
                        | 'limit'
                        | 'needs_user'
                        | 'restart'
                        | 'stopped'
                        | 'user'
                        | 'user_message'
                        | undefined
                      nextStage?:
                        | 'code_review'
                        | 'collaborate'
                        | 'implement'
                        | 'plan'
                        | 'plan_review'
                        | 'repair'
                        | 'respond'
                        | undefined
                      notice?: string | undefined
                      planInputSequence?: number | undefined
                      inputBasis?:
                        | {
                            inputSequence: number
                            settled?:
                              | {
                                  runId: string
                                  inputSequence: number
                                }
                              | undefined
                          }
                        | undefined
                    }
                  | undefined
                askBinding?:
                  | {
                      nativeSessionId: string
                      generation: number
                    }
                  | undefined
                priorReviewControl?:
                  | {
                      producerRunId: string
                      fingerprint: string
                    }
                  | undefined
              }
            | undefined
          workflowCommand: boolean
          inTaskReview?: boolean | undefined
          routeIntent?: 'explicit' | 'implicit' | undefined
          rolePolicy?: 'split-stages-v1' | undefined
          skills: {
            id: string
            agentId: 'agy' | 'claude' | 'codex'
            name: string
            start: number
            end: number
          }[]
          imageIds: string[]
          commentIds: string[]
          route?:
            | {
                type: 'primary'
                agentId: 'agy' | 'claude' | 'codex'
              }
            | {
                type: 'agent'
                agentId: 'agy' | 'claude' | 'codex'
              }
            | {
                type: 'all'
                firstAgentId: 'agy' | 'claude' | 'codex'
                secondAgentId: 'agy' | 'claude' | 'codex'
              }
            | {
                type: 'primary'
              }
            | {
                type: 'agent'
                agentId: 'agy' | 'claude' | 'codex'
              }
            | {
                type: 'all'
              }
            | undefined
          replyToDecision?:
            | {
                taskId: string
                runId: string
                decisionInputSequence: number
                expectedInputSequence: number
              }
            | undefined
          replaceTask?:
            | {
                taskId: string
                revision: number
              }
            | undefined
          batchId?: string | undefined
          freezeDrafts?: boolean | undefined
          originSideChat?:
            | {
                sideChatId: string
                cutoffId: string
                sideChatTitle: string
              }
            | undefined
        }
        comments: AnchoredComment[]
        inputBatchRef:
          | {
              id: string
              sessionId: string
              taskId: string | null
              sequence: number
              clientMessageId: string
              commentsRevision: number
              actor: 'agy' | 'claude' | 'codex'
              dispatchState:
                | 'cancelled'
                | 'dispatched'
                | 'paused'
                | 'prepared'
                | 'superseded'
                | null
              dispatchMetadataJson: string | null
              dispatchInformationJson: string | null
              userInformationDocumentJson: string | null
              runId: string | null
              messageId: string | null
              inputId: string | null
              memberCount: number
              bodyDocumentJson: string | null
              bodyState:
                | 'awaiting_confirmation'
                | 'pending_response'
                | 'resolved'
                | 'responded'
                | 'withdrawn'
              state: 'closed' | 'open'
              createdAt: string
              closedAt: string | null
            }
          | undefined
      }
    | undefined
  collaboration(
    sessionId: string,
    runId?: string,
    _hydrate?: boolean,
  ): CollaborationTask | undefined
  saveCollaborationDocument(runId: string, text: string): CollaborationDocument
  collaborationDocumentRow(
    sessionId: string,
    ref: CollaborationDocument,
  ): {
    projectionBasis: 'markdown-visible-v2' | 'plain-visible-v1' | null
    projectionPages: number | null
    sourceRunId: string | null
    pendingReceiptId: string | null
    id: string
    sessionId: string
    clientMessageId: string
    ownerKey: string
    purpose: 'answer' | 'collaboration' | 'cutoff' | 'input'
    bytes: number
    chars: number
    parts: number
    sealed: boolean
    hash: string | null
    committedMessageId: string | null
    createdAt: string
    updatedAt: string
  }
  collaborationCommentDocument(
    sessionId: string,
    anchor: Extract<AnchoredComment['anchor'], { type: 'message' }>,
  ): CollaborationDocument | undefined
  collaborationRawRange(
    sessionId: string,
    source: CollaborationDocument,
    start: number,
    end: number,
  ): string
  collaborationQuote(
    sessionId: string,
    source: CollaborationDocument,
    start: number,
    end: number,
    basis?: 'markdown-visible-v2' | 'plain-visible-v1',
  ): string
  collaborationDocumentText(sessionId: string, ref: CollaborationDocument): string
  storedCollaboration(task: CollaborationTask): CollaborationTask
  assertWorkflowDispatch(runId: string): void
  decodedCollaboration(state: string, _hydrate?: boolean): CollaborationTask
  withdrawInputBatch(batchId: string): void
  saveCollaboration(task: CollaborationTask): void
  planRevisionBasisMatches(current: CollaborationTask, next: CollaborationTask): boolean
  replaceCollaborationTask(
    task: CollaborationTask,
    input: {
      clientMessageId: string
      taskRevision: number
    },
  ): void
  collaborationReplacementProjection(
    task: CollaborationTask,
  ): NonNullable<import('@pact/contracts').CollaborationView['replacement']>
  workflowInputWasNotSent(run: AgentRun): boolean
  finishCollaboration(runId: string, complete: boolean, notice?: string): void
  internalMessage(messageId: string, sessionId: string): ConversationMessage | undefined
  messageChange(
    messageId: string,
    requestedMode: ConversationMessageChange['mode'],
    text?: string,
    previousRevision?: number,
  ): ConversationMessageChange
  activityChange(
    activityId: string,
    requestedMode: ConversationActivityChange['mode'],
    detail?: string,
    previousRevision?: number,
  ): ConversationActivityChange
  createPatch(sessionId: string, input?: PatchInput): ConversationPatch
  submittedRunReceipt(
    input: Pick<
      BeginRunInput,
      | 'sessionId'
      | 'clientMessageId'
      | 'content'
      | 'commentIds'
      | 'expectedCommentsRevision'
      | 'skills'
      | 'route'
      | 'imageIds'
      | 'batchId'
      | 'freezeDrafts'
      | 'preserveDraftComments'
      | 'receivedInputId'
      | 'replyToDecision'
      | 'replaceTask'
      | 'userInformation'
    >,
  ): BeginRunResult | undefined
  actionReceiptBasis(
    task: CollaborationTask,
    next: CollaborationTask,
    handoff: SchedulingHandoff,
  ): {
    handoff: SchedulingHandoff
    taskId: string
    rolePolicy?: CollaborationTask['rolePolicy']
    stageRoles?: CollaborationTask['stageRoles']
    inputSequence: number
    stage: CollaborationTask['stage']
    actor: RuntimeAgentId
    planReference: CollaborationTask['planReference'] | null
    review: CollaborationTask['review'] | null
    reviewScopeRef: CollaborationDocument | null
    previousRunId: string | null
    planRevision?: CollaborationTask['planRevision']
    actorBinding: {
      generation: number
      nativeSessionId: string | null
      continuationState: string | null
      permissions: string
    }
  }
  authorityJson(value: unknown): string
  activeRelayDecisionRow(sessionId: string): typeof relayDecisions.$inferSelect | undefined
  relayWorkflowActionExecutionFingerprint(
    task: CollaborationTask,
    handoff: SchedulingHandoff,
    kind: 'reassign_roles' | 'extend_plan_review',
  ): string
  codeRoleChangeAvailable(
    task: CollaborationTask,
    existingDecisionId?: string,
    allowUnusedSuggestion?: boolean,
  ): boolean
  relayWorkflowActionNext(task: CollaborationTask, _kind: 'extend_plan_review'): CollaborationTask
  planReviewLimits(sessionId: string): CollaborationLimits
  planReviewLimitReached(task: CollaborationTask): boolean
  planReviewExtensionAvailable(task: CollaborationTask): boolean
  isUnansweredRelaySuggestion(row: typeof relayDecisions.$inferSelect): boolean
  discardUnansweredRelaySchedulingDecision(sessionId: string, includePact?: boolean): void
  relayDecisionReceipt(
    input: import('@pact/contracts').RelayDecisionReceiptRead,
  ): RelayDecisionReceipt | undefined
  retireRelayDecisionGates(publish?: (patch: ConversationPatch) => void): void
  recoverRelayDecisionGates(): void
  assertRelayDecisionResolved(sessionId: string, receiptId?: string, newInput?: boolean): void
  collaborationActionProjection(task: CollaborationTask): {
    availableActions: import('@pact/contracts').CollaborationAction[]
  }
  collaborationActionReceipt(input: CollaborationActionInput):
    | {
        id: string
        sessionId: string
        taskId: string
        clientNonce: string
        requestDigest: string
        action: string
        actor: 'agy' | 'claude' | 'codex'
        handoffId: string
        decisionId: string | null
        rootReceiptId: string
        basisJson: string
        state: 'available' | 'bound' | 'cancelled' | 'not_sent' | 'settled' | 'unknown'
        boundRunId: string | null
        budgetReservationId: string | null
        reviewState: 'fulfilled' | 'not_required' | 'pending' | null
        reviewRunId: string | null
        active: boolean
        createdAt: string
        updatedAt: string
      }
    | undefined
  unfinishedWriteSource(
    task: CollaborationTask,
    runId: string,
    forPlanRevision?: boolean,
  ): {
    run: AgentRun
    turn: typeof workflowTurns.$inferSelect
    auth: CollaborationTurnAuthorization
    frozen: CollaborationTask
  }
  originalWriteAuthority(
    task: CollaborationTask,
    preserveLegacy?: boolean,
  ): typeof collaborationActionReceipts.$inferSelect
  originalWriteReceipt(
    task: CollaborationTask,
    source: ReturnType<ConversationRepositoryHost['unfinishedWriteSource']>,
    preserveLegacy: boolean,
    forPlanRevision?: boolean,
  ): typeof collaborationActionReceipts.$inferSelect
  cancelPreparedCollaborationAction(id: string): void
  admitCollaborationAction(
    input: BeginRunInput,
    handoff: SchedulingHandoff | undefined,
    runId: string,
    current: CollaborationTask | undefined,
    candidateId?: WorkflowRelayCandidateId,
    approvedRelayScope?: RelayWorkflowSnapshot,
  ):
    | {
        userAuthority: NonNullable<CollaborationTurnAuthorization['userAuthority']>
        relayWorkRef?: CollaborationDocument
      }
    | undefined
  settleCollaborationAction(run: AgentRun): void
  workflowHandoff(
    task: CollaborationTask,
    actor: RuntimeAgentId,
    inputId?: string,
  ): SchedulingHandoff
  recoveryHandoff(fault: NonNullable<SchedulingHandoff['fault']>): SchedulingHandoff
  assertSchedulingFreshness(node: SchedulingHandoff): void
  relayCompletedTurn(
    task: CollaborationTask,
    row: typeof workflowTurns.$inferSelect | undefined,
  ):
    | {
        source: RelayWorkflowTurnSource
        state: CollaborationTask
        auth: CollaborationTurnAuthorization
        row: typeof workflowTurns.$inferSelect
        run: AgentRun
      }
    | undefined
  relayWorkflowBusinessSources(
    handoff: SchedulingHandoff,
  ): Pick<RelayWorkflowSnapshot, 'task' | 'sourceGrants'> | undefined
  relayWorkflowSnapshot(
    handoff: SchedulingHandoff,
    requestedDecisionId?: string,
  ): RelayWorkflowSnapshot | undefined
  freezeRelayWorkflowSources(
    receivingRunId: string,
    scope: Pick<RelayWorkflowSnapshot, 'task' | 'sourceGrants'>,
  ): void
  workflowDecisionMessageHasImages(messageId: string): boolean
  planRevisionDocumentChunks(
    sessionId: string,
    document: CollaborationDocument,
    check?: () => void,
  ): Generator<string>
  planRevisionAnchorText(
    sessionId: string,
    document: CollaborationDocument,
    check: () => void,
  ): string
  planRevisionAnchorTarget(
    task: CollaborationTask,
    anchor: Extract<AnchoredComment['anchor'], { type: 'message' }>,
    check: () => void,
  ): CollaborationDocument
  decisionEvaluationReceipt(handoff: SchedulingHandoff): { id: string } | undefined
  schedulingBudget(subjectId: string):
    | {
        subjectId: string
        sessionId: string
        evaluationCalls: number
        extraPlanTurns: number
        extraCodeTurns: number
        automaticChecks: number
        automaticResends: number
      }
    | undefined
  handoffReceipt(id: string):
    | {
        id: string
        sessionId: string
        budgetSubjectId: string
        eventId: string
        slot: string
        faultSubjectId: string | null
        factFingerprint: string
        freshnessGuardJson: string
        action: string | null
        runId: string | null
        operationId: string | null
        createdAt: string
      }
    | undefined
  executionInput(runId: string):
    | {
        row: {
          runId: string
          documentJson: string
          requestedJson: string
          effectiveJson: string | null
          executorId: string | null
          nativeSessionId: string | null
          proofJson: string | null
          nativeGeneration: string
          configurationGeneration: number
          utilityEpoch: string
          createdAt: string
        }
        input: {
          version: 1
          runId: string
          document: {
            id: string
            sha256: string
            bytes: number
            chars: number
          }
          inputSha256: string
        }
        requested: {
          provider: 'agy' | 'claude' | 'codex'
          model: string | null
          effort: string | null
          speed: 'fast' | 'native' | 'standard'
          permissionMode: 'ask' | 'auto' | 'full' | 'native'
        }
        effective:
          | {
              version: 1
              provider: 'agy' | 'claude' | 'codex'
              model: string
              effort: {
                known: true
                value: string | null
              }
              speed: 'fast' | 'native' | 'standard'
              permissionMode: 'ask' | 'auto' | 'full' | 'native'
              configurationSha256: string
              provenance:
                | 'agy_applied_settings'
                | 'claude_applied_settings'
                | 'codex_thread_configuration'
            }
          | undefined
        proof:
          | {
              version: 1
              runId: string
              bindingGeneration: number
              nativeGeneration: string
              executorId: string
              nativeSessionId: string
              inputSha256: string
              effectiveSettingsSha256: string
              boundary:
                | {
                    kind: 'host_before_root_start'
                  }
                | {
                    kind: 'codex_root_frame_not_written'
                    requestId: number
                  }
                | {
                    kind: 'claude_root_not_yielded'
                  }
                | {
                    kind: 'agy_root_frame_not_written'
                    requestId?: string | number | undefined
                  }
            }
          | undefined
      }
    | undefined
  hasPendingRoutedContinuation(sessionId: string): boolean
  cancelPendingRoutedContinuation(sessionId: string, reason?: string): ConversationPatch
  retirePendingRoute(sessionId: string, reason: string): string | undefined
  runPatch(runId: string): ConversationPatch
  ownsNativeControl(runId: string): boolean
  ownsBackgroundControl(runId: string): boolean
  mayProjectNativeBody(run: AgentRun): boolean
  nativeFact(runId: string, eventType: string, payload: object): void
  runSettingsAt(
    sessionId: string,
    agentId: RuntimeAgentId,
    revision: number,
  ): {
    permissionMode: (typeof sessionSettingsRevisions.$inferSelect)['claudePermissionMode']
    speed: (typeof sessionSettingsRevisions.$inferSelect)['claudeSpeed']
  }
  observationUnavailable(runId: string, reason: string): ConversationPatch
  isCurrentNativeCursor(run: AgentRun, context: NativeAgentContext): boolean
  latestAgentRun(
    sessionId: string,
    agentId: RuntimeAgentId,
    generation?: number,
  ): AgentRun | undefined
  hasCompleteResponse(runId: string): boolean
  bindingHasUnsettledWork(sessionId: string, agentId: RuntimeAgentId, generation: number): boolean
  settleKnownNativeEnding(
    runId: string,
    failure?: { kind: RunFailureKind; message: string },
  ): ConversationPatch
  nativeRebuildOperation(id: string): NativeRebuildOperation | undefined
  pendingNativeRebuild(
    sessionId: string,
    agentId: RuntimeAgentId,
  ): NativeRebuildOperation | undefined
  lastNativeRebuild(sessionId: string, agentId: RuntimeAgentId): NativeRebuildOperation | undefined
  beginNativeRebuild(input: {
    id: string
    sessionId: string
    agentId: RuntimeAgentId
    expectedGeneration: number
    expectedRunId?: string | null
    abandon: boolean
    reservedNativeSessionId?: string
  }): ConversationPatch
  parseReturnedInput(json: string | null): RebuildReturnedInputRecord | undefined
  rebuildInputRecovery(sessionId: string): RebuildInputRecovery | null
  verifyReturnedInput(
    operationId: string,
    sessionId: string,
  ): {
    row: {
      stage: (typeof nativeRebuildOperations.$inferSelect)['stage']
      agentId: RuntimeAgentId
      returnedInputJson: string | null
    }
    record: RebuildReturnedInputRecord
    message: Omit<typeof conversationMessages.$inferSelect, 'content'> & { content: string }
    batch: typeof conversationInputBatches.$inferSelect
    images: ConversationImage[]
  }
  readReturnedInput(
    sessionId: string,
    operationId: string,
    offset: number,
  ): Extract<ConversationPage, { scope: 'rebuild-input' }>
  comment(commentId: string): AnchoredComment | undefined
  findRun(runId: string): AgentRun | undefined
  commitEvents(
    sessionId: string,
    runId: string,
    events: readonly NormalizedAgentEvent[],
    archive?: boolean,
    bodyState?: 'complete' | 'incomplete',
    sealedBody?: SealedBodyFact,
  ): ConversationPatch
  nativeContexts(sessionId: string): NativeAgentContext[]
  nativeRecoveryBlocksInput(sessionId: string): boolean
  nativeContext(sessionId: string, agentId: RuntimeAgentId): NativeAgentContext | undefined
  toRun(
    row: Omit<
      typeof agentRuns.$inferSelect,
      'handoffSourceIds' | 'nativeInputIdsJson' | 'answerFormat' | 'automaticRecoveryRevoked'
    > & {
      responseMessageId?: string | null
      workflowTaskId?: string | null
      collaborationPlanVersion?: number | null
      outputSnapshotsJson?: string | null
    },
  ): AgentRun
  rebuildOperations(sessionId: string): {
    agentId: 'agy' | 'claude' | 'codex'
    operation: {
      id: string
      oldGeneration: number
      stage:
        | 'completed'
        | 'creating'
        | 'failed'
        | 'preparing'
        | 'seeding'
        | 'superseded'
        | 'unconfirmed'
      provisionalNativeSessionId?: string | undefined
      sourceHash?: string | undefined
      failureReason?: string | undefined
      checkAction?: 'inspect' | 'rebuild' | undefined
    }
  }[]
  projectNativeContext(row: typeof nativeAgentContexts.$inferSelect): NativeAgentContext
}
