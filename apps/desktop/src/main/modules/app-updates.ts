import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron'

import {
  IPC_CHANNELS,
  isNewerRelease,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  updateStateSchema,
  updatePreferencesInputSchema,
  updateNoticeInputSchema,
  updateNoticeResultSchema,
  rpcResultSchema,
  type RpcResult,
  type UpdateState,
  type UpdateStoredState,
  type UpdatePreferencesInput,
} from '@pact/contracts'

import type { ApplicationIdentity } from '../application-identity'
import type { RendererTrust } from '../renderer-trust'
import type { UtilityProcessClient, UtilityRequestPayload } from '../utility-process/client'

import { readProductIdentity } from '../product-identity'

type StoredRequest = Extract<
  UtilityRequestPayload,
  { type: 'updates.get.request' | 'updates.check.request' | 'updates.preferences.request' }
>

const output = (state: UpdateState): RpcResult<UpdateState> => ({
  ok: true,
  value: updateStateSchema.parse(state),
})

/** The only update scheduler/presentation owner. Utility owns reads and durable facts. */
export class ApplicationUpdates {
  private data: UpdateStoredState = {
    autoCheck: false,
    revision: 0,
    latest: null,
    checkedAt: null,
    retryAt: null,
    noticePending: false,
  }
  private loaded = false
  private reconcile = false
  private error: string | null = null
  private version = 0
  private settingsRequest = 0
  private nextCheckAt = Date.now() + 30_000
  private timer: ReturnType<typeof setTimeout> | undefined
  private loadTask: Promise<void> | undefined
  private checkTask: Promise<void> | undefined
  private saving = false
  private claiming = false
  private stopped = false
  private readonly currentVersion: string
  private readonly enabled: boolean
  private readonly resume = (): void => this.schedule()

  constructor(
    private readonly utility: UtilityProcessClient,
    identity: ApplicationIdentity,
    private readonly trust: RendererTrust,
    private readonly showWindow: () => void,
  ) {
    this.currentVersion = readProductIdentity(identity).version
    this.enabled =
      app.isPackaged &&
      identity.kind === 'production-ci' &&
      identity.distribution?.channel === 'stable'
    ipcMain.handle(IPC_CHANNELS.updatesGet, async (event) => {
      trust.assertTrustedMainFrame(event)
      await this.load()
      return output(this.snapshot())
    })
    ipcMain.handle(IPC_CHANNELS.updatesCheck, async (event) => {
      trust.assertTrustedMainFrame(event)
      await this.check()
      return output(this.snapshot())
    })
    ipcMain.handle(IPC_CHANNELS.updatesPreferences, async (event, raw: unknown) => {
      trust.assertTrustedMainFrame(event)
      const input = updatePreferencesInputSchema.safeParse(raw)
      if (!input.success)
        return { ok: false, error: { code: 'VALIDATION', message: 'Invalid update preferences.' } }
      await this.setPreferences(input.data)
      return output(this.snapshot())
    })
    ipcMain.handle(IPC_CHANNELS.updatesClaimNotice, async (event, raw: unknown) => {
      trust.assertTrustedMainFrame(event)
      const input = updateNoticeInputSchema.safeParse(raw)
      const window = BrowserWindow.fromWebContents(event.sender)
      if (
        !input.success ||
        !window?.isVisible() ||
        window.isMinimized() ||
        !this.snapshot().updateAvailable ||
        this.data.latest?.version !== input.data.version ||
        !this.data.noticePending ||
        this.stopped ||
        this.claiming
      )
        return { ok: true, value: { claimed: false } }
      this.claiming = true
      try {
        const result = await this.utility.request(
          { type: 'updates.notice.request', input: input.data },
          'updates.notice.response',
        )
        if (result.kind !== 'response' || result.response.type !== 'updates.notice.response')
          return {
            ok: false,
            error: { code: 'UNCERTAIN', message: 'Update notification could not be confirmed.' },
          }
        const parsed = rpcResultSchema(updateNoticeResultSchema).parse(result.response.result)
        if (parsed.ok && parsed.value.claimed && this.data.latest?.version === input.data.version) {
          this.data = { ...this.data, noticePending: false }
          this.publish()
        }
        return parsed
      } finally {
        this.claiming = false
      }
    })
    powerMonitor.on('resume', this.resume)
  }

