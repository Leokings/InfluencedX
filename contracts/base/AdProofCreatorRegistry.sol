// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract AdProofCreatorRegistry is Ownable2Step {
    struct CreatorProfile {
        uint256 profileId;
        address wallet;
        bytes32 identityHash;
        bytes32 handleHash;
        bytes32 verificationPostHash;
        bytes32 metricsHash;
        uint64 verifiedAt;
        uint64 expiresAt;
        uint64 metricsMeasuredAt;
        uint64 metricsExpiresAt;
        bool active;
    }

    error OnlyAttestationReceiver();
    error ZeroAddress();
    error InvalidIdentity();
    error InvalidVerificationWindow();
    error IdentityAlreadyBound(address existingWallet);
    error WalletAlreadyBound(bytes32 existingIdentity);
    error ProfileNotFound();
    error IdentityMismatch();

    event AttestationReceiverUpdated(address indexed previousReceiver, address indexed newReceiver);
    event CreatorVerified(
        uint256 indexed profileId,
        address indexed wallet,
        bytes32 indexed identityHash,
        uint64 verifiedAt,
        uint64 expiresAt
    );
    event CreatorMetricsUpdated(
        uint256 indexed profileId,
        bytes32 indexed metricsHash,
        uint64 measuredAt,
        uint64 expiresAt
    );
    event CreatorDeactivated(uint256 indexed profileId, address indexed wallet);

    address public attestationReceiver;
    uint256 public profileCount;

    mapping(address wallet => CreatorProfile profile) private _profiles;
    mapping(bytes32 identityHash => address wallet) public walletByIdentity;

    modifier onlyAttestationReceiver() {
        if (msg.sender != attestationReceiver) revert OnlyAttestationReceiver();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    function setAttestationReceiver(address newReceiver) external onlyOwner {
        if (newReceiver == address(0)) revert ZeroAddress();
        address previous = attestationReceiver;
        attestationReceiver = newReceiver;
        emit AttestationReceiverUpdated(previous, newReceiver);
    }

    function recordVerification(
        address wallet,
        bytes32 identityHash,
        bytes32 handleHash,
        bytes32 verificationPostHash,
        bytes32 metricsHash,
        uint64 verifiedAt,
        uint64 expiresAt
    ) external onlyAttestationReceiver returns (uint256 profileId) {
        if (wallet == address(0)) revert ZeroAddress();
        if (identityHash == bytes32(0) || handleHash == bytes32(0) || verificationPostHash == bytes32(0)) {
            revert InvalidIdentity();
        }
        if (verifiedAt == 0 || expiresAt <= verifiedAt || expiresAt <= block.timestamp) {
            revert InvalidVerificationWindow();
        }

        address existingWallet = walletByIdentity[identityHash];
        if (existingWallet != address(0) && existingWallet != wallet) {
            revert IdentityAlreadyBound(existingWallet);
        }

        CreatorProfile storage profile = _profiles[wallet];
        if (profile.profileId != 0 && profile.identityHash != identityHash) {
            revert WalletAlreadyBound(profile.identityHash);
        }

        if (profile.profileId == 0) {
            profileCount += 1;
            profile.profileId = profileCount;
            profile.wallet = wallet;
            profile.identityHash = identityHash;
            walletByIdentity[identityHash] = wallet;
        }

        profile.handleHash = handleHash;
        profile.verificationPostHash = verificationPostHash;
        profile.metricsHash = metricsHash;
        profile.verifiedAt = verifiedAt;
        profile.expiresAt = expiresAt;
        profile.metricsMeasuredAt = metricsHash == bytes32(0) ? 0 : verifiedAt;
        profile.metricsExpiresAt = metricsHash == bytes32(0) ? 0 : verifiedAt;
        profile.active = true;

        emit CreatorVerified(profile.profileId, wallet, identityHash, verifiedAt, expiresAt);
        return profile.profileId;
    }

    function updateMetrics(
        address wallet,
        bytes32 identityHash,
        bytes32 metricsHash,
        uint64 measuredAt,
        uint64 expiresAt
    ) external onlyAttestationReceiver {
        CreatorProfile storage profile = _profiles[wallet];
        if (profile.profileId == 0) revert ProfileNotFound();
        if (profile.identityHash != identityHash) revert IdentityMismatch();
        if (metricsHash == bytes32(0)) revert InvalidIdentity();
        if (measuredAt == 0 || expiresAt <= measuredAt || expiresAt <= block.timestamp) {
            revert InvalidVerificationWindow();
        }

        profile.metricsHash = metricsHash;
        profile.metricsMeasuredAt = measuredAt;
        profile.metricsExpiresAt = expiresAt;
        emit CreatorMetricsUpdated(profile.profileId, metricsHash, measuredAt, expiresAt);
    }

    function deactivateMyProfile() external {
        CreatorProfile storage profile = _profiles[msg.sender];
        if (profile.profileId == 0) revert ProfileNotFound();
        profile.active = false;
        emit CreatorDeactivated(profile.profileId, msg.sender);
    }

    function getProfile(address wallet) external view returns (CreatorProfile memory) {
        return _profiles[wallet];
    }

    function isVerified(address wallet, bytes32 identityHash) external view returns (bool) {
        CreatorProfile storage profile = _profiles[wallet];
        return profile.profileId != 0 && profile.identityHash == identityHash && profile.active
            && profile.expiresAt >= block.timestamp;
    }

    function hasFreshMetrics(address wallet) external view returns (bool) {
        CreatorProfile storage profile = _profiles[wallet];
        return profile.profileId != 0 && profile.active && profile.metricsHash != bytes32(0)
            && profile.metricsExpiresAt >= block.timestamp;
    }
}
