import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  NativeEvidenceIdentity,
  NativeInitializationWitness,
  NativeProbeResult,
  NormalizedAgentEvent,
  SessionPermissionMode,
  SkillBinding,
} from '@pact/contracts'

import type {
  AgyAcpConnection,
  AgyAcpConnectionPool,
  AgyIngress,
  AgyOrderedSessionStream,
  AgyPoolLease,
} from '../agy-acp-connection'
import type { NativeCheckOperation } from '../native-check-operation'
import type { AgyTrajectoryIdentityClientResult, NativeForkFiles } from '../native-fork-files'
import type { AgySkillProbeOwner } from '../native-skill-catalog'
import type { NativeMemoryReservation } from '../native-working-memory'
import type { AgyLifecycleCoordinator } from './fork-and-rebuild'
import type { AgyNotificationProjector } from './notification-projector'
import type { AgySessionBootstrapper } from './session-bootstrap'
import type { ActiveAgyRun, AgyAgentAdapterOptions, SessionModeState } from './types'

export interface AgyOwnedRunHandle {
  readonly runId: string
  readonly cancel: () => void
  readonly closeZeroInputSession: (deadlineAt?: number) => Promise<void>
  readonly forceCleanup: () => Promise<void>
  readonly finalized: Promise<void>
}

export interface AgyRebuildReceipt {
  nativeSessionId: string
  sourceHash?: string | undefined
  seedHash: string
  cwd: string
  executorId: string
  initializationWitness?: NativeInitializationWitness | undefined
}

export type AgyRecordableEvidence =
  | Omit<Extract<NativeProbeResult, { kind: 'ended' }>, 'identity'>
  | Omit<Extract<NativeProbeResult, { kind: 'running' | 'waiting_user' }>, 'identity'>
  | Omit<Extract<NativeProbeResult, { kind: 'no_evidence' }>, 'identity'>
  | Omit<Extract<NativeProbeResult, { kind: 'missing' }>, 'identity'>

export interface AgyAdapterRuntime {
  readonly id: 'agy'
  readonly executablePath: string
  readonly appDataDirs: readonly string[]
  readonly primaryAppDataDir: string
  readonly pool: AgyAcpConnectionPool
  readonly ownsPool: boolean
  readonly nativeChecks: NativeCheckOperation
  readonly evidenceCacheWork: NativeMemoryReservation
  readonly nativeEvidence: Map<string, NativeProbeResult>
  readonly sessionModes: Map<string, SessionModeState>
  readonly nativeRebuildReceipts: Map<string, AgyRebuildReceipt>
  readonly activeRuns: Map<string, ActiveAgyRun>
  readonly ownedRunHandles: Set<AgyOwnedRunHandle>
  readonly skillProbeOwner: AgySkillProbeOwner
  ownedForkFiles: NativeForkFiles | undefined
  readonly activeOwnedForkFiles: Set<NativeForkFiles>
  disposalPromise: Promise<void> | undefined
  skillCatalogListener: (() => void) | undefined
  nextTurnEpoch: number
  disposed: boolean
  readonly options: AgyAgentAdapterOptions
  readonly bootstrap: AgySessionBootstrapper
  readonly lifecycle: AgyLifecycleCoordinator
  readonly projector: AgyNotificationProjector
  getOwnedForkFiles(): NativeForkFiles
  discoverSkills(cwd: string, signal: AbortSignal): Promise<SkillBinding[]>
  hasOtherActiveRunOnSession(activeRun: ActiveAgyRun): boolean
  evidenceKey(runId: string, nativeSessionId: string): string
  toEvidenceIdentity(
    input: Pick<
      NativeEvidenceIdentity,
      | 'sessionId'
      | 'agentId'
      | 'runId'
      | 'requestId'
      | 'nativeSessionId'
      | 'nativeTurnId'
      | 'bindingGeneration'
      | 'executorId'
    >,
  ): NativeEvidenceIdentity
  invalidateNonTerminalEvidence(runId: string, nativeSessionId: string | undefined): void
  resizeEvidenceCacheWork(): void
  recordEvidence(
    input: Pick<AgentRunInput, 'sessionId' | 'runId' | 'bindingGeneration' | 'host'>,
    nativeSessionId: string,
    executorId: string,
    fact: AgyRecordableEvidence,
    nativeTurnId?: string,
  ): void
}

export type AgyBootstrapTrajectoryLoaderParams = {
  readonly resolvedSessionId: string | undefined
  readonly cwd: string
  readonly observationSignal: AbortSignal
  readonly callerSignal: AbortSignal
  readonly loadSignal: AbortSignal
}

export type AgyBootstrapTrajectoryLoaderResult = AgyTrajectoryIdentityClientResult

export type {
  AgyAcpConnection,
  AgyIngress,
  AgyOrderedSessionStream,
  AgyPoolLease,
  NormalizedAgentEvent,
  SessionPermissionMode,
}
