import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import type { DefaultSessionSettings, DefaultSessionSettingsEditorState } from '@pact/contracts'

import { defaultSessionSettingsQueryKeys, unwrapRpcResult } from '../../../query-client'

interface DefaultSessionSettingsFlow {
  editorState: DefaultSessionSettingsEditorState | undefined
  loading: boolean
  saving: boolean
  loadError: string | undefined
  saveError: string | undefined
  retry(): void
  save(settings: DefaultSessionSettings): Promise<boolean>
}

export function useDefaultSessionSettings(enabled: boolean): DefaultSessionSettingsFlow {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  const editorStateQuery = useQuery({
    queryKey: defaultSessionSettingsQueryKeys.editor,
    queryFn: async () => unwrapRpcResult(await window.pact.getDefaultSessionSettingsEditorState()),
    enabled,
    retry: 0,
    staleTime: 0,
  })

  const save = async (settings: DefaultSessionSettings): Promise<boolean> => {
    if (saving) return false
    setSaving(true)
    setSaveError(undefined)
    try {
      const result = await window.pact.saveDefaultSessionSettings({ settings })
      if (!result.ok) {
        setSaveError(result.error.message)
        return false
      }
      queryClient.setQueryData<DefaultSessionSettingsEditorState>(
        defaultSessionSettingsQueryKeys.editor,
        (current) => (current ? { ...current, current: result.value } : current),
      )
      return true
    } catch {
      setSaveError('Couldn’t save the default settings. Try again.')
      return false
    } finally {
      setSaving(false)
    }
  }

  return {
    editorState: editorStateQuery.data,
    loading: editorStateQuery.isFetching,
    saving,
    loadError: editorStateQuery.error?.message,
    saveError,
    retry: () => void editorStateQuery.refetch(),
    save,
  }
}
