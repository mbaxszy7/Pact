$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pipe = $null
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required' }
    $request = [Console]::ReadLine() | ConvertFrom-Json
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $request.pipe, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    $pipe.Connect(5000)
    $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false), 1024, $true)
    $writer.AutoFlush = $true
    $reader = [System.IO.StreamReader]::new($pipe, [System.Text.UTF8Encoding]::new($false), $false, 1024, $true)
    $writer.WriteLine('{"kind":"hello","token":"' + $request.token + '"}')
    $admission = $reader.ReadLineAsync()
    if (-not $admission.Wait(5000) -or $admission.Result -ne 'go') { exit 1 }
    # This pending read observes runner loss even during in-process compilation.
    $cancel = $reader.ReadLineAsync()
    Add-Type -LiteralPath (Join-Path $PSScriptRoot 'windows-e2e-job.cs')
    if ($cancel.IsCompleted) {
        $writer.WriteLine('{"kind":"empty","exitCode":1,"active":0}')
        exit 1
    }
    $code = [PactE2EJob]::Run($request.executable, [string[]]$request.args, $request.cwd, [long]$request.timeout, $writer, $cancel)
    exit $code
} catch {
    if ($null -ne $writer) {
        try { $writer.WriteLine('{"kind":"error","code":0}') } catch { }
    }
    [Console]::Error.WriteLine('Windows E2E supervisor failed; details withheld.')
    exit 1
} finally {
    if ($null -ne $pipe) { $pipe.Dispose() }
}
