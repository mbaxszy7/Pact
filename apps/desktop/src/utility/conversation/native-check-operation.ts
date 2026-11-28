import type { AgentNativeCheckOperation, AgentNativeCheckContext } from '@pact/agent-runtime'
import type { SchedulingCheckPhysicalOwner } from '@pact/contracts'

import { AgentExecutionError } from './agent-execution-error'

/** One read-only check per Adapter; the Conversation retains the shared operation slot. */
export class NativeCheckOperation {
  private owner:
    | {
        signal: AbortSignal
        controller: AbortController
        requests: Set<Promise<unknown>>
        completion: Promise<void>
        context?: AgentNativeCheckContext | undefined
      }
    | undefined

  constructor(private readonly isCurrent: () => boolean) {}

  get active(): boolean {
    return this.owner !== undefined
  }

  observeRequest(signal: AbortSignal | undefined, physicalCompletion: Promise<unknown>): void {
    const owner = this.owner
    if (!owner || owner.signal !== signal) return
    owner.requests.add(physicalCompletion)
    // Transport completion resolves only on a real reply/not-sent result or physical close.
    void physicalCompletion.then(
      () => owner.requests.delete(physicalCompletion),
      () => undefined,
    )
  }

  contextFor(signal: AbortSignal): AgentNativeCheckContext | undefined {
    return this.owner?.signal === signal ? this.owner.context : undefined
  }

  recordPhysicalOwner(signal: AbortSignal, owner: SchedulingCheckPhysicalOwner): void {
    this.contextFor(signal)?.recordPhysicalOwner(owner)
  }

  begin<T>(
    inputSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<T> {
    if (this.owner)
      return {
        result: Promise.reject(
          new AgentExecutionError(
            'runtime_incompatible',
            'The previous native check still owns physical resources.',
            false,
          ),
        ),
        physicalCompletion: Promise.resolve(),
      }
    const controller = new AbortController()
    const signal = AbortSignal.any([inputSignal, controller.signal])
    const owner = {
      signal,
      controller,
      requests: new Set<Promise<unknown>>(),
      completion: Promise.resolve(),
      context,
    }
    this.owner = owner
    // Register ownership before any asynchronous preparation can start.
    const result = Promise.resolve().then(() => {
      signal.throwIfAborted()
      if (!this.isCurrent())
        throw new AgentExecutionError(
          'agent_process_crash',
          'The native Adapter is shutting down.',
          false,
        )
      return operation(signal)
    })
    const physicalCompletion = result
      .then(
        () => undefined,
        () => undefined,
      )
      .then(async () => {
        await Promise.all(owner.requests)
        if (this.owner === owner) this.owner = undefined
        return undefined
      })
    owner.completion = physicalCompletion
    return { result, physicalCompletion }
  }

  async join(): Promise<void> {
    await this.owner?.completion
  }

  cancel(): void {
    this.owner?.controller.abort()
  }
}
