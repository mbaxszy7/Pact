$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pipe = $null
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required' }
    $request = [Console]::ReadLine() | ConvertFrom-Json
    $expected = @('pipe', 'token', 'executable', 'args', 'cwd', 'timeout', 'argumentMode')
    $actual = @($request.PSObject.Properties.Name)
    if ($actual.Count -ne $expected.Count -or @($actual | Where-Object { $_ -notin $expected }).Count -ne 0 -or
        $request.argumentMode -notin @('crt', 'nsis') -or $request.args -isnot [array] -or $request.args.Count -gt 128) {
        throw 'Invalid private Windows Job descriptor'
    }
    if ($request.argumentMode -eq 'nsis') {
        if ($request.args.Count -notin @(1, 2) -or $request.args[0] -cne '/S') { throw 'Invalid named NSIS invocation' }
        if ($request.args.Count -eq 2) {
            $tail = $request.args[1]
            if ($tail -isnot [string] -or -not $tail.StartsWith('/D=')) { throw 'Invalid NSIS directory argument' }
            $directory = $tail.Substring(3)
            if ($directory -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))' -or
                $directory.IndexOfAny([char[]]@('"', 0, 13, 10)) -ge 0 -or $directory -match '/D=') { throw 'Invalid owned NSIS directory' }
        }
    }
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
    $code = [PactE2EJob]::Run($request.executable, [string[]]$request.args, $request.cwd, [long]$request.timeout, $writer, $cancel, $request.argumentMode)
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
