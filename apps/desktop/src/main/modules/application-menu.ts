import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  type MenuItem,
  type MenuItemConstructorOptions,
  type WebContents,
  type Input,
} from 'electron'
import { randomUUID } from 'node:crypto'

import {
  composerEditingStateSchema,
  composerEditCommandSchema,
  composerEditReceiptSchema,
  IPC_CHANNELS,
  type ComposerEditingState,
} from '@pact/contracts'

import type { RendererTrust } from '../renderer-trust'

/** One application-menu owner; native input targets keep native roles and Composer owns its history. */
export class ApplicationMenu {
  private readonly previous = Menu.getApplicationMenu()
  private readonly nativeMenu: Menu
  private readonly composerMenu: Menu
  private readonly windows = new Map<WebContents, () => void>()
  private owner: { sender: WebContents; state: ComposerEditingState } | undefined
  private pending:
    | {
        sender: WebContents
        ownerId: string
        requestId: string
        action: 'undo' | 'redo'
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  private selected: Menu | undefined
  private readonly focusChanged = (): void => this.refresh()

  constructor(
    private readonly trust: RendererTrust,
    diagnostics: () => MenuItem,
  ) {
    const base =
      this.previous ??
      Menu.buildFromTemplate(
        process.platform === 'darwin'
          ? [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]
          : [{ role: 'fileMenu' }, { role: 'editMenu' }],
      )
    const clone = (item: MenuItem, composer: boolean): MenuItemConstructorOptions => {
      if (composer && (item.role === 'undo' || item.role === 'redo')) {
        const action = item.role
        return {
          id: `pact-composer-${action}`,
          label: action === 'undo' ? 'Undo' : 'Redo',
          accelerator: action === 'undo' ? 'CommandOrControl+Z' : 'CommandOrControl+Shift+Z',
          click: () => this.dispatch(action),
        }
      }
      return {
        label: item.label,
        ...(item.role ? { role: item.role } : {}),
        type: item.type,
        enabled: item.enabled,
        visible: item.visible,
        checked: item.checked,
        ...(item.accelerator ? { accelerator: item.accelerator } : {}),
        id: item.id,
        ...(item.submenu
          ? { submenu: item.submenu.items.map((child) => clone(child, composer)) }
          : {}),
        click: (clicked, window, event) => item.click(clicked, window, event),
      }
    }
    this.nativeMenu = Menu.buildFromTemplate([
      ...base.items.map((item) => clone(item, false)),
      diagnostics(),
    ])
    this.composerMenu = Menu.buildFromTemplate([
      ...base.items.map((item) => clone(item, true)),
      diagnostics(),
    ])
    ipcMain.handle(IPC_CHANNELS.composerEditingState, (event, raw: unknown) => {
      trust.assertTrustedMainFrame(event)
      const input = composerEditingStateSchema.safeParse(raw)
      if (!input.success)
        return {
          ok: false,
          error: { code: 'VALIDATION', message: 'Invalid Composer editing state.' },
        }
      if (!this.windows.has(event.sender))
        return {
          ok: false,
          error: { code: 'VALIDATION', message: 'This window has no Composer menu owner.' },
        }
      const state = input.data
      if (state.focused) {
        if (this.owner?.state.ownerId !== state.ownerId) this.clearPending()
        this.owner = { sender: event.sender, state }
      } else if (
        this.owner?.sender === event.sender &&
        this.owner.state.ownerId === state.ownerId
      ) {
        this.owner = undefined
        // A delivered command may still explicitly identify the new native input target.
        // Keep its one-second receipt owner; never infer fallback from a blur or timeout.
      }
      this.refresh()
      return { ok: true, value: { ready: true } }
    })
    ipcMain.handle(IPC_CHANNELS.composerEditReceipt, (event, raw: unknown) => {
      trust.assertTrustedMainFrame(event)
      const input = composerEditReceiptSchema.safeParse(raw),
        pending = this.pending
      if (
        input.success &&
        pending &&
        pending.sender === event.sender &&
        pending.ownerId === input.data.ownerId &&
        pending.requestId === input.data.requestId
      ) {
        this.clearPending()
        if (
          input.data.disposition === 'native_target' &&
          !event.sender.isDestroyed() &&
          BrowserWindow.getFocusedWindow()?.webContents === event.sender
        ) {
          if (process.platform === 'darwin') Menu.sendActionToFirstResponder(`${pending.action}:`)
          else if (pending.action === 'undo') event.sender.undo()
          else event.sender.redo()
        }
        this.refresh()
      }
      return { ok: true, value: { ready: true } }
    })
    app.on('browser-window-focus', this.focusChanged)
    app.on('browser-window-blur', this.focusChanged)
    this.refresh()
  }

  attachWindow(window: BrowserWindow): void {
    const contents = window.webContents
    if (this.windows.has(contents)) return
    if (this.windows.size >= 4) return
    const input = (event: Electron.Event, value: Input): void => {
      if (value.type !== 'keyDown' || value.isComposing || !this.active(contents)) return
      const key = value.key.toLowerCase()
      if (
        !(value.meta || value.control) ||
        (key !== 'z' && !(process.platform !== 'darwin' && key === 'y'))
      )
        return
      event.preventDefault()
      this.dispatch(key === 'y' || value.shift ? 'redo' : 'undo')
    }
    const clear = (): void => {
      if (this.owner?.sender === contents) {
        this.owner = undefined
        this.clearPending()
        this.refresh()
      }
    }
    const release = (): void => {
      clear()
      contents.removeListener('before-input-event', input)
      contents.removeListener('did-start-navigation', clear)
      contents.removeListener('render-process-gone', clear)
      contents.removeListener('destroyed', release)
      this.windows.delete(contents)
    }
    contents.on('before-input-event', input)
    contents.on('did-start-navigation', clear)
    contents.on('render-process-gone', clear)
    contents.once('destroyed', release)
    this.windows.set(contents, release)
  }

  private active(contents?: WebContents): boolean {
    const owner = this.owner
    return Boolean(
      owner &&
      !owner.sender.isDestroyed() &&
      owner.state.focused &&
      owner.sender === (contents ?? BrowserWindow.getFocusedWindow()?.webContents),
    )
  }
  private refresh(): void {
    const menu = this.active() ? this.composerMenu : this.nativeMenu
    if (menu === this.composerMenu) {
      const state = this.owner!.state
      const editable = state.editable && !state.composing && !this.pending
      menu.getMenuItemById('pact-composer-undo')!.enabled = editable && state.canUndo
      menu.getMenuItemById('pact-composer-redo')!.enabled = editable && state.canRedo
    }
    if (this.selected !== menu) {
      this.selected = menu
      Menu.setApplicationMenu(menu)
    }
  }
  private dispatch(action: 'undo' | 'redo'): void {
    const owner = this.owner
    if (
      !owner ||
      !this.active() ||
      this.pending ||
      !owner.state.editable ||
      owner.state.composing ||
      !(action === 'undo' ? owner.state.canUndo : owner.state.canRedo)
    )
      return
    const requestId = randomUUID(),
      expiresAt = Date.now() + 1_000
    this.pending = {
      sender: owner.sender,
      ownerId: owner.state.ownerId,
      requestId,
      action,
      timer: setTimeout(() => {
        this.clearPending()
        this.refresh()
      }, 1_000),
    }
    this.refresh()
    try {
      owner.sender.send(
        IPC_CHANNELS.composerEditCommand,
        composerEditCommandSchema.parse({
          ownerId: owner.state.ownerId,
          requestId,
          action,
          expiresAt,
        }),
      )
    } catch {
      this.clearPending()
      this.refresh()
    }
  }
  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = undefined
  }
  dispose(): void {
    this.clearPending()
    this.owner = undefined
    for (const release of this.windows.values()) release()
    app.removeListener('browser-window-focus', this.focusChanged)
    app.removeListener('browser-window-blur', this.focusChanged)
    ipcMain.removeHandler(IPC_CHANNELS.composerEditingState)
    ipcMain.removeHandler(IPC_CHANNELS.composerEditReceipt)
    Menu.setApplicationMenu(this.previous)
  }
}
