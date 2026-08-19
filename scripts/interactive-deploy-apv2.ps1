$ErrorActionPreference = "Stop"

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location -LiteralPath $projectRoot

$keystoreDirectory = Join-Path $projectRoot ".secrets\testnet-deployer"
$keystorePath = Join-Path $keystoreDirectory "grounding-bradbury.keystore.json"
$reportDirectory = Join-Path $projectRoot "reports"
$deployLog = Join-Path $reportDirectory "apv2-deploy-cli.log"

New-Item -ItemType Directory -Force -Path $keystoreDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null

Write-Host "Step 1/3: unlock grounding-bradbury" -ForegroundColor Cyan
& genlayer.cmd account unlock --account grounding-bradbury
if ($LASTEXITCODE -ne 0) { throw "GenLayer account unlock failed" }

if (Test-Path -LiteralPath $keystorePath) {
  Write-Host "Step 2/3: encrypted deployer keystore already exists; keeping it" -ForegroundColor Yellow
} else {
  Write-Host "Step 2/3: export an encrypted Base-compatible keystore" -ForegroundColor Cyan
  Write-Host "Choose and remember this export password. Base deployment will request it once." -ForegroundColor Yellow
  & genlayer.cmd account export --account grounding-bradbury --output $keystorePath
  if ($LASTEXITCODE -ne 0) { throw "GenLayer account export failed" }
}

if (Test-Path -LiteralPath $deployLog) {
  throw "Refusing to overwrite an existing deployment log: $deployLog"
}

Write-Host "Step 3/3: deploy the fresh APV2 resolver to StudioNet" -ForegroundColor Cyan
& genlayer.cmd network set studionet
if ($LASTEXITCODE -ne 0) { throw "Could not select StudioNet" }

$deployCommand = 'genlayer.cmd deploy --contract "contracts\genlayer\AdProofXResolver.py" 2>&1'
& cmd.exe /d /s /c $deployCommand | Tee-Object -FilePath $deployLog
$deployExitCode = $LASTEXITCODE
if ($deployExitCode -ne 0) {
  throw "APV2 deployment command failed with exit code $deployExitCode"
}

Write-Host "APV2 command finished. Codex will verify the receipt and deployed schema." -ForegroundColor Green
