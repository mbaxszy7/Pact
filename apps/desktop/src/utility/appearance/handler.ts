import type { AppearanceSettings, AppError, RpcResult, UtilityRequest } from '@pact/contracts'
import type { PactDatabase } from '@pact/persistence'

type AppearanceRequest = Extract<
  UtilityRequest,
  {
    type: 'appearance.get.request' | 'appearance.update.request' | 'appearance.reset.request'
  }
>
type AppearanceRepository = PactDatabase['appearanceSettingsRepository']

const unavailable: AppError = {
  code: 'INTERNAL',
  message: 'Appearance settings are temporarily unavailable.',
}

export function handleAppearanceRequest(
  repository: AppearanceRepository,
  request: AppearanceRequest,
  shouldFailWrites: boolean,
): RpcResult<AppearanceSettings> {
  try {
    if (request.type === 'appearance.get.request') {
      return { ok: true, value: repository.read() }
    }

    if (shouldFailWrites) return { ok: false, error: unavailable }

    const outcome =
      request.type === 'appearance.update.request'
        ? repository.update(request.input)
        : repository.reset(request.input)

    if (outcome.status === 'conflict') {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: `Appearance settings changed at revision ${outcome.currentRevision}; refresh before retrying.`,
        },
      }
    }

    return { ok: true, value: outcome.settings }
  } catch {
    return { ok: false, error: unavailable }
  }
}
