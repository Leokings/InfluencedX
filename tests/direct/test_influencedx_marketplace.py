import datetime
import hashlib
import json
from pathlib import Path

from gltest.direct.sdk_loader import setup_sdk_paths


CONTRACT_PATH = Path("contracts/genlayer/InfluencedXMarketplace.py")
NOW_ISO = "2027-01-01T00:00:00Z"
NOW = int(datetime.datetime.fromisoformat(NOW_ISO.replace("Z", "+00:00")).timestamp())
X_EPOCH_MS = 1_288_834_974_657
CHALLENGE = "APV2-abcdefghijklmnopqrstuvwx"
X_USER_ID = "2244994945"
HANDLE = "xdevelopers"
BUDGET = 10 * 10**18
RATE = 4 * 10**18
FEE_BPS = 250
APPLICATION_DEADLINE = NOW + 3_600
SELECTION_DEADLINE = NOW + 7_200
SUBMISSION_DEADLINE = NOW + 10_800
RETENTION = 60
AGREEMENT_HASH = "0x" + "88" * 32
SUBMISSION_HASH = "0x" + "99" * 32
PITCH_HASH = "0x" + "77" * 32
EVIDENCE_HASH = "0x" + "66" * 32


def as_address(value):
    from genlayer.py.types import Address

    return Address(value) if isinstance(value, bytes) else value


def snowflake_at(epoch: int) -> str:
    return str(((epoch * 1000 - X_EPOCH_MS) << 22) + 1)


OWNERSHIP_POST_ID = snowflake_at(NOW - 60)
SUBMISSION_POST_ID = snowflake_at(NOW + 1)
ISSUED_AT = NOW - 120
EXPIRES_AT = NOW + 600
PROFILE_EXPIRES_AT = NOW + 30 * 24 * 60 * 60


def deploy_marketplace(direct_vm, direct_deploy, owner, treasury, fee_bps=FEE_BPS):
    setup_sdk_paths(CONTRACT_PATH, "v0.2.16")
    direct_vm.sender = as_address(owner)
    direct_vm.value = 0
    direct_vm.warp(NOW_ISO)
    direct_vm.check_pickling = True
    return direct_deploy(str(CONTRACT_PATH), as_address(treasury), fee_bps)


def address_text(value) -> str:
    return as_address(value).as_hex.lower()


def ownership_text(creator) -> str:
    return (
        f"XProof v2 w={address_text(creator)} n={CHALLENGE} "
        f"i={ISSUED_AT} e={EXPIRES_AT} c={PROFILE_EXPIRES_AT}"
    )


def mock_profile(direct_vm, handle=HANDLE, protected=False):
    privacy = "0" if protected else "1"
    body = (
        f'rest_id:"{X_USER_ID}",__typename:"User",privacy:{{}},core:{{}}'
        f'__typename:"UserPrivacy",protected:!{privacy},'
        f'__typename:"UserCore",name:"Developers",screen_name:"{handle}"'
    )
    direct_vm.mock_web(rf".*x\.com/{handle}$", {"status": 200, "body": body})


def mock_post(direct_vm, post_id, text, handle=HANDLE, status=200):
    direct_vm.mock_web(
        rf".*x\.com/{handle}/status/{post_id}.*",
        {
            "status": status,
            "body": (
                f'<meta name="twitter:creator" content="@{handle}">'
                f'<meta property="og:description" content="{text}">'
                f'<meta property="og:url" content="https://x.com/{handle}/status/{post_id}">'
            ) if status == 200 else "",
        },
    )
    direct_vm.mock_web(
        r".*publish\.twitter\.com/oembed.*",
        {
            "status": status,
            "body": json.dumps({
                "url": f"https://x.com/{handle}/status/{post_id}",
                "author_url": f"https://x.com/{handle}",
                "html": f"<blockquote><p>{text}</p></blockquote>",
            }) if status == 200 else "",
        },
    )


