[CmdletBinding()]
param(
  [switch]$PreflightOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$deployerKeystore = Join-Path $projectRoot ".secrets\testnet-deployer\grounding-bradbury.keystore.json"
$watcherManifestPath = Join-Path $projectRoot ".secrets\testnet-watcher-addresses.json"
$deploymentManifestPath = Join-Path $projectRoot "deployments\base-sepolia.json"
$deployScript = Join-Path $projectRoot "scripts\deploy-base-sepolia.mjs"
$resolverAddress = "0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2"
$recoveryRegistryTransactionHash = "0x2b71436526cb7fe24e81a2c88e8914121d5b4f1c350fc6946fe6c37cbbf16369"
$recoveryRegistryAddress = "0x10079EF049D283BC3f212CCaC4291b3aC2719C48"
$requiredThreshold = 2

function Assert-EvmAddress([string]$Value, [string]$Label) {
  if ($Value -cnotmatch '^0x[0-9a-fA-F]{40}$') {
    throw "$Label is not a 20-byte EVM address"
  }
}

if (-not (Test-Path -LiteralPath $deployerKeystore -PathType Leaf)) {
  throw "The encrypted testnet deployer keystore is missing. Re-run the GenLayer export step."
}
if (-not (Test-Path -LiteralPath $watcherManifestPath -PathType Leaf)) {
  throw "The public testnet watcher manifest is missing. Run the watcher setup first."
}
if (-not (Test-Path -LiteralPath $deployScript -PathType Leaf)) {
  throw "The Base Sepolia Node deployment script is missing."
}
if (Test-Path -LiteralPath $deploymentManifestPath) {
  throw "Refusing to broadcast: a Base Sepolia deployment manifest already exists."
}

$requiredArtifacts = @(
  "AdProofCreatorRegistry.json",
  "AdProofEscrow.json",
  "AdProofAttestationReceiver.json"
)
foreach ($artifactName in $requiredArtifacts) {
  $artifactPath = Join-Path $projectRoot ("artifacts\base\" + $artifactName)
  if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
    throw "Missing compiled contract artifact: $artifactName. Run npm run contracts:compile first."
  }
}

try {
  $watcherManifest = Get-Content -LiteralPath $watcherManifestPath -Raw | ConvertFrom-Json
} catch {
  throw "The public watcher manifest is not valid JSON."
}

$watchers = @($watcherManifest.addresses)
if ($watchers.Count -ne 3) {
  throw "The public watcher manifest must contain exactly three addresses."
}
if ([int]$watcherManifest.threshold -ne $requiredThreshold) {
  throw "The public watcher manifest threshold must be 2."
}
foreach ($watcher in $watchers) {
  Assert-EvmAddress -Value ([string]$watcher) -Label "Watcher address"
}
$uniqueWatcherCount = @(
  $watchers |
    ForEach-Object { ([string]$_).ToLowerInvariant() } |
    Select-Object -Unique
).Count
if ($uniqueWatcherCount -ne 3) {
  throw "The public watcher manifest contains duplicate addresses."
}
Assert-EvmAddress -Value $resolverAddress -Label "GenLayer resolver"
Assert-EvmAddress -Value $recoveryRegistryAddress -Label "Recovered creator registry"
if ($recoveryRegistryTransactionHash -cnotmatch '^0x[0-9a-fA-F]{64}$') {
  throw "Recovered creator registry transaction is not a 32-byte hash"
}

Write-Host "InfluencedX Base Sepolia deployment preflight" -ForegroundColor Cyan
Write-Host "  resolver: $resolverAddress"
Write-Host "  recovered registry tx: $recoveryRegistryTransactionHash"
Write-Host "  recovered registry: $recoveryRegistryAddress (verified receipt/runtime/owner)"
Write-Host "  watcher threshold: 2 of 3"
foreach ($watcher in $watchers) { Write-Host "  watcher: $watcher" }
Write-Host "  testnet owner: deployer (temporary agreed default)"
Write-Host "  testnet treasury: deployer (temporary agreed default)"
Write-Host "  credential: encrypted GenLayer-exported keystore; password will not echo"

if ($PreflightOnly) {
  Write-Host "Preflight-only mode complete. Nothing was broadcast and the keystore was not opened." -ForegroundColor Green
  return
}

$confirmation = Read-Host "Type DEPLOY BASE SEPOLIA to broadcast the three contracts and wiring transactions"
if ($confirmation -cne "DEPLOY BASE SEPOLIA") {
  throw "Deployment cancelled; confirmation did not match."
}

$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
$reportDirectory = Join-Path $projectRoot "reports"
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
$runId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([Guid]::NewGuid().ToString("N").Substring(0, 8))
$publicLogPath = Join-Path $reportDirectory ("base-sepolia-deploy-" + $runId + ".jsonl")

$managedEnvironment = @(
  "BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY",
  "BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH",
  "BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD",
  "BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD_FILE",
  "BASE_SEPOLIA_RPC_URL",
  "BASE_SEPOLIA_USDC_ADDRESS",
  "BASE_FINAL_OWNER_ADDRESS",
  "BASE_SEPOLIA_TREASURY_ADDRESS",
  "BASE_WATCHER_ADDRESSES",
  "BASE_WATCHER_THRESHOLD",
  "ADPROOF_PROTOCOL_FEE_BPS",
  "GENLAYER_RESOLVER_ADDRESS",
  "BASE_SEPOLIA_RECOVER_REGISTRY_TRANSACTION_HASH"
)
$previousEnvironment = @{}
foreach ($name in $managedEnvironment) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  [Environment]::SetEnvironmentVariable($name, $null, "Process")
}

