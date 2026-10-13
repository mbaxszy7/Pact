import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import type { ProjectCatalogState, ProjectNameChange, RpcResult } from '@pact/contracts'

import { projectNameChangeSchema } from '@pact/contracts'

import { projectCatalogQueryKeys, unwrapRpcResult } from '../../query-client'

interface ProjectCatalogFlow {
  catalog: ProjectCatalogState | undefined
  loading: boolean
  adding: boolean
  archivingProjectId: string | undefined
  restoringProjectId: string | undefined
  renamingProjectId: string | undefined
  error: string | undefined
  retry(): void
  chooseAndAdd(): Promise<void>
  archive(projectId: string): Promise<boolean>
  restore(projectId: string): Promise<boolean>
  rename(projectId: string, name: string): Promise<RpcResult<ProjectNameChange>>
}

export function useProjectCatalog(enabled: boolean): ProjectCatalogFlow {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [archivingProjectId, setArchivingProjectId] = useState<string | undefined>()
  const [restoringProjectId, setRestoringProjectId] = useState<string | undefined>()
  const [renamingProjectId, setRenamingProjectId] = useState<string | undefined>()
  const mutationOwner = useRef({ pending: false, uncertain: false })
  const [actionError, setActionError] = useState<string | undefined>()
  const catalogQuery = useQuery({
    queryKey: projectCatalogQueryKeys.catalog,
    queryFn: async () => {
      const catalog = unwrapRpcResult(await window.pact.getProjectCatalog())
      mutationOwner.current.uncertain = false
      return catalog
    },
    enabled,
    retry: 0,
    staleTime: Number.POSITIVE_INFINITY,
  })

  const beginMutation = async (): Promise<boolean> => {
    const owner = mutationOwner.current
    if (owner.pending) return false
    owner.pending = true
    if (owner.uncertain) {
      const refreshed = await catalogQuery.refetch()
      if (refreshed.isError) {
        owner.pending = false
        setActionError('Couldn’t reload Projects to check the last saved name. Try again.')
        return false
      }
    }
    return true
  }

  const chooseAndAdd = async (): Promise<void> => {
    if (!(await beginMutation())) return
    setAdding(true)
    setActionError(undefined)
    try {
      const result = await window.pact.chooseAndAddProject()
      if (result.ok) {
        queryClient.setQueryData(projectCatalogQueryKeys.catalog, result.value)
      } else {
        setActionError(result.error.message)
      }
    } catch {
      setActionError('Couldn’t add the project. Try again.')
    } finally {
      mutationOwner.current.pending = false
      setAdding(false)
    }
  }

  const archive = async (projectId: string): Promise<boolean> => {
    if (!(await beginMutation())) return false
    setArchivingProjectId(projectId)
    setActionError(undefined)
    try {
      const result = await window.pact.archiveProject(projectId)
      if (result.ok) {
        queryClient.setQueryData(projectCatalogQueryKeys.catalog, result.value)
        return true
      } else {
        setActionError(result.error.message)
      }
    } catch {
      setActionError('Couldn’t archive the Project. Try again.')
    } finally {
      mutationOwner.current.pending = false
      setArchivingProjectId(undefined)
    }
    return false
  }

  const restore = async (projectId: string): Promise<boolean> => {
    if (!(await beginMutation())) return false
    setRestoringProjectId(projectId)
    setActionError(undefined)
    try {
      const result = await window.pact.restoreProject(projectId)
      if (result.ok) {
        queryClient.setQueryData(projectCatalogQueryKeys.catalog, result.value)
        return true
      }
      setActionError(result.error.message)
    } catch {
      setActionError('Couldn’t restore the Project. Try again.')
    } finally {
      mutationOwner.current.pending = false
      setRestoringProjectId(undefined)
    }
    return false
  }

  const rename = async (projectId: string, name: string): Promise<RpcResult<ProjectNameChange>> => {
    const input = projectNameChangeSchema.safeParse({ projectId, name })
    if (!input.success) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Use a single-line name of 1–120 characters.' },
      }
    }
    const owner = mutationOwner.current
    if (owner.pending) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Wait for the current Project action to finish.' },
      }
    }
    owner.pending = true
    setRenamingProjectId(projectId)
    try {
      // An uncertain write is read back before another write can be dispatched.
      if (owner.uncertain) {
        const refreshed = await catalogQuery.refetch()
        if (refreshed.isError) {
          return {
            ok: false,
            error: {
              code: 'UNCERTAIN',
              message: 'Couldn’t reload Projects. Try again to check the saved name.',
            },
          }
        }
        if (
          refreshed.data?.projects.some(
            (project) => project.id === projectId && project.name === input.data.name,
          )
        ) {
          return { ok: true, value: input.data }
        }
      }
      const result = await window.pact.renameProject(input.data)
      if (result.ok) {
        queryClient.setQueryData<ProjectCatalogState>(projectCatalogQueryKeys.catalog, (catalog) =>
          catalog
            ? {
                projects: catalog.projects.map((project) =>
                  project.id === result.value.projectId
                    ? { ...project, name: result.value.name }
                    : project,
                ),
              }
            : catalog,
        )
      } else if (result.error.code === 'UNCERTAIN') {
        owner.uncertain = true
        const refreshed = await catalogQuery.refetch()
        if (
          !refreshed.isError &&
          refreshed.data?.projects.some(
            (project) => project.id === projectId && project.name === input.data.name,
          )
        ) {
          return { ok: true, value: input.data }
        }
      }
      return result
    } catch {
      owner.uncertain = true
      return {
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message: 'Couldn’t confirm the saved name. Try again to reload Projects first.',
        },
      }
    } finally {
      owner.pending = false
      setRenamingProjectId(undefined)
    }
  }

  return {
    catalog: catalogQuery.data,
    loading: catalogQuery.isFetching,
    adding,
    archivingProjectId,
    restoringProjectId,
    renamingProjectId,
    error: actionError ?? catalogQuery.error?.message,
    retry: () => {
      setActionError(undefined)
      void catalogQuery.refetch()
    },
    chooseAndAdd,
    archive,
    restore,
    rename,
  }
}