def activate_creator(direct_vm, contract, creator):
    direct_vm.sender = as_address(creator)
    direct_vm.value = 0
    mock_profile(direct_vm)
    mock_post(direct_vm, OWNERSHIP_POST_ID, ownership_text(creator))
    request_id = contract.compute_ownership_request_id(
        as_address(creator),
        HANDLE,
        OWNERSHIP_POST_ID,
        CHALLENGE,
        ISSUED_AT,
        EXPIRES_AT,
        PROFILE_EXPIRES_AT,
    )
    contract.activate_creator(
        request_id,
        HANDLE,
        OWNERSHIP_POST_ID,
        CHALLENGE,
        ISSUED_AT,
        EXPIRES_AT,
        PROFILE_EXPIRES_AT,
    )
    return request_id


def campaign_args(max_retries=2, budget=BUDGET, nonce="campaign-nonce-0001"):
    return {
        "client_nonce": nonce,
        "title": "Launch the InfluencedX creator campaign",
        "brief": "Explain why InfluencedX makes creator collaborations verifiable.",
        "required_phrases_json": json.dumps(["InfluencedX", "creator collaborations"]),
        "forbidden_phrases_json": json.dumps(["guaranteed profit"]),
        "require_ad_disclosure": True,
        "application_deadline_epoch": APPLICATION_DEADLINE,
        "selection_deadline_epoch": SELECTION_DEADLINE,
        "submission_deadline_epoch": SUBMISSION_DEADLINE,
        "retention_seconds": RETENTION,
        "max_undetermined_retries": max_retries,
        "budget_atto": budget,
    }


def create_campaign(direct_vm, contract, brand, **overrides):
    values = campaign_args(**overrides)
    campaign_id = contract.compute_campaign_id(
        as_address(brand),
        *values.values(),
    )
    direct_vm.sender = as_address(brand)
    direct_vm.value = values["budget_atto"]
    contract.create_campaign(campaign_id, *values.values())
    direct_vm.deal(
        direct_vm._contract_address,
        int(contract.balance) + values["budget_atto"],
    )
    direct_vm.value = 0
    return campaign_id


def apply(direct_vm, contract, campaign_id, creator, requested_rate=RATE):
    direct_vm.sender = as_address(creator)
    application_id = contract.compute_application_id(campaign_id, as_address(creator))
    contract.apply_to_campaign(campaign_id, application_id, requested_rate, PITCH_HASH)
    return application_id


def select(direct_vm, contract, campaign_id, brand, creator, rate=RATE):
    assignment_id = contract.compute_assignment_id(
        campaign_id,
        as_address(creator),
        rate,
        AGREEMENT_HASH,
    )
    direct_vm.sender = as_address(brand)
    contract.select_creator(
        campaign_id,
        assignment_id,
        as_address(creator),
        rate,
        AGREEMENT_HASH,
    )
    return assignment_id


def prepare_assignment(direct_vm, contract, brand, creator, **campaign_overrides):
    activate_creator(direct_vm, contract, creator)
    campaign_id = create_campaign(direct_vm, contract, brand, **campaign_overrides)
    apply(direct_vm, contract, campaign_id, creator)
    assignment_id = select(direct_vm, contract, campaign_id, brand, creator)
    direct_vm.sender = as_address(creator)
    contract.accept_assignment(assignment_id)
    return campaign_id, assignment_id


def submit(direct_vm, contract, assignment_id, creator):
    direct_vm.warp("2027-01-01T00:00:02Z")
    request_id = contract.compute_submission_request_id(
        assignment_id,
        AGREEMENT_HASH,
        SUBMISSION_HASH,
        SUBMISSION_POST_ID,
        0,
    )
    direct_vm.sender = as_address(creator)
    contract.submit_evidence(
        assignment_id,
        request_id,
        SUBMISSION_POST_ID,
        SUBMISSION_HASH,
    )
    return request_id


def mock_resolution(direct_vm, *, semantic_pass=True, text=None, status=200):
    direct_vm.clear_mocks()
    if text is None:
        text = "#ad InfluencedX makes creator collaborations verifiable."
    mock_post(direct_vm, SUBMISSION_POST_ID, text, status=status)
    direct_vm.mock_llm(
        r".*Evaluate only whether the text materially satisfies the campaign brief.*",
        json.dumps({
            "semantic_pass": semantic_pass,
            "reasoning": "The post text was evaluated against the frozen brief.",
        }),
    )