# Only public configuration is injected. In particular, raw-key and password
# variables stay unset so the existing Node loader performs a hidden TTY prompt.
[Environment]::SetEnvironmentVariable("BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH", $deployerKeystore, "Process")
[Environment]::SetEnvironmentVariable("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org", "Process")
[Environment]::SetEnvironmentVariable("BASE_SEPOLIA_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "Process")
[Environment]::SetEnvironmentVariable("BASE_WATCHER_ADDRESSES", ($watchers -join ","), "Process")
[Environment]::SetEnvironmentVariable("BASE_WATCHER_THRESHOLD", "2", "Process")
[Environment]::SetEnvironmentVariable("ADPROOF_PROTOCOL_FEE_BPS", "250", "Process")
[Environment]::SetEnvironmentVariable("GENLAYER_RESOLVER_ADDRESS", $resolverAddress, "Process")
[Environment]::SetEnvironmentVariable("BASE_SEPOLIA_RECOVER_REGISTRY_TRANSACTION_HASH", $recoveryRegistryTransactionHash, "Process")

$nativePreferenceExists = Test-Path -LiteralPath Variable:PSNativeCommandUseErrorActionPreference
if ($nativePreferenceExists) {
  $previousNativePreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
}

try {
  Push-Location -LiteralPath $projectRoot
  try {
    Write-Host "The Node signer will now request the export password once." -ForegroundColor Yellow
    # Capture stdout only. Stderr remains attached to the terminal for the
    # hidden password prompt; never merging native stderr avoids NativeCommandError.
    & $nodeCommand $deployScript | Tee-Object -FilePath $publicLogPath
    $deployExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($deployExitCode -ne 0) {
    throw "Base Sepolia deployment failed with exit code $deployExitCode. Public stdout: $publicLogPath"
  }
  Write-Host "Base Sepolia deployment completed." -ForegroundColor Green
  Write-Host "Public deployment manifest: $deploymentManifestPath"
  Write-Host "Public command output: $publicLogPath"
} finally {
  if ($nativePreferenceExists) {
    $PSNativeCommandUseErrorActionPreference = $previousNativePreference
  }
  foreach ($name in $managedEnvironment) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
}
