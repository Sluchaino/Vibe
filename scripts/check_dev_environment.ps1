param([switch]$RequireDatabase)

$ErrorActionPreference = 'Stop'

function Find-VibeTool([string]$Name, [string]$Fallback) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    if ($Fallback -and (Test-Path -LiteralPath $Fallback)) { return $Fallback }
    return $null
}

$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$dotnetPath = Find-VibeTool 'dotnet' ''
$nodePath = Find-VibeTool 'node' (Join-Path $runtimeRoot 'node\bin\node.exe')
$pnpmPath = Find-VibeTool 'pnpm' (Join-Path $runtimeRoot 'bin\fallback\pnpm.cmd')
$dockerPath = Find-VibeTool 'docker' (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe')
$ready = $true

foreach ($tool in @(
    @{ Name = '.NET SDK'; Path = $dotnetPath; Arguments = @('--list-sdks') },
    @{ Name = 'Node.js'; Path = $nodePath; Arguments = @('--version') },
    @{ Name = 'pnpm'; Path = $pnpmPath; Arguments = @('--version') }
)) {
    if (-not $tool.Path) {
        Write-Output ('MISSING {0}' -f $tool.Name)
        $ready = $false
        continue
    }
    $arguments = $tool.Arguments
    $result = & $tool.Path @arguments 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $result) {
        Write-Output ('FAIL {0}: {1}' -f $tool.Name, ($result -join ' '))
        $ready = $false
    } else {
        Write-Output ('AVAILABLE {0}: {1}' -f $tool.Name, ($result -join ' '))
        Write-Output ('  {0}' -f $tool.Path)
    }
}

$databaseReady = $false
if ($dockerPath) {
    # Native stderr is captured so an unavailable engine is a reported condition.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $dockerInvocationSucceeded = $false
    $dockerExit = $null
    $dockerResult = @()
    try {
        $dockerResult = & $dockerPath info --format '{{.ServerVersion}}' 2>&1
        $dockerInvocationSucceeded = $?
        $dockerExit = $LASTEXITCODE
    } catch {
        $dockerInvocationSucceeded = $false
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($dockerInvocationSucceeded -and $dockerExit -eq 0 -and $dockerResult) {
        Write-Output ('AVAILABLE Docker engine: {0}' -f ($dockerResult -join ' '))
        $projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
        $composeFile = Join-Path $projectRoot 'compose.yaml'
        $databaseQuery = "SELECT current_database() || ':' || current_user || ':' || CASE WHEN NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole THEN 'limited' ELSE 'privileged' END FROM pg_roles WHERE rolname = current_user;"
        $databaseInvocationSucceeded = $false
        $databaseExit = $null
        $databaseResult = @()
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $databaseResult = & $dockerPath compose -f $composeFile exec -T db psql -U vibe -d vibe -tA -c $databaseQuery 2>&1
            $databaseInvocationSucceeded = $?
            $databaseExit = $LASTEXITCODE
        } catch {
            $databaseInvocationSucceeded = $false
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        $databaseReady = $databaseInvocationSucceeded -and $databaseExit -eq 0 -and ($databaseResult -join '').Trim() -eq 'vibe:vibe:limited'
        if ($databaseReady) {
            Write-Output 'AVAILABLE PostgreSQL: project database vibe; app role vibe without superuser/create privileges.'
            Write-Output '  Local socket query verified; application TCP authentication is checked by Backend tests/startup.'
        } else {
            Write-Output 'UNVERIFIED PostgreSQL: project database/limited role check did not succeed. See README.md.'
        }
    } else {
        Write-Output 'UNAVAILABLE Docker engine: start Docker Desktop before a container database.'
    }
} else {
    Write-Output 'MISSING Docker: a separately installed PostgreSQL is also possible.'
}

Write-Output 'Android tooling is deferred; it is not required for Backend/Web.'
if (-not $ready) { exit 1 }
if ($RequireDatabase -and -not $databaseReady) {
    Write-Output 'UNVERIFIED database connection: project PostgreSQL check did not succeed.'
    exit 2
}
exit 0
