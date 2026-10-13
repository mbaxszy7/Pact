import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { CodexAgentAdapter } from './codex-agent-adapter'

function identity(pid: number): string | undefined {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,stat='], {
      timeout: 1_000,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, LC_ALL: 'C' },
    }).trim()
  } catch {
    return undefined
  }
}

it.skipIf(process.platform === 'win32').each([false, true])(
  'releases the actual Codex app-server helper tree; natural root close=%s',
  async (naturalClose) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pact-codex-tree-')))
    const executable = join(directory, 'codex')
    const helperFile = join(directory, 'helper.json')
    const helperProgram =
      "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),8000);process.stdout.write('ready\\n')"
    await writeFile(
      executable,
      `#!${process.execPath}
const {spawn}=require('node:child_process')
const {writeFileSync}=require('node:fs')
const {createInterface}=require('node:readline')
if(process.argv[2]==='features') {console.log('code_mode_host stable false');process.exit(0)}
if(!process.argv.includes('app-server'))process.exit(2)
const helper=spawn(process.execPath,['-e',${JSON.stringify(helperProgram)}],{stdio:['ignore','pipe','ignore'],shell:false})
helper.stdout.once('data',()=>{writeFileSync(${JSON.stringify(helperFile)},JSON.stringify({pid:helper.pid,parent:process.pid}));helper.stdout.destroy()})
process.on('SIGTERM',()=>process.exit(0))
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line)
 if(request.method==='initialize')process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n')
 if(request.method==='skills/list') {
  const respond=()=>{try {require('node:fs').accessSync(${JSON.stringify(helperFile)});process.stdout.write(JSON.stringify({id:request.id,result:{data:[{cwd:process.cwd(),skills:[],errors:[]}]}})+'\\n');if(${naturalClose})setTimeout(()=>process.exit(0),300)}catch{setTimeout(respond,10)}}
  respond()
 }
})
`,
      { mode: 0o700 },
    )
    const adapter = new CodexAgentAdapter(executable, undefined, { storageRoot: directory })
    let helper: { pid: number; parent: number } | undefined
    let born: string | undefined
    try {
      await expect(
        adapter.discoverSkills(directory, new AbortController().signal),
      ).resolves.toEqual([])
      helper = JSON.parse(await readFile(helperFile, 'utf8'))
      born = identity(helper!.pid)
      expect(born).toBeDefined()
      if (naturalClose) await new Promise((resolve) => setTimeout(resolve, 600))
      await adapter.dispose()
      expect(identity(helper!.pid)).toBeUndefined()
      expect(() => process.kill(-helper!.parent, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      )
    } finally {
      await adapter.dispose().catch(() => undefined)
      if (helper && born && identity(helper.pid) === born) process.kill(helper.pid, 'SIGKILL')
      await rm(directory, { recursive: true, force: true })
    }
  },
  15_000,
)
