$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
$configuration = Join-Path $projectRoot '.tools\local-development.json'
if (-not (Test-Path -LiteralPath $configuration)) { throw 'Run scripts/prepare-local.ps1 first.' }
$privateConfiguration = Get-Content -LiteralPath $configuration -Raw | ConvertFrom-Json
if (-not $privateConfiguration.ConnectionStrings.VibeTests) { throw 'Dedicated test database configuration is missing.' }
$env:VIBE_TEST_CONNECTION = $privateConfiguration.ConnectionStrings.VibeTests
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.tools\dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.tools\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
$env:DOTNET_ADD_GLOBAL_TOOLS_TO_PATH = 'false'
& dotnet test backend/Vibe.Api.Tests/Vibe.Api.Tests.csproj -c Release --nologo
exit $LASTEXITCODE