def resolve_at(direct_vm, contract, assignment_id, request_id, iso="2027-01-01T00:01:03Z"):
    direct_vm.warp(iso)
    direct_vm.value = 0
    contract.resolve_assignment(assignment_id, request_id)


def assert_global_invariant(contract):
    counts = contract.get_counts()
    assert (
        counts["total_escrow_atto"]
        + counts["total_claimable_atto"]
        + counts["total_pending_withdrawal_atto"]
        + counts["total_emitted_unconfirmed_atto"]
        == counts["total_liability_atto"]
    )
    assert (
        counts["contract_balance_atto"] + counts["total_emitted_unconfirmed_atto"]
        >= counts["total_liability_atto"]
    )


def assert_campaign_invariant(contract, campaign_id):
    campaign = contract.get_campaign(campaign_id)
    assert (
        campaign["available_atto"]
        + campaign["reserved_atto"]
        + campaign["creator_paid_atto"]
        + campaign["brand_refunded_atto"]
        + campaign["fee_atto"]
        == campaign["budget_atto"]
    )


def test_contract_has_pinned_runner_and_gen_native_config(direct_vm, direct_deploy, direct_owner, direct_bob):
    first_line = CONTRACT_PATH.read_text(encoding="utf-8").splitlines()[0]
    assert first_line.startswith('# { "Depends": "py-genlayer:')
    assert "latest" not in first_line and "test" not in first_line
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    config = contract.get_config()
    assert config["protocol_version"] == "INFLUENCEDX_MARKETPLACE_V1"
    assert config["native_token_symbol"] == "GEN"
    assert config["native_token_decimals"] == 18
    assert config["protocol_fee_bps"] == FEE_BPS


