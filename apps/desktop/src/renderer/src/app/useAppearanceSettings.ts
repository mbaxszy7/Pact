import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import type { AppearanceSettingsUpdate, AppearanceSnapshot } from '@pact/contracts'

import { MATERIAL_OPACITY_MAX, MATERIAL_OPACITY_MIN } from '@pact/contracts'

import { appearanceQueryKeys, unwrapRpcResult } from '../query-client'

export interface AppearanceSettingsFlow {
  snapshot: AppearanceSnapshot | undefined
  settings: AppearanceSnapshot['requested'] | undefined
  loading: boolean
  saving: boolean
  loadError: string | undefined
  saveError: string | undefined
  setPreview: (preview: Omit<AppearanceSettingsUpdate, 'expectedRevision'> | null) => void
  save: (
    kind: 'update' | 'reset',
    update?: Omit<AppearanceSettingsUpdate, 'expectedRevision'>,
  ) => Promise<void>
  saveMaterialOpacity: (materialOpacity: number) => void
  retry: () => void
}

export function useAppearanceSettings(): AppearanceSettingsFlow {
  const queryClient = useQueryClient()
  const [preview, setPreview] = useState<Omit<AppearanceSettingsUpdate, 'expectedRevision'> | null>(
    null,
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  const savingRef = useRef(false)
  const pendingOpacityRef = useRef<number | undefined>(undefined)

  const appearanceQuery = useQuery({
    queryKey: appearanceQueryKeys.settings,
    queryFn: async () => {
      const loaded = unwrapRpcResult(await window.pact.getAppearanceSettings())
      const published = queryClient.getQueryData<AppearanceSnapshot>(appearanceQueryKeys.settings)
      return published && published.requested.revision > loaded.requested.revision
        ? published
        : loaded
    },
    retry: 0,
    staleTime: Number.POSITIVE_INFINITY,
  })

  useEffect(() => {
    return window.pact.onAppearanceSettingsChanged((snapshot) => {
      queryClient.setQueryData<AppearanceSnapshot>(appearanceQueryKeys.settings, (previous) =>
        !previous ||
        snapshot.requested.revision > previous.requested.revision ||
        (snapshot.requested.revision === previous.requested.revision &&
          snapshot.projectionVersion > previous.projectionVersion)
          ? snapshot
          : previous,
      )
    })
  }, [queryClient])

  const snapshot = appearanceQuery.data
  const settings = snapshot?.requested
    ? {
        ...snapshot.requested,
        theme: preview?.theme ?? snapshot.requested.theme,
        windowMaterial: preview?.windowMaterial ?? snapshot.requested.windowMaterial,
        materialOpacity: preview?.materialOpacity ?? snapshot.requested.materialOpacity,
      }
    : undefined

  useEffect(() => {
    const theme = settings?.theme ?? 'system'
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [settings?.theme])

  useEffect(() => {
    const root = document.documentElement
    const material = snapshot?.effective.windowMaterial ?? 'solid'
    root.dataset.material = material
    const opacity = settings?.materialOpacity ?? 85
    const coverage =
      (opacity - MATERIAL_OPACITY_MIN) / (MATERIAL_OPACITY_MAX - MATERIAL_OPACITY_MIN)
    const alpha = (minimum: number, maximum: number): string =>
      `${Math.round((minimum + coverage * (maximum - minimum)) * 1000) / 1000}`
    root.style.setProperty('--pact-material-navigation-alpha', alpha(0.55, 0.9))
    root.style.setProperty('--pact-material-chat-alpha', alpha(0.72, 0.97))
    root.style.setProperty('--pact-material-code-alpha', alpha(0.94, 0.99))
    root.style.setProperty('--pact-material-message-alpha', alpha(0.86, 0.96))
  }, [settings?.materialOpacity, snapshot?.effective.windowMaterial])

  const acceptSnapshot = (next: AppearanceSnapshot): void => {
    queryClient.setQueryData<AppearanceSnapshot>(appearanceQueryKeys.settings, (previous) =>
      !previous ||
      next.requested.revision > previous.requested.revision ||
      (next.requested.revision === previous.requested.revision &&
        next.projectionVersion > previous.projectionVersion)
        ? next
        : previous,
    )
  }

  const save = async (
    kind: 'update' | 'reset',
    update?: Omit<AppearanceSettingsUpdate, 'expectedRevision'>,
  ): Promise<void> => {
    const committedSnapshot =
      queryClient.getQueryData<AppearanceSnapshot>(appearanceQueryKeys.settings) ?? snapshot
    if (!committedSnapshot || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError(undefined)
    setPreview(
      kind === 'reset'
        ? { theme: 'system', windowMaterial: 'system', materialOpacity: 85 }
        : (update ?? null),
    )

    try {
      const result =
        kind === 'reset'
          ? await window.pact.resetAppearanceSettings({
              expectedRevision: committedSnapshot.requested.revision,
            })
          : await window.pact.updateAppearanceSettings({
              expectedRevision: committedSnapshot.requested.revision,
              ...update,
            })

      if (result.ok) {
        acceptSnapshot(result.value)
      } else {
        if (result.error.code === 'UNCERTAIN') {
          setSaveError('Couldn’t confirm the change. Checking the saved setting.')
        } else if (result.error.code === 'CONFLICT') {
          setSaveError('Appearance changed in another window. Showing the latest setting.')
        } else {
          setSaveError('Couldn’t save. Your previous setting has been restored.')
        }
        await appearanceQuery.refetch()
      }
    } catch {
      setSaveError('Couldn’t connect. Your previous setting is still in use.')
      await appearanceQuery.refetch()
    } finally {
      setPreview(null)
      setSaving(false)
      savingRef.current = false
      const pendingOpacity = pendingOpacityRef.current
      pendingOpacityRef.current = undefined
      if (pendingOpacity !== undefined) void save('update', { materialOpacity: pendingOpacity })
    }
  }

  const saveMaterialOpacity = (materialOpacity: number): void => {
    if (savingRef.current) {
      pendingOpacityRef.current = materialOpacity
      return
    }
    void save('update', { materialOpacity })
  }

  return {
    snapshot,
    settings,
    loading: appearanceQuery.isPending,
    saving,
    loadError: appearanceQuery.error?.message,
    saveError,
    setPreview,
    save,
    saveMaterialOpacity,
    retry: () => {
      void appearanceQuery.refetch()
    },
  }
}
