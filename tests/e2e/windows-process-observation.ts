import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

export interface WindowsProcessIdentity {
  pid: number
  parentPid: number
  executable: string
  started: string
}

const deadline = 2_000
const outputBytes = 4096
const processLimit = 32
const chainDepth = 3
// At most three identities with 2048-character paths plus the Utility receipt.
const ancestryBytes = 64 * 1024
const prefix = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';`

class WindowsProcessObservationError extends Error {
  constructor(readonly reason: 'ambiguous' | 'tree-limit' | 'missing' | 'query') {
    super('Owned Windows process observation did not complete')
  }
}

function validPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid > 0xffffffff)
    throw new Error('Invalid owned process identity')
}

/** A bounded PID-only OS query; never request command lines or environments. */
function query(script: string, input?: string, byteLimit = outputBytes): Promise<unknown> {
  if (process.platform !== 'win32') throw new Error('Windows process observation is unavailable')
  if (input && Buffer.byteLength(input) > byteLimit)
    throw new Error('Owned process request exceeds its bound')
  return new Promise((done, reject) => {
    const child = execFile(
      process.env['PACT_E2E_POWERSHELL_EXECUTABLE'] ?? 'pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', prefix + script],
      {
        timeout: deadline,
        maxBuffer: byteLimit,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) {
          const reason = error.killed
            ? 'query'
            : error.code === 71
              ? 'ambiguous'
              : error.code === 72
                ? 'tree-limit'
                : error.code === 73
                  ? 'missing'
                  : 'query'
          reject(new WindowsProcessObservationError(reason))
          return
        }
        try {
          done(JSON.parse(stdout))
        } catch {
          reject(new Error('Owned Windows process observation was invalid'))
        }
      },
    )
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input ? input + '\n' : undefined)
  })
}

export interface WindowsOwnedAgentProcess {
  pid: number
  utilityPid: number
  utilityStarted: string
  chain: WindowsProcessIdentity[]
}

function validIdentity(value: unknown): value is WindowsProcessIdentity {
  if (!value || typeof value !== 'object') return false
  const pid = Reflect.get(value, 'pid'),
    parent = Reflect.get(value, 'parentPid'),
    executable = Reflect.get(value, 'executable'),
    started = Reflect.get(value, 'started')
  return (
    Number.isSafeInteger(pid) &&
    pid >= 2 &&
    pid <= 0xffffffff &&
    Number.isSafeInteger(parent) &&
    parent >= 0 &&
    parent <= 0xffffffff &&
    typeof executable === 'string' &&
    executable.length <= 2048 &&
    isAbsolute(executable) &&
    typeof started === 'string' &&
    /^\d{1,20}$/u.test(started)
  )
}

