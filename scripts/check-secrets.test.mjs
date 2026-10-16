import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function execute(root, executable, args, env = {}) {
  return spawnSync(executable, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 128 * 1024,
    shell: false,
    windowsHide: true,
  })
}

await test('the real pinned scanner blocks staged and deleted historical credentials without logging them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-secret-gate-'))
  const script = join(root, 'scripts/check-secrets.mjs')
  const secret = randomBytes(32).toString('hex')
  try {
    await mkdir(join(root, 'scripts'))
    await copyFile(new URL('./check-secrets.mjs', import.meta.url), script)
    await copyFile(
      new URL('./script-entry.mjs', import.meta.url),
      join(root, 'scripts/script-entry.mjs'),
    )
    await copyFile(new URL('../.gitleaks.toml', import.meta.url), join(root, '.gitleaks.toml'))
    for (const args of [
      ['init'],
      ['config', 'user.name', 'Fixture'],
      ['config', 'user.email', 'fixture@example.invalid'],
    ])
      assert.equal(execute(root, 'git', args).status, 0)
    assert.equal(execute(root, 'git', ['add', '.']).status, 0)
    const clean = execute(root, process.execPath, [script, '--staged'])
    assert.equal(clean.status, 0, clean.stderr)
    await writeFile(join(root, 'settings.toml'), `API_KEY = "${secret}" # gitleaks:allow\n`)
    await writeFile(join(root, '.gitleaksignore'), '*\n')
    assert.equal(execute(root, 'git', ['add', '.']).status, 0)
    const staged = execute(root, process.execPath, [script, '--staged'])
    assert.equal(staged.status, 1)
    assert.match(staged.stderr, /leaks found/u)
    assert.doesNotMatch(staged.stdout + staged.stderr, new RegExp(secret, 'u'))
    assert.equal(execute(root, 'git', ['commit', '-m', 'Synthetic detection fixture']).status, 0)
    await rm(join(root, 'settings.toml'))
    assert.equal(execute(root, 'git', ['add', '-u']).status, 0)
    assert.equal(execute(root, 'git', ['commit', '-m', 'Remove synthetic fixture']).status, 0)
    const history = execute(root, process.execPath, [script, '--history'])
    assert.equal(history.status, 1)
    assert.match(history.stderr, /leaks found/u)
    assert.doesNotMatch(history.stdout + history.stderr, new RegExp(secret, 'u'))
    const unavailable = execute(root, process.execPath, [script, '--staged'], {
      PACT_GITLEAKS_EXECUTABLE: join(root, 'unavailable-scanner'),
    })
    assert.equal(unavailable.status, 1)
    assert.match(unavailable.stderr, /Install Gitleaks 8\.30\.1/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
