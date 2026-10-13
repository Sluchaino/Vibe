$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else {
    Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js is required. See docs/DEV_ENVIRONMENT.md.' }
& $nodePath scripts/prepare-local.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$certDirectory = Join-Path $projectRoot '.tools\certs'
$certificate = Join-Path $certDirectory 'localhost.pem'
$key = Join-Path $certDirectory 'localhost.key'
if ((Test-Path -LiteralPath $certificate) -xor (Test-Path -LiteralPath $key)) {
    throw 'Incomplete certificate/key pair. Nothing was overwritten. See docs/DEV_ENVIRONMENT.md.'
}
if (-not (Test-Path -LiteralPath $certificate)) {
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '.NET 10 SDK is required.' }
    New-Item -ItemType Directory -Path $certDirectory -Force | Out-Null
    & dotnet dev-certs https --export-path $certificate --format Pem --no-password
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Output 'Local configuration and certificate files are ready. Trust is a separate user action; see README.md.'
