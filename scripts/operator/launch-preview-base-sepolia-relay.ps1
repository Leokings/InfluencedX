[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://influencedx-[A-Za-z0-9-]+\.vercel\.app/?$')]
    [string]$PreviewUrl
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'InfluencedX Preview -> Base Sepolia relay'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$webRoot = Join-Path $projectRoot 'web'
$previewEnvironment = Join-Path $webRoot '.vercel\.env.preview.local'
$operator = Join-Path $projectRoot 'scripts\operator\run-preview-base-sepolia-relay.mjs'

if (-not (Test-Path -LiteralPath $previewEnvironment -PathType Leaf)) {
    throw 'The local Vercel Preview environment file is missing. Pull Preview variables first.'
}

# Node --env-file does not overwrite inherited variables. Remove every target
# selector/relayer shortcut that could otherwise redirect this Preview-only run.
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:VERCEL_ENV -ErrorAction SilentlyContinue
Remove-Item Env:VERCEL_TARGET_ENV -ErrorAction SilentlyContinue
Remove-Item Env:VERCEL_URL -ErrorAction SilentlyContinue
Remove-Item Env:BASE_RELAYER_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:BASE_RELAYER_ALLOW_TEST_ONLY_RAW_KEY -ErrorAction SilentlyContinue
Remove-Item Env:BASE_RELAYER_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:BASE_RELAYER_KEYSTORE_PASSWORD_FILE -ErrorAction SilentlyContinue

Set-Location -LiteralPath $webRoot
Write-Host 'InfluencedX one-shot Base Sepolia relay' -ForegroundColor Cyan
Write-Host 'The creator signature, grant token, watcher signatures, and private keys stay in one process.'
Write-Host 'You will confirm the exact transaction and enter the encrypted relayer password once.'
Write-Host ''

& node.exe "--env-file=$previewEnvironment" $operator '--preview-url' $PreviewUrl.TrimEnd('/')
$nodeExitCode = $LASTEXITCODE

Write-Host ''
if ($nodeExitCode -eq 0) {
    Write-Host 'Base Sepolia creator verification confirmed.' -ForegroundColor Green
} else {
    Write-Host "Relay stopped safely with exit code $nodeExitCode." -ForegroundColor Red
}
Write-Host 'No background operator process remains.'
Read-Host 'Press Enter to close this window'
exit $nodeExitCode
