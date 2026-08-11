[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'InfluencedX Bradbury Preview Signer'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

Write-Host 'InfluencedX Bradbury Preview signer setup' -ForegroundColor Cyan
Write-Host 'Enter the encrypted keystore export password when prompted.'
Write-Host 'The password will not echo and the submitter will remain disabled.'
Write-Host ''

& node.exe '.\scripts\configure-vercel-submitter-signer.mjs'
$nodeExitCode = $LASTEXITCODE

Write-Host ''
if ($nodeExitCode -eq 0) {
    Write-Host 'Signer configuration completed successfully.' -ForegroundColor Green
} else {
    Write-Host "Signer configuration failed with exit code $nodeExitCode." -ForegroundColor Red
    Write-Host 'No mutation flag was enabled. Review the sanitized error above and retry.'
}

Read-Host 'Press Enter to close this window'
exit $nodeExitCode