  snapshot(): UpdateState {
    return updateStateSchema.parse({
      ...this.data,
      enabled: this.enabled,
      preferencesReady: this.loaded && !this.reconcile,
      currentVersion: this.currentVersion,
      checking: Boolean(this.checkTask),
      error: this.error,
      updateAvailable:
        this.enabled &&
        Boolean(this.data.latest && isNewerRelease(this.data.latest.version, this.currentVersion)),
      stateVersion: this.version,
      settingsRequest: this.settingsRequest,
    })
  }

  private publish(): void {
    if (this.stopped) return
    this.version++
    const state = this.snapshot()
    for (const window of this.trust.trustedWindows())
      window.webContents.send(IPC_CHANNELS.updatesChanged, state)
  }

  private async request(input: StoredRequest): Promise<RpcResult<UpdateStoredState>> {
    const result = await this.utility.request(
      input,
      'updates.state.response',
      input.type === 'updates.check.request' ? UPDATE_CHECK_TIMEOUT_MS + 5_000 : 5_000,
    )
    if (result.kind !== 'response')
      return {
        ok: false,
        error: {
          code: result.kind === 'unknown-delivery' ? 'UNCERTAIN' : result.error.code,
          message: 'Update settings are unavailable. Try again.',
        },
      }
    if (result.response.type !== 'updates.state.response')
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Update settings are unavailable. Try again.' },
      }
    return result.response.result
  }

  private load(): Promise<void> {
    if (this.loaded && !this.reconcile) return Promise.resolve()
    this.loadTask ??= (async () => {
      const result = await this.request({ type: 'updates.get.request' })
      if (this.stopped) return
      if (result.ok) {
        this.data = result.value
        this.loaded = true
        this.reconcile = false
        this.error = null
      } else this.error = result.error.message
      this.publish()
    })().finally(() => {
      this.loadTask = undefined
    })
    return this.loadTask
  }

  async start(): Promise<void> {
    await this.load()
    this.schedule()
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.stopped || !this.enabled || !this.loaded || this.reconcile || !this.data.autoCheck)
      return
    const due = Math.max(this.nextCheckAt, this.data.retryAt ? Date.parse(this.data.retryAt) : 0)
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        void this.check()
      },
      Math.max(1, due - Date.now()),
    )
    this.timer.unref()
  }

  check(): Promise<void> {
    if (this.stopped || !this.enabled) return Promise.resolve()
    this.checkTask ??= this.runCheck().finally(() => {
      this.checkTask = undefined
      this.publish()
      this.schedule()
    })
    this.publish()
    return this.checkTask
  }

  private async runCheck(): Promise<void> {
    await this.load()
    if (!this.loaded || this.reconcile || this.stopped) return
    this.nextCheckAt = Date.now() + UPDATE_CHECK_INTERVAL_MS
    this.error = null
    const result = await this.request({ type: 'updates.check.request' })
    if (this.stopped) return
    if (result.ok) this.data = result.value
    else {
      this.error = result.error.message
      const stored = await this.request({ type: 'updates.get.request' })
      if (!this.stopped && stored.ok) this.data = stored.value
    }
  }

  private async setPreferences(input: UpdatePreferencesInput): Promise<void> {
    if (this.stopped || !this.enabled || this.saving) return
    this.saving = true
    try {
      await this.load()
      if (!this.loaded || this.reconcile) return
      const result = await this.request({ type: 'updates.preferences.request', input })
      if (this.stopped) return
      if (result.ok) {
        this.data = result.value
        this.error = null
      } else {
        this.error = result.error.message
        this.reconcile = true
        await this.load()
        if (!this.stopped) this.error = result.error.message
      }
      this.publish()
      this.schedule()
    } finally {
      this.saving = false
    }
  }

  openFromMenu(): void {
    if (this.stopped) return
    this.settingsRequest++
    this.showWindow()
    this.publish()
    void this.check()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    powerMonitor.removeListener('resume', this.resume)
  }

  dispose(): void {
    this.stop()
    for (const channel of [
      IPC_CHANNELS.updatesGet,
      IPC_CHANNELS.updatesCheck,
      IPC_CHANNELS.updatesPreferences,
      IPC_CHANNELS.updatesClaimNotice,
    ])
      ipcMain.removeHandler(channel)
  }
}
