[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'InfluencedX StudioNet Base receiver cutover'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

Write-Host ''
Write-Host 'InfluencedX StudioNet cutover' -ForegroundColor Cyan
Write-Host 'STEP 1: type the exact confirmation shown.'
Write-Host 'STEP 2: enter the Base deployer keystore password; each key appears as *.'
Write-Host 'The receiver is paused only during the resolver update and is verified unpaused afterward.'
Write-Host ''

Push-Location -LiteralPath $projectRoot
try {
  & node.exe '.\scripts\cutover-base-receiver-studionet.mjs'
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($exitCode -eq 0) {
  Write-Host ''
  Write-Host 'StudioNet receiver cutover completed and the public manifest was updated.' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host "Cutover stopped safely with exit code $exitCode. Keep this window open." -ForegroundColor Red
}
Read-Host 'Press Enter to close this window'