/** Complete bounded descendant discovery in one OS observation, with no whole-process-table scan. */
export async function findWindowsOwnedAgentProcess(
  utilityPid: number,
  executable: string,
  agentId: 'claude' | 'codex',
): Promise<WindowsOwnedAgentProcess> {
  validPid(utilityPid)
  if (!isAbsolute(executable) || executable.length > 2048 || !['claude', 'codex'].includes(agentId))
    throw new Error('Invalid selected Agent executable')
  const value = await query(
    String.raw`
$request=[Console]::In.ReadLine()|ConvertFrom-Json
function Identity($p) {
  if($null -eq $p -or [string]::IsNullOrEmpty($p.ExecutablePath) -or $p.ExecutablePath.Length -gt 2048){throw 'Incomplete process identity'}
  [pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;executable=$p.ExecutablePath;started=$p.CreationDate.ToUniversalTime().Ticks.ToString()}
}
$root=Identity (Get-CimInstance Win32_Process -Filter ('ProcessId = '+$request.utilityPid) -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate)
$frontier=@(@{identity=$root;chain=@()})
$agentMatches=[Collections.Generic.List[object]]::new();$inspected=0
for($depth=0;$depth -lt 3 -and $frontier.Count -gt 0;$depth++){
  $parents=@{};foreach($parent in $frontier){$parents[[int]$parent.identity.pid]=$parent}
  $filter=(@($frontier|ForEach-Object{'ParentProcessId = '+[int]$_.identity.pid}) -join ' OR ')
  $remaining=32-$inspected
  $children=@(Get-CimInstance Win32_Process -Filter $filter -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate|Select-Object -First ($remaining+1))
  if($children.Count -gt $remaining){exit 72}
  $next=[Collections.Generic.List[object]]::new()
  foreach($row in $children){
    $inspected++
    $child=Identity $row;if(-not $parents.ContainsKey([int]$child.parentPid)){continue}
    $parent=$parents[[int]$child.parentPid]
    if([bigint]$child.started -lt [bigint]$parent.identity.started){throw 'Owned process ancestry changed'}
    $chain=@($parent.chain)+@($child)
    $name=[IO.Path]::GetFileName($child.executable)
    if([string]::Equals($name,[IO.Path]::GetFileName($request.executable),[StringComparison]::OrdinalIgnoreCase) -or [string]::Equals($name,($request.agentId+'.exe'),[StringComparison]::OrdinalIgnoreCase)){
      $agentMatches.Add(@{pid=$child.pid;utilityPid=$root.pid;utilityStarted=$root.started;chain=$chain})
    }
    $next.Add(@{identity=$child;chain=$chain})
  }
  $frontier=@($next.ToArray())
}
if($agentMatches.Count -gt 1){exit 71}
if($agentMatches.Count -eq 0){exit 73}
ConvertTo-Json -Depth 6 -Compress -InputObject $agentMatches[0]
`,
    JSON.stringify({ utilityPid, executable, agentId }),
    ancestryBytes,
  )
  if (!value || typeof value !== 'object') throw new Error('Invalid owned Agent observation')
  const pid = Reflect.get(value, 'pid'),
    root = Reflect.get(value, 'utilityPid'),
    started = Reflect.get(value, 'utilityStarted'),
    chain: unknown = Reflect.get(value, 'chain')
  if (
    root !== utilityPid ||
    typeof started !== 'string' ||
    !/^\d{1,20}$/u.test(started) ||
    !Array.isArray(chain) ||
    chain.length < 1 ||
    chain.length > chainDepth ||
    !chain.every(validIdentity)
  )
    throw new Error('Invalid owned Agent ancestry')
  let parent = utilityPid,
    birth = BigInt(started)
  for (const entry of chain) {
    if (entry.parentPid !== parent || BigInt(entry.started) < birth)
      throw new Error('Invalid owned Agent ancestry')
    parent = entry.pid
    birth = BigInt(entry.started)
  }
  if (pid !== parent) throw new Error('Invalid owned Agent target')
  return { pid, utilityPid, utilityStarted: started, chain }
}

