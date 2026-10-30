import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

import { DefaultSessionSettings } from '../../apps/desktop/src/utility/default-session-settings/default-session-settings.js'
import { RuntimePreparation } from '../../apps/desktop/src/utility/runtime-preparation/runtime-preparation.js'
import { PactDatabase } from '../../packages/persistence/src/pact-database.js'
import {
  cleanupNativeFixture,
  executable,
  isolatedEnv,
  LoopbackProvider,
  ownedRoot,
} from './native-harness.js'

it('reads both actual native model catalogs with idle input, shared ownership and unchanged isolated configuration', async () => {
  const owned = await ownedRoot(),
    provider = new LoopbackProvider()
  let catalogs: DefaultSessionSettings | undefined, db: PactDatabase | undefined
  try {
    const deadlineAt = performance.now() + 30_000
    const codex = await executable('codex', owned, deadlineAt),
      claude = await executable('claude', owned, deadlineAt)
    await provider.start()
    await provider.configureCodex(owned.home)
    await writeFile(
      join(owned.home, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'OWNED_LOOPBACK_ONLY' }),
    )
    const claudeSettings = join(owned.home, 'settings.json')
    await writeFile(
      claudeSettings,
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash' } }),
    )
    const paths = [join(owned.home, 'config.toml'), claudeSettings]
    const before = await Promise.all(paths.map((path) => readFile(path)))
    for (const [key, value] of Object.entries({
      ...isolatedEnv(owned.root, owned.home),
      ANTHROPIC_BASE_URL: provider.url,
    })) {
      if (value !== undefined) vi.stubEnv(key, value)
    }
    db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder: resolve(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    db.runtimePreparationRepository.saveSelectedExecutablePath('codex', codex)
    db.runtimePreparationRepository.saveSelectedExecutablePath('claude', claude)
    const runtime = new RuntimePreparation(db.runtimePreparationRepository)
    const readiness = await runtime.inspectReadiness()
    expect(readiness).toMatchObject({
      ok: true,
      value: {
        agents: [
          { agentId: 'claude', state: 'ready' },
          { agentId: 'codex', state: 'ready' },
        ],
      },
    })
    catalogs = new DefaultSessionSettings(runtime, db.defaultSessionSettingsRepository)
    const [one, two] = await Promise.all([
      catalogs.loadEditorState(owned.cwd),
      catalogs.loadEditorState(owned.cwd),
    ])
    expect(one.ok).toBe(true)
    expect(two).toEqual(one)
    if (!one.ok) throw Error('Native catalogs unavailable')
    expect(one.value.modelCatalogs.codex.status).toBe('available')
    expect(one.value.modelCatalogs.claude.status).toBe('available')
    expect(one.value.modelCatalogs.codex.models.length).toBeGreaterThan(0)
    expect(one.value.modelCatalogs.codex.models.length).toBeLessThanOrEqual(200)
    const haiku = one.value.modelCatalogs.claude.models.find((model) => model.id === 'haiku')
    expect(haiku?.resolvedModel).toBe('deepseek-flash')
    expect(
      provider.requests.every(
        (request) => request.method === 'HEAD' && request.path === '/api/hello',
      ),
    ).toBe(true)
    expect(provider.errors).toEqual([])
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before)
    await catalogs.dispose()
    expect((await catalogs.loadEditorState(owned.cwd)).ok).toBe(false)
  } finally {
    await catalogs?.dispose()
    db?.close()
    vi.unstubAllEnvs()
    await cleanupNativeFixture(owned, { provider })
  }
}, 60_000)
