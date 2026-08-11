[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'InfluencedX Hosted Settlement Recovery'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot

Write-Host ''
Write-Host 'InfluencedX hosted settlement recovery' -ForegroundColor Cyan
Write-Host 'This reuses the existing relay wallet and keeps every service disabled.'
Write-Host 'Vercel configuration is verified before the deployer password is requested.'
Write-Host ''

& npm.cmd run settlement:resume:preview
$recoveryExitCode = $LASTEXITCODE

Write-Host ''
if ($recoveryExitCode -eq 0) {
  Write-Host 'Hosted settlement recovery completed.' -ForegroundColor Green
} else {
  Write-Host "Recovery stopped safely with exit code $recoveryExitCode." -ForegroundColor Red
  Write-Host 'Do not start a new-wallet setup. Keep this window for the sanitized error.'
}

Read-Host 'Press Enter to close this window'
exit $recoveryExitCode
