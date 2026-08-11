// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAdProofCreatorRegistry {
    function isVerified(address wallet, bytes32 identityHash) external view returns (bool);
}

contract AdProofEscrow is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant OUTCOME_PASS = 1;
    uint8 public constant OUTCOME_FAIL = 2;
    uint8 public constant OUTCOME_UNDETERMINED = 3;

    enum AssignmentStatus {
        NONE,
        SELECTED,
        ACCEPTED,
        SUBMITTED,
        RESOLUTION_REQUESTED,
        UNDETERMINED,
        PAID,
        REFUNDED,
        CANCELLED
    }

    struct Campaign {
        address brand;
        bytes32 termsHash;
        uint256 deposited;
        uint256 allocated;
        uint256 disbursed;
        uint256 unallocatedWithdrawn;
        uint64 applicationDeadline;
        uint64 selectionDeadline;
        uint64 submissionDeadline;
        uint64 retentionSeconds;
    }

    struct Assignment {
        uint256 campaignId;
        address creator;
        bytes32 identityHash;
        bytes32 agreementHash;
        uint256 payout;
        uint64 acceptedAt;
        uint64 submittedAt;
        bytes32 postIdHash;
        bytes32 submissionHash;
        bytes32 requestId;
        uint32 resolutionRound;
        uint16 feeBps;
        AssignmentStatus status;
    }

    error ZeroAddress();
    error InvalidAmount();
    error InvalidHash();
    error InvalidDeadlines();
    error InvalidFee();
    error CampaignNotFound();
    error AssignmentNotFound();
    error Unauthorized();
    error CreatorNotVerified();
    error DeadlinePassed();
    error DeadlineNotReached();
    error InvalidState();
    error BudgetExceeded();
    error TransferAmountMismatch();
    error OnlyResolutionReceiver();
    error InvalidOutcome();
    error RequestMismatch();
    error NothingToWithdraw();

    event ResolutionReceiverUpdated(address indexed previousReceiver, address indexed newReceiver);
    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed brand,
        bytes32 indexed termsHash,
        uint256 deposited
    );
    event CreatorSelected(
        uint256 indexed assignmentId,
        uint256 indexed campaignId,
        address indexed creator,
        uint256 payout
    );
    event AssignmentAccepted(uint256 indexed assignmentId, bytes32 indexed agreementHash);
    event EvidenceSubmitted(
        uint256 indexed assignmentId,
        bytes32 indexed postIdHash,
        bytes32 indexed submissionHash
    );
    event ResolutionRequested(
        uint256 indexed assignmentId,
        bytes32 indexed requestId,
        uint32 indexed round,
        bytes32 agreementHash,
        bytes32 submissionHash
    );
    event AssignmentSettled(
        uint256 indexed assignmentId,
        bytes32 indexed requestId,
        uint8 outcome,
        bytes32 evidenceHash
    );
    event AssignmentCancelled(uint256 indexed assignmentId);
    event UnallocatedCredited(uint256 indexed campaignId, address indexed brand, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    IERC20 public immutable usdc;
    IAdProofCreatorRegistry public immutable creatorRegistry;
    address public immutable treasury;
    uint16 public immutable protocolFeeBps;
    address public resolutionReceiver;

    uint256 public campaignCount;
    uint256 public assignmentCount;

    mapping(uint256 campaignId => Campaign campaign) public campaigns;
    mapping(uint256 assignmentId => Assignment assignment) public assignments;
    mapping(address account => uint256 amount) public claimable;

    modifier onlyResolutionReceiver() {
        if (msg.sender != resolutionReceiver) revert OnlyResolutionReceiver();
        _;
    }

    constructor(
        address initialOwner,
        IERC20 usdcToken,
        IAdProofCreatorRegistry registry,
        address treasuryAddress,
        uint16 feeBps
    ) Ownable(initialOwner) {
        if (
            initialOwner == address(0) || address(usdcToken) == address(0) || address(registry) == address(0)
                || treasuryAddress == address(0)
        ) revert ZeroAddress();
        if (feeBps > 1_000) revert InvalidFee();
        usdc = usdcToken;
        creatorRegistry = registry;
        treasury = treasuryAddress;
        protocolFeeBps = feeBps;
    }

    function setResolutionReceiver(address newReceiver) external onlyOwner {
        if (newReceiver == address(0)) revert ZeroAddress();
        address previous = resolutionReceiver;
        resolutionReceiver = newReceiver;
        emit ResolutionReceiverUpdated(previous, newReceiver);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function createCampaign(
        bytes32 termsHash,
        uint256 budget,
        uint64 applicationDeadline,
        uint64 selectionDeadline,
        uint64 submissionDeadline,
        uint64 retentionSeconds
    ) external nonReentrant whenNotPaused returns (uint256 campaignId) {
        if (termsHash == bytes32(0)) revert InvalidHash();
        if (budget == 0) revert InvalidAmount();
        if (
            applicationDeadline <= block.timestamp || selectionDeadline <= applicationDeadline
                || submissionDeadline <= selectionDeadline || retentionSeconds == 0
        ) revert InvalidDeadlines();

        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), budget);
        if (usdc.balanceOf(address(this)) - balanceBefore != budget) revert TransferAmountMismatch();

        campaignCount += 1;
        campaignId = campaignCount;
        campaigns[campaignId] = Campaign({
            brand: msg.sender,
            termsHash: termsHash,
            deposited: budget,
            allocated: 0,
            disbursed: 0,
            unallocatedWithdrawn: 0,
            applicationDeadline: applicationDeadline,
            selectionDeadline: selectionDeadline,
            submissionDeadline: submissionDeadline,
            retentionSeconds: retentionSeconds
        });
        emit CampaignCreated(campaignId, msg.sender, termsHash, budget);
    }

    function selectCreator(
        uint256 campaignId,
        address creator,
        bytes32 identityHash,
        bytes32 agreementHash,
        uint256 payout
    ) external whenNotPaused returns (uint256 assignmentId) {
        Campaign storage campaign = campaigns[campaignId];
        if (campaign.brand == address(0)) revert CampaignNotFound();
        if (msg.sender != campaign.brand) revert Unauthorized();
        if (block.timestamp > campaign.selectionDeadline) revert DeadlinePassed();
        if (creator == address(0)) revert ZeroAddress();
        if (identityHash == bytes32(0) || agreementHash == bytes32(0)) revert InvalidHash();
        if (payout == 0) revert InvalidAmount();
        if (!creatorRegistry.isVerified(creator, identityHash)) revert CreatorNotVerified();

        uint256 available = campaign.deposited - campaign.allocated - campaign.disbursed
            - campaign.unallocatedWithdrawn;
        if (payout > available) revert BudgetExceeded();

        campaign.allocated += payout;
        assignmentCount += 1;
        assignmentId = assignmentCount;
        assignments[assignmentId] = Assignment({
            campaignId: campaignId,
            creator: creator,
            identityHash: identityHash,
            agreementHash: agreementHash,
            payout: payout,
            acceptedAt: 0,
            submittedAt: 0,
            postIdHash: bytes32(0),
            submissionHash: bytes32(0),
            requestId: bytes32(0),
            resolutionRound: 0,
            feeBps: protocolFeeBps,
            status: AssignmentStatus.SELECTED
        });
        emit CreatorSelected(assignmentId, campaignId, creator, payout);
    }

    function acceptAssignment(uint256 assignmentId) external whenNotPaused {
        Assignment storage assignment = assignments[assignmentId];
        if (assignment.status == AssignmentStatus.NONE) revert AssignmentNotFound();
        if (assignment.status != AssignmentStatus.SELECTED) revert InvalidState();
        if (msg.sender != assignment.creator) revert Unauthorized();
        Campaign storage campaign = campaigns[assignment.campaignId];
        if (block.timestamp > campaign.submissionDeadline) revert DeadlinePassed();
        if (!creatorRegistry.isVerified(assignment.creator, assignment.identityHash)) {
            revert CreatorNotVerified();
        }
        assignment.status = AssignmentStatus.ACCEPTED;
        assignment.acceptedAt = uint64(block.timestamp);
        emit AssignmentAccepted(assignmentId, assignment.agreementHash);
    }

    function submitEvidence(uint256 assignmentId, bytes32 postIdHash, bytes32 submissionHash)
        external
        whenNotPaused
    {
        Assignment storage assignment = assignments[assignmentId];
        if (assignment.status == AssignmentStatus.NONE) revert AssignmentNotFound();
        if (assignment.status != AssignmentStatus.ACCEPTED) revert InvalidState();
        if (msg.sender != assignment.creator) revert Unauthorized();
        Campaign storage campaign = campaigns[assignment.campaignId];
        if (block.timestamp > campaign.submissionDeadline) revert DeadlinePassed();
        if (postIdHash == bytes32(0) || submissionHash == bytes32(0)) revert InvalidHash();

        assignment.postIdHash = postIdHash;
        assignment.submissionHash = submissionHash;
        assignment.submittedAt = uint64(block.timestamp);
        assignment.status = AssignmentStatus.SUBMITTED;
        emit EvidenceSubmitted(assignmentId, postIdHash, submissionHash);
    }

    function requestResolution(uint256 assignmentId) external whenNotPaused returns (bytes32 requestId) {
        Assignment storage assignment = assignments[assignmentId];
        if (assignment.status == AssignmentStatus.NONE) revert AssignmentNotFound();
        if (
            assignment.status != AssignmentStatus.SUBMITTED
                && assignment.status != AssignmentStatus.UNDETERMINED
        ) revert InvalidState();
        Campaign storage campaign = campaigns[assignment.campaignId];
        if (block.timestamp < uint256(assignment.submittedAt) + campaign.retentionSeconds) {
            revert DeadlineNotReached();
        }

        assignment.resolutionRound += 1;
        requestId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                assignmentId,
                assignment.resolutionRound,
                assignment.agreementHash,
                assignment.submissionHash
            )
        );
        assignment.requestId = requestId;
        assignment.status = AssignmentStatus.RESOLUTION_REQUESTED;
        emit ResolutionRequested(
            assignmentId,
            requestId,
            assignment.resolutionRound,
            assignment.agreementHash,
            assignment.submissionHash
        );
    }

    function settle(uint256 assignmentId, bytes32 requestId, uint8 outcome, bytes32 evidenceHash)
        external
        onlyResolutionReceiver
        nonReentrant
        whenNotPaused
    {
        Assignment storage assignment = assignments[assignmentId];
        if (assignment.status == AssignmentStatus.NONE) revert AssignmentNotFound();
        if (assignment.status != AssignmentStatus.RESOLUTION_REQUESTED) revert InvalidState();
        if (assignment.requestId != requestId) revert RequestMismatch();
        if (evidenceHash == bytes32(0)) revert InvalidHash();
        if (outcome != OUTCOME_PASS && outcome != OUTCOME_FAIL && outcome != OUTCOME_UNDETERMINED) {
            revert InvalidOutcome();
        }

        if (outcome == OUTCOME_UNDETERMINED) {
            assignment.status = AssignmentStatus.UNDETERMINED;
            emit AssignmentSettled(assignmentId, requestId, outcome, evidenceHash);
            return;
        }

        Campaign storage campaign = campaigns[assignment.campaignId];
        campaign.allocated -= assignment.payout;
        campaign.disbursed += assignment.payout;

        if (outcome == OUTCOME_PASS) {
            uint256 fee = (assignment.payout * assignment.feeBps) / 10_000;
            claimable[assignment.creator] += assignment.payout - fee;
            claimable[treasury] += fee;
            assignment.status = AssignmentStatus.PAID;
        } else {
            claimable[campaign.brand] += assignment.payout;
            assignment.status = AssignmentStatus.REFUNDED;
        }

        emit AssignmentSettled(assignmentId, requestId, outcome, evidenceHash);
    }

    function cancelExpiredAssignment(uint256 assignmentId) external whenNotPaused {
        Assignment storage assignment = assignments[assignmentId];
        if (assignment.status == AssignmentStatus.NONE) revert AssignmentNotFound();
        Campaign storage campaign = campaigns[assignment.campaignId];
        if (msg.sender != campaign.brand) revert Unauthorized();
        bool selectionExpired = assignment.status == AssignmentStatus.SELECTED
            && block.timestamp > campaign.submissionDeadline;
        bool submissionExpired = assignment.status == AssignmentStatus.ACCEPTED
            && block.timestamp > campaign.submissionDeadline;
        if (!selectionExpired && !submissionExpired) revert InvalidState();

        campaign.allocated -= assignment.payout;
        assignment.status = AssignmentStatus.CANCELLED;
        emit AssignmentCancelled(assignmentId);
    }

    function creditUnallocatedBudget(uint256 campaignId) external whenNotPaused returns (uint256 amount) {
        Campaign storage campaign = campaigns[campaignId];
        if (campaign.brand == address(0)) revert CampaignNotFound();
        if (msg.sender != campaign.brand) revert Unauthorized();
        if (block.timestamp <= campaign.selectionDeadline) revert DeadlineNotReached();

        amount = campaign.deposited - campaign.allocated - campaign.disbursed - campaign.unallocatedWithdrawn;
        if (amount == 0) revert NothingToWithdraw();
        campaign.unallocatedWithdrawn += amount;
        claimable[campaign.brand] += amount;
        emit UnallocatedCredited(campaignId, campaign.brand, amount);
    }

    function withdraw() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        claimable[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
    }
}