/** Recheck the entire observed ancestry, then hold the final OS handle through target-only termination. */
export async function stopWindowsOwnedAgentProcess(owned: WindowsOwnedAgentProcess): Promise<void> {
  validPid(owned.utilityPid)
  validPid(owned.pid)
  if (
    !/^\d{1,20}$/u.test(owned.utilityStarted) ||
    owned.chain.length < 1 ||
    owned.chain.length > chainDepth ||
    !owned.chain.every(validIdentity)
  )
    throw new Error('Invalid owned Agent ancestry')
  let parent = owned.utilityPid
  for (const node of owned.chain) {
    if (node.parentPid !== parent) throw new Error('Invalid owned Agent ancestry')
    parent = node.pid
  }
  if (parent !== owned.pid) throw new Error('Invalid owned Agent target')
  const result = await query(
    String.raw`
$expected=[Console]::In.ReadLine()|ConvertFrom-Json
$ids=@([int]$expected.utilityPid)+@($expected.chain|ForEach-Object{[int]$_.pid})
$filter=(@($ids|ForEach-Object{'ProcessId = '+$_}) -join ' OR ')
$rows=@(Get-CimInstance Win32_Process -Filter $filter -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate|Select-Object -First 5)
if($rows.Count -ne $ids.Count){throw 'Owned process identities changed'}
$observed=@{};foreach($row in $rows){if(-not $ids.Contains([int]$row.ProcessId) -or $observed.ContainsKey([int]$row.ProcessId)){throw 'Unexpected process identity'};$observed[[int]$row.ProcessId]=$row}
$root=$observed[[int]$expected.utilityPid]
if($null -eq $root -or $root.CreationDate.ToUniversalTime().Ticks.ToString() -cne $expected.utilityStarted){throw 'Utility identity changed'}
$parent=$expected.utilityPid
foreach($node in $expected.chain){
  $current=$observed[[int]$node.pid]
  if($null -eq $current -or $current.ParentProcessId -ne $parent -or -not [string]::Equals($current.ExecutablePath,$node.executable,[StringComparison]::Ordinal) -or $current.CreationDate.ToUniversalTime().Ticks.ToString() -cne $node.started){throw 'Owned process identity changed'}
  $parent=$node.pid
}
$target=$expected.chain[-1];$p=[Diagnostics.Process]::GetProcessById([int]$target.pid)
try{$handle=$p.SafeHandle;$born=$p.StartTime.ToUniversalTime().Ticks;if([bigint]::Divide([bigint]$born,10) -ne [bigint]::Divide([bigint]$target.started,10) -or -not [string]::Equals($p.MainModule.FileName,[string]$target.executable,[StringComparison]::OrdinalIgnoreCase)){throw 'Owned target identity changed'};$p.Kill();if(-not $p.WaitForExit(1000)){throw 'Owned target did not exit'};'true'}finally{$p.Dispose()}
`,
    JSON.stringify(owned),
    ancestryBytes,
  )
  if (result !== true) throw new Error('Owned Agent termination was not confirmed')
}

export async function windowsChildPids(parentPid: number): Promise<number[]> {
  validPid(parentPid)
  const value = await query(
    `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' -Property ProcessId | Select-Object -First ${processLimit + 1} -ExpandProperty ProcessId)`,
  )
  if (!Array.isArray(value) || value.length > processLimit)
    throw new Error('Owned Windows process children exceed their bound')
  for (const pid of value) {
    if (typeof pid !== 'number') throw new Error('Owned Windows child identity was invalid')
    validPid(pid)
  }
  return value
}

export async function windowsProcessIdentity(pid: number): Promise<WindowsProcessIdentity | null> {
  validPid(pid)
  const value = await query(
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate;if($null -eq $p){'null'}else{[pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;executable=$p.ExecutablePath;started=$p.CreationDate.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`,
  )
  if (value === null) return null
  if (!value || typeof value !== 'object')
    throw new Error('Owned Windows process identity was invalid')
  const observedPid: unknown = Reflect.get(value, 'pid'),
    parentPid: unknown = Reflect.get(value, 'parentPid'),
    executable: unknown = Reflect.get(value, 'executable'),
    started: unknown = Reflect.get(value, 'started')
  if (
    observedPid !== pid ||
    typeof parentPid !== 'number' ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    typeof executable !== 'string' ||
    executable.length > 2048 ||
    !isAbsolute(executable) ||
    typeof started !== 'string' ||
    !/^\d{1,20}$/u.test(started)
  )
    throw new Error('Owned Windows process identity is incomplete')
  return { pid, parentPid, executable, started }
}

/** Hold the selected OS handle while checking birth/path, then terminate only that handle. */
export async function stopWindowsProcess(identity: WindowsProcessIdentity): Promise<void> {
  validPid(identity.pid)
  const outcome = await query(
    `$expected=[Console]::In.ReadLine()|ConvertFrom-Json;$p=[Diagnostics.Process]::GetProcessById([int]$expected.pid);try{$handle=$p.SafeHandle;$born=$p.StartTime.ToUniversalTime().Ticks;if([bigint]::Divide([bigint]$born,10) -ne [bigint]::Divide([bigint]$expected.started,10) -or -not [string]::Equals($p.MainModule.FileName,[string]$expected.executable,[StringComparison]::OrdinalIgnoreCase)){throw 'Owned process identity changed'};$p.Kill();if(-not $p.WaitForExit(1000)){throw 'Owned process did not exit'};'true'}finally{$p.Dispose()}`,
    JSON.stringify(identity),
  )
  if (outcome !== true) throw new Error('Owned Windows process termination was not confirmed')
}
