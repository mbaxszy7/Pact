import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { CodexAppServerConnection } from '../../apps/desktop/src/utility/conversation/codex-app-server-connection.js'
import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import { cleanupNativeFixture, executable, isolatedEnv, ownedRoot } from './native-harness.js'

it.runIf(process.platform === 'darwin')(
  'resolves a thread-local provider without writing the original owned config',
  async () => {
    const owned = await ownedRoot(),
      group = new OwnedProcessGroup({ startupObservationMs: 2_000 })
    let connection: CodexAppServerConnection | undefined
    const config =
      'model="gpt-6-luna"\nmodel_provider="original_owned"\n[model_providers.original_owned]\nname="Original Owned"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\nenv_key="PACT_NATIVE_TOKEN"\n'
    try {
      await writeFile(join(owned.home, 'config.toml'), config)
      const binary = await executable('codex', owned)
      connection = new CodexAppServerConnection(
        group.spawn(binary, ['app-server'], {
          cwd: owned.cwd,
          env: isolatedEnv(owned.root, owned.home),
        }),
        undefined,
        () => group.close(),
      )
      const initialized = await connection.request(
        'initialize',
        { clientInfo: { name: 'pact', version: '0.0.0' }, capabilities: { experimentalApi: true } },
        { timeoutMs: 5_000 },
      )
      const ua = Reflect.get(Reflect.get(initialized, 'result') ?? {}, 'userAgent')
      console.info(
        'Owned native product token',
        JSON.stringify({
          product: typeof ua === 'string' ? ua.match(/^[^\s()]+/u)?.[0] : 'unknown',
        }),
      )
      await connection.notify('initialized', {})
      const response = await connection.request(
        'thread/start',
        {
          cwd: owned.cwd,
          ephemeral: true,
          model: 'gpt-6-luna',
          modelProvider: 'owned_thread_guard',
          allowProviderModelFallback: false,
          config: {
            'model_providers.owned_thread_guard': {
              name: 'OpenAI',
              base_url: 'http://127.0.0.1:1/owned-guard/v1',
              wire_api: 'responses',
              requires_openai_auth: false,
              env_key: 'PACT_NATIVE_TOKEN',
              supports_websockets: false,
              request_max_retries: 0,
              stream_max_retries: 0,
            },
          },
        },
        { timeoutMs: 5_000 },
      )
      expect(response).toHaveProperty('result')
      expect(Reflect.get(response, 'result')).toMatchObject({
        model: 'gpt-6-luna',
        modelProvider: 'owned_thread_guard',
      })
      expect(await readFile(join(owned.home, 'config.toml'), 'utf8')).toBe(config)
      console.info(
        'Owned inline provider evidence',
        JSON.stringify({
          exactModel: true,
          threadLocalProvider: true,
          configUnchanged: true,
          modelTurns: 0,
        }),
      )
    } finally {
      await connection?.close()
      await group.close()
      await cleanupNativeFixture(owned)
    }
  },
)
