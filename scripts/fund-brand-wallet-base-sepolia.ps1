$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$Host.UI.RawUI.WindowTitle = "InfluencedX Brand Wallet Funding"

Write-Host ""
Write-Host "InfluencedX one-time brand wallet funding" -ForegroundColor Cyan
Write-Host "The window sends only 1 test USDC and 0.002 Base Sepolia ETH to the fixed new brand wallet."
Write-Host "The encrypted deployer password stays hidden and is never saved."
Write-Host ""

node .\scripts\fund-brand-wallet-base-sepolia.mjs --apply
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
  Write-Host "" 
  Write-Host "Funding finished successfully." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "Funding stopped safely with exit code $exitCode." -ForegroundColor Red
}

Read-Host "Press Enter to close this window"
exit $exitCode