def test_creator_activation_is_caller_bound_and_expires(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    request_id = activate_creator(direct_vm, contract, direct_alice)
    profile = contract.get_profile(as_address(direct_alice))
    assert profile["active"] is True
    assert profile["handle"] == HANDLE
    assert profile["wallet"] == address_text(direct_alice)
    assert contract.get_ownership_result(request_id)["outcome"] == "VERIFIED"

    direct_vm.sender = as_address(direct_bob)
    mock_profile(direct_vm)
    mock_post(direct_vm, OWNERSHIP_POST_ID, ownership_text(direct_alice))
    with direct_vm.expect_revert("caller-bound envelope"):
        contract.activate_creator(
            request_id,
            HANDLE,
            OWNERSHIP_POST_ID,
            CHALLENGE,
            ISSUED_AT,
            EXPIRES_AT,
            PROFILE_EXPIRES_AT,
        )

    direct_vm.warp("2027-02-01T00:00:00Z")
    assert contract.get_profile(as_address(direct_alice))["active"] is False


def test_undetermined_ownership_request_can_retry_but_terminal_result_cannot(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    direct_vm.sender = as_address(direct_alice)
    request_id = contract.compute_ownership_request_id(
        as_address(direct_alice), HANDLE, OWNERSHIP_POST_ID, CHALLENGE,
        ISSUED_AT, EXPIRES_AT, PROFILE_EXPIRES_AT,
    )
    direct_vm.mock_web(rf".*x\.com/{HANDLE}$", {"status": 429, "body": ""})
    mock_post(direct_vm, OWNERSHIP_POST_ID, ownership_text(direct_alice), status=429)
    contract.activate_creator(
        request_id, HANDLE, OWNERSHIP_POST_ID, CHALLENGE,
        ISSUED_AT, EXPIRES_AT, PROFILE_EXPIRES_AT,
    )
    assert contract.get_ownership_result(request_id)["outcome"] == "UNDETERMINED"
    assert contract.get_profile(as_address(direct_alice))["exists"] is False

    direct_vm.clear_mocks()
    mock_profile(direct_vm)
    mock_post(direct_vm, OWNERSHIP_POST_ID, ownership_text(direct_alice))
    contract.activate_creator(
        request_id, HANDLE, OWNERSHIP_POST_ID, CHALLENGE,
        ISSUED_AT, EXPIRES_AT, PROFILE_EXPIRES_AT,
    )
    assert contract.get_ownership_result(request_id)["outcome"] == "VERIFIED"
    with direct_vm.expect_revert("already used"):
        contract.activate_creator(
            request_id, HANDLE, OWNERSHIP_POST_ID, CHALLENGE,
            ISSUED_AT, EXPIRES_AT, PROFILE_EXPIRES_AT,
        )


def test_campaign_requires_exact_native_funding_and_bound_id(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    values = campaign_args()
    campaign_id = contract.compute_campaign_id(as_address(direct_alice), *values.values())
    direct_vm.sender = as_address(direct_alice)
    direct_vm.value = BUDGET - 1
    with direct_vm.expect_revert("exactly equal campaign budget"):
        contract.create_campaign(campaign_id, *values.values())
    direct_vm.value = BUDGET
    with direct_vm.expect_revert("does not match funded terms"):
        contract.create_campaign("0x" + "11" * 32, *values.values())

    campaign_id = create_campaign(direct_vm, contract, direct_alice)
    campaign = contract.get_campaign(campaign_id)
    counts = contract.get_counts()
    assert campaign["budget_atto"] == BUDGET
    assert campaign["available_atto"] == BUDGET
    assert counts["total_escrow_atto"] == BUDGET
    assert counts["total_liability_atto"] == BUDGET
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_application_stores_only_pitch_commitment_and_selection_reserves(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, direct_charlie):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_charlie)
    activate_creator(direct_vm, contract, direct_bob)
    campaign_id = create_campaign(direct_vm, contract, direct_alice)
    application_id = apply(direct_vm, contract, campaign_id, direct_bob)
    application = contract.get_application(campaign_id, as_address(direct_bob))
    assert application["application_id"] == application_id
    assert application["pitch_commitment"] == PITCH_HASH
    assert "pitch" not in application

    assignment_id = select(direct_vm, contract, campaign_id, direct_alice, direct_bob)
    campaign = contract.get_campaign(campaign_id)
    assert campaign["available_atto"] == BUDGET - RATE
    assert campaign["reserved_atto"] == RATE
    assert contract.get_assignment(assignment_id)["status"] == "SELECTED"
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_decline_releases_reserved_budget(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, direct_charlie):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_charlie)
    activate_creator(direct_vm, contract, direct_bob)
    campaign_id = create_campaign(direct_vm, contract, direct_alice)
    apply(direct_vm, contract, campaign_id, direct_bob)
    assignment_id = select(direct_vm, contract, campaign_id, direct_alice, direct_bob)
    direct_vm.sender = as_address(direct_bob)
    contract.decline_assignment(assignment_id)
    campaign = contract.get_campaign(campaign_id)
    assert campaign["available_atto"] == BUDGET
    assert campaign["reserved_atto"] == 0
    assert contract.get_assignment(assignment_id)["status"] == "DECLINED"
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_pass_settlement_credits_creator_and_fee_without_losing_liability(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, direct_charlie):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_charlie)
    campaign_id, assignment_id = prepare_assignment(
        direct_vm, contract, direct_alice, direct_bob
    )
    request_id = submit(direct_vm, contract, assignment_id, direct_bob)
    mock_resolution(direct_vm)
    resolve_at(direct_vm, contract, assignment_id, request_id)

    fee = RATE * FEE_BPS // 10_000
    assignment = contract.get_assignment(assignment_id)
    assert assignment["status"] == "SETTLED_PASS"
    assert assignment["resolution_checks"] == {
        "author_match": True,
        "post_id_match": True,
        "required_checks": [True, True],
        "forbidden_checks": [False],
        "disclosure_present": True,
        "semantic_pass": True,
    }
    expected_evidence = {
        "protocol": "influencedx-resolution-result-v1",
        "request_id": request_id,
        "assignment_id": assignment_id,
        "campaign_id": campaign_id,
        "terms_hash": contract.get_campaign(campaign_id)["terms_hash"],
        "agreement_hash": AGREEMENT_HASH,
        "submission_hash": SUBMISSION_HASH,
        "post_id": SUBMISSION_POST_ID,
        "creator_handle": HANDLE,
        "resolution_round": 0,
        "outcome": "PASS",
        **assignment["resolution_checks"],
    }
    expected_hash = "0x" + hashlib.sha256(
        json.dumps(
            expected_evidence,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
    ).hexdigest()
    assert assignment["evidence_hash"] == expected_hash
    assert contract.get_claimable(as_address(direct_bob))["claimable_atto"] == RATE - fee
    assert contract.get_claimable(as_address(direct_charlie))["claimable_atto"] == fee
    campaign = contract.get_campaign(campaign_id)
    assert campaign["reserved_atto"] == 0
    assert campaign["settled_atto"] == RATE
    counts = contract.get_counts()
    assert counts["total_escrow_atto"] == BUDGET - RATE
    assert counts["total_claimable_atto"] == RATE
    assert counts["total_liability_atto"] == BUDGET
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_fail_settlement_refunds_brand_without_fee(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, direct_charlie):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_charlie)
    campaign_id, assignment_id = prepare_assignment(direct_vm, contract, direct_alice, direct_bob)
    request_id = submit(direct_vm, contract, assignment_id, direct_bob)
    mock_resolution(direct_vm, semantic_pass=False)
    resolve_at(direct_vm, contract, assignment_id, request_id)
    assignment = contract.get_assignment(assignment_id)
    assert assignment["status"] == "SETTLED_FAIL"
    assert contract.get_claimable(as_address(direct_alice))["claimable_atto"] == RATE
    assert contract.get_claimable(as_address(direct_charlie))["claimable_atto"] == 0
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_undetermined_changes_request_id_then_retries_to_pass(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, direct_charlie):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_charlie)
    _, assignment_id = prepare_assignment(direct_vm, contract, direct_alice, direct_bob)
    first_request = submit(direct_vm, contract, assignment_id, direct_bob)
    mock_resolution(direct_vm, status=429)
    resolve_at(direct_vm, contract, assignment_id, first_request)
    first_result = contract.get_assignment(assignment_id)
    second_request = first_result["resolution_request_id"]
    assert first_result["status"] == "UNDETERMINED"
    assert second_request != first_request

    direct_vm.clear_mocks()
    mock_resolution(direct_vm)
    resolve_at(direct_vm, contract, assignment_id, second_request, "2027-01-01T00:06:04Z")
    assert contract.get_assignment(assignment_id)["status"] == "SETTLED_PASS"
    assert_global_invariant(contract)


