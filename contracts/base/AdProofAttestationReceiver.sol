// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "./vendor/SignatureChecker.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAdProofRegistryReceiver {
    function recordVerification(
        address wallet,
        bytes32 identityHash,
        bytes32 handleHash,
        bytes32 verificationPostHash,
        bytes32 metricsHash,
        uint64 verifiedAt,
        uint64 expiresAt
    ) external returns (uint256);

    function updateMetrics(
        address wallet,
        bytes32 identityHash,
        bytes32 metricsHash,
        uint64 measuredAt,
        uint64 expiresAt
    ) external;
}

interface IAdProofEscrowReceiver {
    function settle(uint256 assignmentId, bytes32 requestId, uint8 outcome, bytes32 evidenceHash) external;
}

contract AdProofAttestationReceiver is Ownable2Step, EIP712, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;

    uint256 public constant MIN_WATCHERS = 3;
    uint256 public constant MIN_THRESHOLD = 2;

    struct CreatorVerification {
        bytes32 attestationId;
        address wallet;
        bytes32 identityHash;
        bytes32 handleHash;
        bytes32 verificationPostHash;
        bytes32 challengeHash;
        bytes32 metricsHash;
        uint64 verifiedAt;
        uint64 expiresAt;
        bytes32 genlayerContract;
        bytes32 genlayerTxHash;
        uint64 relayDeadline;
    }

    struct MetricsAttestation {
        bytes32 attestationId;
        address wallet;
        bytes32 identityHash;
        bytes32 metricsHash;
        uint64 measuredAt;
        uint64 expiresAt;
        bytes32 genlayerContract;
        bytes32 genlayerTxHash;
        uint64 relayDeadline;
    }

    struct CampaignResolution {
        bytes32 requestId;
        uint256 assignmentId;
        uint8 outcome;
        bytes32 evidenceHash;
        bytes32 genlayerContract;
        bytes32 genlayerTxHash;
        uint64 resolvedAt;
        uint64 relayDeadline;
    }

    bytes32 public constant CREATOR_VERIFICATION_TYPEHASH = keccak256(
        "CreatorVerification(bytes32 attestationId,address wallet,bytes32 identityHash,bytes32 handleHash,bytes32 verificationPostHash,bytes32 challengeHash,bytes32 metricsHash,uint64 verifiedAt,uint64 expiresAt,bytes32 genlayerContract,bytes32 genlayerTxHash,uint64 relayDeadline)"
    );
    bytes32 public constant OWNERSHIP_INTENT_TYPEHASH = keccak256(
        "OwnershipIntent(bytes32 attestationId,address wallet,bytes32 handleHash,bytes32 verificationPostHash,bytes32 challengeHash,uint64 credentialExpiresAt,bytes32 genlayerContract)"
    );
    bytes32 public constant METRICS_ATTESTATION_TYPEHASH = keccak256(
        "MetricsAttestation(bytes32 attestationId,address wallet,bytes32 identityHash,bytes32 metricsHash,uint64 measuredAt,uint64 expiresAt,bytes32 genlayerContract,bytes32 genlayerTxHash,uint64 relayDeadline)"
    );
    bytes32 public constant CAMPAIGN_RESOLUTION_TYPEHASH = keccak256(
        "CampaignResolution(bytes32 requestId,uint256 assignmentId,uint8 outcome,bytes32 evidenceHash,bytes32 genlayerContract,bytes32 genlayerTxHash,uint64 resolvedAt,uint64 relayDeadline)"
    );

    error ZeroAddress();
    error InvalidThreshold();
    error InvalidAttestation();
    error AttestationExpired();
    error AttestationAlreadyUsed();
    error InsufficientSignatures();
    error UnauthorizedWatcher(address signer);
    error SignersNotStrictlyOrdered();
    error WrongGenLayerContract(bytes32 provided);
    error OwnershipIntentExpired();
    error OwnershipIntentAlreadyUsed();
    error InvalidOwnershipIntentSignature();

    event WatcherUpdated(address indexed watcher, bool enabled);
    event ThresholdUpdated(uint256 previousThreshold, uint256 newThreshold);
    event GenLayerContractUpdated(bytes32 indexed previousContract, bytes32 indexed newContract);
    event CreatorVerificationRelayed(bytes32 indexed attestationId, address indexed wallet, bytes32 identityHash);
    event OwnershipIntentConsumed(bytes32 indexed attestationId, address indexed wallet, bytes32 indexed intentDigest);
    event MetricsRelayed(bytes32 indexed attestationId, address indexed wallet, bytes32 metricsHash);
    event CampaignResolutionRelayed(
        bytes32 indexed requestId,
        uint256 indexed assignmentId,
        uint8 outcome,
        bytes32 evidenceHash
    );

    IAdProofRegistryReceiver public immutable creatorRegistry;
    IAdProofEscrowReceiver public immutable escrow;

    bytes32 public genlayerContract;
    mapping(address watcher => bool enabled) public isWatcher;
    mapping(bytes32 attestationId => bool used) public usedAttestations;
    mapping(bytes32 intentDigest => bool used) public usedOwnershipIntents;
    uint256 public watcherCount;
    uint256 public threshold;

    constructor(
        address initialOwner,
        IAdProofRegistryReceiver registry,
        IAdProofEscrowReceiver escrowContract,
        bytes32 initialGenlayerContract,
        address[] memory initialWatchers,
        uint256 initialThreshold
    ) Ownable(initialOwner) EIP712("XProofAttestationReceiver", "2") {
        if (
            initialOwner == address(0) || address(registry) == address(0) || address(escrowContract) == address(0)
                || initialGenlayerContract == bytes32(0)
        ) {
            revert ZeroAddress();
        }
        creatorRegistry = registry;
        escrow = escrowContract;
        genlayerContract = initialGenlayerContract;
        emit GenLayerContractUpdated(bytes32(0), initialGenlayerContract);

        for (uint256 i = 0; i < initialWatchers.length; ++i) {
            address watcher = initialWatchers[i];
            if (watcher == address(0)) revert ZeroAddress();
            if (!isWatcher[watcher]) {
                isWatcher[watcher] = true;
                watcherCount += 1;
                emit WatcherUpdated(watcher, true);
            }
        }
        if (
            watcherCount < MIN_WATCHERS || initialThreshold < MIN_THRESHOLD
                || initialThreshold > watcherCount
        ) revert InvalidThreshold();
        threshold = initialThreshold;
        emit ThresholdUpdated(0, initialThreshold);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setWatcher(address watcher, bool enabled) external onlyOwner {
        if (watcher == address(0)) revert ZeroAddress();
        if (isWatcher[watcher] == enabled) return;
        if (!enabled && watcherCount <= MIN_WATCHERS) revert InvalidThreshold();
        isWatcher[watcher] = enabled;
        if (enabled) {
            watcherCount += 1;
        } else {
            watcherCount -= 1;
            if (threshold > watcherCount) revert InvalidThreshold();
        }
        emit WatcherUpdated(watcher, enabled);
    }

    function setThreshold(uint256 newThreshold) external onlyOwner {
        if (newThreshold < MIN_THRESHOLD || newThreshold > watcherCount) revert InvalidThreshold();
        uint256 previous = threshold;
        threshold = newThreshold;
        emit ThresholdUpdated(previous, newThreshold);
    }

    function setGenLayerContract(bytes32 newContract) external onlyOwner {
        if (newContract == bytes32(0)) revert ZeroAddress();
        bytes32 previous = genlayerContract;
        genlayerContract = newContract;
        emit GenLayerContractUpdated(previous, newContract);
    }

    function submitCreatorVerification(
        CreatorVerification calldata item,
        bytes calldata ownershipSignature,
        bytes[] calldata watcherSignatures
    )
        external
        nonReentrant
        whenNotPaused
    {
        if (
            item.attestationId == bytes32(0) || item.wallet == address(0) || item.identityHash == bytes32(0)
                || item.handleHash == bytes32(0) || item.verificationPostHash == bytes32(0)
                || item.challengeHash == bytes32(0)
                || item.genlayerContract == bytes32(0) || item.genlayerTxHash == bytes32(0)
                || item.verifiedAt == 0 || item.expiresAt <= item.verifiedAt
        ) revert InvalidAttestation();
        _checkGenLayerContract(item.genlayerContract);
        if (item.expiresAt <= block.timestamp) revert OwnershipIntentExpired();

        bytes32 intentDigest = _ownershipIntentDigest(item);
        if (usedOwnershipIntents[intentDigest]) revert OwnershipIntentAlreadyUsed();
        if (!SignatureChecker.isValidSignatureNow(item.wallet, intentDigest, ownershipSignature)) {
            revert InvalidOwnershipIntentSignature();
        }
        _checkFresh(item.attestationId, item.relayDeadline);

        bytes32 structHash = keccak256(
            abi.encode(
                CREATOR_VERIFICATION_TYPEHASH,
                item.attestationId,
                item.wallet,
                item.identityHash,
                item.handleHash,
                item.verificationPostHash,
                item.challengeHash,
                item.metricsHash,
                item.verifiedAt,
                item.expiresAt,
                item.genlayerContract,
                item.genlayerTxHash,
                item.relayDeadline
            )
        );
        _verifySignatures(_hashTypedDataV4(structHash), watcherSignatures);
        usedOwnershipIntents[intentDigest] = true;
        usedAttestations[item.attestationId] = true;
        creatorRegistry.recordVerification(
            item.wallet,
            item.identityHash,
            item.handleHash,
            item.verificationPostHash,
            item.metricsHash,
            item.verifiedAt,
            item.expiresAt
        );
        emit OwnershipIntentConsumed(item.attestationId, item.wallet, intentDigest);
        emit CreatorVerificationRelayed(item.attestationId, item.wallet, item.identityHash);
    }

    function ownershipIntentDigest(CreatorVerification calldata item) external view returns (bytes32) {
        return _ownershipIntentDigest(item);
    }

    function submitMetrics(MetricsAttestation calldata item, bytes[] calldata signatures)
        external
        nonReentrant
        whenNotPaused
    {
        if (
            item.attestationId == bytes32(0) || item.wallet == address(0) || item.identityHash == bytes32(0)
                || item.metricsHash == bytes32(0) || item.genlayerContract == bytes32(0)
                || item.genlayerTxHash == bytes32(0) || item.measuredAt == 0 || item.expiresAt <= item.measuredAt
        ) revert InvalidAttestation();
        _checkGenLayerContract(item.genlayerContract);
        _checkFresh(item.attestationId, item.relayDeadline);

        bytes32 structHash = keccak256(
            abi.encode(
                METRICS_ATTESTATION_TYPEHASH,
                item.attestationId,
                item.wallet,
                item.identityHash,
                item.metricsHash,
                item.measuredAt,
                item.expiresAt,
                item.genlayerContract,
                item.genlayerTxHash,
                item.relayDeadline
            )
        );
        _verifySignatures(_hashTypedDataV4(structHash), signatures);
        usedAttestations[item.attestationId] = true;
        creatorRegistry.updateMetrics(
            item.wallet,
            item.identityHash,
            item.metricsHash,
            item.measuredAt,
            item.expiresAt
        );
        emit MetricsRelayed(item.attestationId, item.wallet, item.metricsHash);
    }

    function submitCampaignResolution(CampaignResolution calldata item, bytes[] calldata signatures)
        external
        nonReentrant
        whenNotPaused
    {
        if (
            item.requestId == bytes32(0) || item.assignmentId == 0 || item.outcome < 1 || item.outcome > 3
                || item.evidenceHash == bytes32(0) || item.genlayerContract == bytes32(0)
                || item.genlayerTxHash == bytes32(0) || item.resolvedAt == 0
        ) revert InvalidAttestation();
        _checkGenLayerContract(item.genlayerContract);
        _checkFresh(item.requestId, item.relayDeadline);

        bytes32 structHash = keccak256(
            abi.encode(
                CAMPAIGN_RESOLUTION_TYPEHASH,
                item.requestId,
                item.assignmentId,
                item.outcome,
                item.evidenceHash,
                item.genlayerContract,
                item.genlayerTxHash,
                item.resolvedAt,
                item.relayDeadline
            )
        );
        _verifySignatures(_hashTypedDataV4(structHash), signatures);
        usedAttestations[item.requestId] = true;
        escrow.settle(item.assignmentId, item.requestId, item.outcome, item.evidenceHash);
        emit CampaignResolutionRelayed(item.requestId, item.assignmentId, item.outcome, item.evidenceHash);
    }

    function _checkFresh(bytes32 attestationId, uint64 relayDeadline) private view {
        if (usedAttestations[attestationId]) revert AttestationAlreadyUsed();
        if (relayDeadline < block.timestamp) revert AttestationExpired();
    }

    function _ownershipIntentDigest(CreatorVerification calldata item) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OWNERSHIP_INTENT_TYPEHASH,
                    item.attestationId,
                    item.wallet,
                    item.handleHash,
                    item.verificationPostHash,
                    item.challengeHash,
                    item.expiresAt,
                    item.genlayerContract
                )
            )
        );
    }

    function _checkGenLayerContract(bytes32 provided) private view {
        if (provided != genlayerContract) revert WrongGenLayerContract(provided);
    }

    function _verifySignatures(bytes32 digest, bytes[] calldata signatures) private view {
        if (signatures.length < threshold) revert InsufficientSignatures();
        address previous;
        for (uint256 i = 0; i < signatures.length; ++i) {
            address signer = digest.recover(signatures[i]);
            if (!isWatcher[signer]) revert UnauthorizedWatcher(signer);
            if (signer <= previous) revert SignersNotStrictlyOrdered();
            previous = signer;
        }
    }
}
