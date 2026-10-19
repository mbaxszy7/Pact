import type { PactDatabase } from '@pact/persistence'

import {
  githubLatestReleaseSchema,
  UPDATE_CHECK_TIMEOUT_MS,
  type RpcResult,
  type UpdateStoredState,
} from '@pact/contracts'

const API = 'https://api.github.com/repos/mbaxszy7/Pact/releases/latest'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** Owns one bounded public GitHub read; never downloads assets or reads credentials. */
export class AppUpdates {
  private controller: AbortController | undefined
  private checking: Promise<RpcResult<UpdateStoredState>> | undefined
  private closed = false

  constructor(private readonly repository: PactDatabase['appUpdatesRepository']) {}

  check(): Promise<RpcResult<UpdateStoredState>> {
    if (this.closed) return Promise.resolve(this.failure('Update checks are unavailable.'))
    this.checking ??= this.readLatest().finally(() => {
      this.checking = undefined
    })
    return this.checking
  }

  private failure(message: string): RpcResult<UpdateStoredState> {
    return { ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message } }
  }

  private async readLatest(): Promise<RpcResult<UpdateStoredState>> {
    const controller = new AbortController()
    this.controller = controller
    const signal = controller.signal
    const deadline = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
    deadline.unref()
    try {
      const stored = this.repository.read()
      if (stored.retryAt && Date.parse(stored.retryAt) > Date.now())
        return this.failure('GitHub is limiting requests. Try again later.')
      const response = await fetch(API, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Pact-release-check',
        },
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 403 || response.status === 429) {
          const after = response.headers.get('retry-after')
          const seconds = after && /^\d+$/u.test(after) ? Number(after) : null
          const retryDate = seconds !== null ? Date.now() + seconds * 1000 : Date.parse(after ?? '')
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
          const until = Math.max(
            Date.now() + 60_000,
            Number.isFinite(retryDate) ? retryDate : 0,
            Number.isFinite(reset) ? reset : 0,
            !after && !reset ? Date.now() + 15 * 60_000 : 0,
          )
          this.repository.deferUntil(
            new Date(Math.min(until, Date.now() + 24 * 60 * 60_000)).toISOString(),
          )
          return this.failure('GitHub is limiting requests. Try again later.')
        }
        return this.failure(
          response.status === 404
            ? 'No published release is available.'
            : 'Couldn’t reach GitHub. Try again.',
        )
      }
      if (!response.body) return this.failure('GitHub returned an incomplete response. Try again.')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- Stream one bounded response without buffering parallel reads.
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > MAX_RESPONSE_BYTES) throw new Error('Response bound')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel()
        reader.releaseLock()
      }
      signal.throwIfAborted()
      const value: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
      const release = githubLatestReleaseSchema.parse(value)
      if (this.closed) return this.failure('Update checks are unavailable.')
      this.repository.saveRelease(release)
      return { ok: true, value: this.repository.read() }
    } catch {
      return this.failure(
        signal.aborted
          ? 'Couldn’t finish checking. Try again.'
          : 'Couldn’t check for updates. Try again.',
      )
    } finally {
      clearTimeout(deadline)
      if (this.controller === controller) this.controller = undefined
    }
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.controller?.abort()
    await this.checking
  }
}