def test_exhausted_undetermined_resolution_refunds_brand_after_delay(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, direct_charlie):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_charlie)
    campaign_id, assignment_id = prepare_assignment(
        direct_vm, contract, direct_alice, direct_bob, max_retries=1
    )
    request_id = submit(direct_vm, contract, assignment_id, direct_bob)
    mock_resolution(direct_vm, status=429)
    resolve_at(direct_vm, contract, assignment_id, request_id)
    next_request = contract.get_resolution_request_id(assignment_id)
    direct_vm.warp("2027-01-01T00:06:04Z")
    with direct_vm.expect_revert("retries are exhausted"):
        contract.resolve_assignment(assignment_id, next_request)
    direct_vm.warp("2027-01-02T03:00:01Z")
    contract.refund_undetermined(assignment_id)
    assert contract.get_assignment(assignment_id)["status"] == "REFUNDED"
    assert contract.get_claimable(as_address(direct_alice))["claimable_atto"] == RATE
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_mixed_transient_and_missing_sources_are_undetermined(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, direct_charlie):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_charlie)
    _, assignment_id = prepare_assignment(direct_vm, contract, direct_alice, direct_bob)
    request_id = submit(direct_vm, contract, assignment_id, direct_bob)
    direct_vm.clear_mocks()
    direct_vm.mock_web(
        rf".*x\.com/{HANDLE}/status/{SUBMISSION_POST_ID}.*",
        {"status": 429, "body": ""},
    )
    direct_vm.mock_web(
        r".*publish\.twitter\.com/oembed.*",
        {"status": 404, "body": ""},
    )
    resolve_at(direct_vm, contract, assignment_id, request_id)
    assert contract.get_assignment(assignment_id)["status"] == "UNDETERMINED"


def test_two_definitive_missing_sources_fail_submission(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, direct_charlie):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_charlie)
    _, assignment_id = prepare_assignment(direct_vm, contract, direct_alice, direct_bob)
    request_id = submit(direct_vm, contract, assignment_id, direct_bob)
    mock_resolution(direct_vm, status=404)
    resolve_at(direct_vm, contract, assignment_id, request_id)
    assert contract.get_assignment(assignment_id)["status"] == "SETTLED_FAIL"
    assert contract.get_assignment(assignment_id)["reasoning"] == (
        "The post did not satisfy one or more frozen campaign requirements"
    )


