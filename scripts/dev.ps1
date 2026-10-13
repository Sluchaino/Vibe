param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('backend', 'web')]
    [string]$Component,
    [ValidateSet('dev', 'build', 'check', 'test', 'preview', 'install')]
    [string]$WebCommand = 'dev'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot

if ($Component -eq 'backend') {
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
        throw '.NET 10 SDK is required. See docs/DEV_ENVIRONMENT.md.'
    }
    $env:DOTNET_CLI_HOME = Join-Path $projectRoot '.tools\dotnet-home'
    $env:NUGET_PACKAGES = Join-Path $projectRoot '.tools\nuget'
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    $env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
    $env:DOTNET_ADD_GLOBAL_TOOLS_TO_PATH = 'false'
    $env:ASPNETCORE_ENVIRONMENT = 'Development'
    $env:VIBE_LOCAL_CONFIG = Join-Path $projectRoot '.tools\local-development.json'
    if (-not (Test-Path -LiteralPath $env:VIBE_LOCAL_CONFIG)) {
        throw 'Prepare configuration and TLS first: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-local.ps1. See README.md.'
    }
    & dotnet run --project backend/Vibe.Api/Vibe.Api.csproj --configuration Release --no-launch-profile -- --LocalDevelopment:ApplyMigrations=true
    exit $LASTEXITCODE
}

$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) {
    $nodePath = Join-Path $runtimeRoot 'node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) {
        throw 'Node.js is required. See docs/DEV_ENVIRONMENT.md.'
    }
    $env:PATH = (Split-Path -Parent $nodePath) + [IO.Path]::PathSeparator + $env:PATH
}
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pnpmCommand) {
    $pnpmPath = $pnpmCommand.Source
} else {
    $pnpmPath = Join-Path $runtimeRoot 'bin\fallback\pnpm.cmd'
    if (-not (Test-Path -LiteralPath $pnpmPath)) {
        throw 'pnpm is required. See docs/DEV_ENVIRONMENT.md.'
    }
}
if ($WebCommand -eq 'install') {
    & $pnpmPath --dir web install --frozen-lockfile --store-dir (Join-Path $projectRoot '.pnpm-store')
    exit $LASTEXITCODE
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'web\node_modules'))) {
    throw 'Install Web dependencies first: pnpm --dir web install --frozen-lockfile'
}
& $pnpmPath --dir web run $WebCommand
exit $LASTEXITCODE