def test_expired_selected_assignment_releases_budget(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, direct_charlie):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_charlie)
    activate_creator(direct_vm, contract, direct_bob)
    campaign_id = create_campaign(direct_vm, contract, direct_alice)
    apply(direct_vm, contract, campaign_id, direct_bob)
    assignment_id = select(direct_vm, contract, campaign_id, direct_alice, direct_bob)
    direct_vm.warp("2027-01-02T00:00:01Z")
    direct_vm.sender = as_address(direct_charlie)
    contract.expire_assignment(assignment_id)
    assert contract.get_assignment(assignment_id)["status"] == "EXPIRED"
    assert contract.get_campaign(campaign_id)["available_atto"] == BUDGET
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_expired_accepted_assignment_refunds_brand(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob, direct_charlie):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_charlie)
    campaign_id, assignment_id = prepare_assignment(direct_vm, contract, direct_alice, direct_bob)
    direct_vm.warp("2027-01-01T03:00:01Z")
    direct_vm.sender = as_address(direct_charlie)
    contract.expire_assignment(assignment_id)
    assert contract.get_assignment(assignment_id)["status"] == "SETTLED_FAIL"
    assert contract.get_claimable(as_address(direct_alice))["claimable_atto"] == RATE
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_cancel_credits_brand(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    campaign_id = create_campaign(direct_vm, contract, direct_alice)
    direct_vm.sender = as_address(direct_alice)
    contract.cancel_campaign(campaign_id)
    assert contract.get_campaign(campaign_id)["status"] == "CANCELLED"
    assert contract.get_claimable(as_address(direct_alice))["claimable_atto"] == BUDGET
    counts = contract.get_counts()
    assert counts["total_escrow_atto"] == 0
    assert counts["total_liability_atto"] == BUDGET
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_unallocated_refund_credits_brand(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    campaign_id = create_campaign(direct_vm, contract, direct_alice, nonce="campaign-nonce-0002")
    direct_vm.warp("2027-01-01T02:00:01Z")
    direct_vm.sender = as_address(direct_alice)
    contract.refund_unallocated(campaign_id)
    assert contract.get_campaign(campaign_id)["available_atto"] == 0
    assert contract.get_claimable(as_address(direct_alice))["claimable_atto"] == BUDGET
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_permissionless_finalize_closes_and_refunds_remaining_budget(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    campaign_id = create_campaign(direct_vm, contract, direct_alice, nonce="campaign-nonce-0003")
    direct_vm.warp("2027-01-02T03:01:01Z")
    direct_vm.sender = as_address(direct_bob)
    contract.finalize_campaign(campaign_id)
    assert contract.get_campaign(campaign_id)["status"] == "CLOSED"
    assert contract.get_claimable(as_address(direct_alice))["claimable_atto"] == BUDGET
    assert_campaign_invariant(contract, campaign_id)
    assert_global_invariant(contract)


def test_withdrawal_is_two_phase_and_failed_emit_can_be_restored(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    campaign_id = create_campaign(direct_vm, contract, direct_alice)
    direct_vm.sender = as_address(direct_alice)
    contract.cancel_campaign(campaign_id)
    withdrawal_id = contract.compute_withdrawal_id(as_address(direct_alice), BUDGET)
    contract.request_withdrawal(withdrawal_id, BUDGET)
    assert contract.get_withdrawal(withdrawal_id)["status"] == "PENDING"
    assert contract.get_claimable(as_address(direct_alice))["claimable_atto"] == 0

    contract.execute_withdrawal(withdrawal_id)
    assert contract.get_withdrawal(withdrawal_id)["status"] == "EMITTED_UNCONFIRMED"
    assert contract.get_counts()["total_liability_atto"] == BUDGET
    assert contract.get_counts()["total_emitted_unconfirmed_atto"] == BUDGET
    assert_global_invariant(contract)

    # GenLayer deducts value when the external message is emitted. If its child
    # transaction fails, the amount is not auto-refunded, so mirror that live
    # failure here and require explicit owner recapitalization before restore.
    direct_vm.deal(direct_vm._contract_address, 0)
    direct_vm.warp("2027-01-02T00:00:02Z")
    direct_vm.sender = as_address(direct_owner)
    contract.set_paused(True)
    with direct_vm.expect_revert("recapitalized before restoration"):
        contract.restore_failed_withdrawal(withdrawal_id, EVIDENCE_HASH)
    direct_vm.value = BUDGET
    contract.recapitalize_failed_withdrawal(withdrawal_id)
    direct_vm.deal(direct_vm._contract_address, BUDGET)
    direct_vm.value = 0
    contract.restore_failed_withdrawal(withdrawal_id, EVIDENCE_HASH)
    assert contract.get_withdrawal(withdrawal_id)["status"] == "RESTORED_FAILED"
    assert contract.get_claimable(as_address(direct_alice))["claimable_atto"] == BUDGET
    assert contract.get_counts()["total_liability_atto"] == BUDGET
    assert_global_invariant(contract)


def test_withdrawal_confirmation_is_owner_reconciled(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    campaign_id = create_campaign(direct_vm, contract, direct_alice)
    direct_vm.sender = as_address(direct_alice)
    contract.cancel_campaign(campaign_id)
    withdrawal_id = contract.compute_withdrawal_id(as_address(direct_alice), BUDGET)
    contract.request_withdrawal(withdrawal_id, BUDGET)
    emitted_messages = []

    def capture_emit(_vm, request):
        if "EthSend" in request:
            emitted_messages.append(request["EthSend"])
            return {"ok": None}
        return None

    direct_vm._gl_call_hook = capture_emit
    contract.execute_withdrawal(withdrawal_id)
    assert len(emitted_messages) == 1
    assert emitted_messages[0]["address"] == as_address(direct_alice)
    assert emitted_messages[0]["calldata"] == b""
    assert int(emitted_messages[0]["value"]) == BUDGET
    # Mirror the chain-layer balance deduction that direct mode records only
    # as an EthSend envelope.
    direct_vm.deal(direct_vm._contract_address, 0)
    with direct_vm.expect_revert("Only the contract owner"):
        contract.confirm_withdrawal(withdrawal_id, EVIDENCE_HASH)
    direct_vm.sender = as_address(direct_owner)
    contract.confirm_withdrawal(withdrawal_id, EVIDENCE_HASH)
    assert contract.get_withdrawal(withdrawal_id)["status"] == "CONFIRMED"
    assert contract.get_counts()["total_liability_atto"] == 0
    assert contract.get_counts()["total_emitted_unconfirmed_atto"] == 0
    assert_global_invariant(contract)


def test_pause_blocks_new_risk_but_not_refunds(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    direct_vm.sender = as_address(direct_owner)
    contract.set_paused(True)
    values = campaign_args()
    campaign_id = contract.compute_campaign_id(as_address(direct_alice), *values.values())
    direct_vm.sender = as_address(direct_alice)
    direct_vm.value = BUDGET
    with direct_vm.expect_revert("mutations are paused"):
        contract.create_campaign(campaign_id, *values.values())


def test_owner_transfer_and_fee_cap(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    direct_vm.sender = as_address(direct_owner)
    with direct_vm.expect_revert("exceeds the maximum"):
        contract.set_protocol_fee_bps(1_001)
    contract.propose_owner(as_address(direct_alice))
    direct_vm.sender = as_address(direct_bob)
    with direct_vm.expect_revert("not the pending owner"):
        contract.accept_owner()
    direct_vm.sender = as_address(direct_alice)
    contract.accept_owner()
    assert contract.get_config()["owner"] == as_address(direct_alice)


def test_admin_addresses_cannot_be_zero(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy_marketplace(direct_vm, direct_deploy, direct_owner, direct_bob)
    zero = type(contract.get_config()["owner"])(bytes(20))
    direct_vm.sender = as_address(direct_owner)
    with direct_vm.expect_revert("cannot be the zero address"):
        contract.set_treasury(zero)
    with direct_vm.expect_revert("cannot be the zero address"):
        contract.propose_owner(zero)
