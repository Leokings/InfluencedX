"""Guarded StudioNet V3 reviewer lifecycle canary.

The first phase activates the public X + Farcaster identity bundle on the
isolated V3 candidate. Later phases extend this same file with the funded
campaign, submission, bounded resolution, and withdrawal evidence.

Run from the repository root with::

    $env:RUN_STUDIONET_V3_REVIEW_CANARY = "1"
    gltest tests/integration/test_studionet_v3_full_lifecycle.py -v -s --network studionet
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import time
from typing import Any

import pytest
from eth_account import Account
from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded
from gltest.types import CalldataAddress, TransactionStatus


MARKETPLACE = "0x492175c248168DDB9571CBF4c6A14296e3348181"
STUDIONET_CHAIN_ID = 61_999
WALLET = "0x1fB2b8daEB8B1E547F5Ef8328f94b3ce7c309A9F"
REVIEW_KEYSTORE = Path(".secrets/studionet-v3-review/account.keystore.json")
REVIEW_PASSWORD = Path(".secrets/studionet-v3-review/account.password")

X_HANDLE = "plain3rd"
X_POST_ID = "2095949720933786077"
X_CHALLENGE = "APV2-gzr7DDl3ZL_K1n2urtvfY7P2"
X_ISSUED_AT = 1_788_547_312
X_EXPIRES_AT = 1_788_550_912
X_PROFILE_EXPIRES_AT = 1_791_139_312

FARCASTER_USERNAME = "milechain"
FARCASTER_FID = 279_320
FARCASTER_CAST_HASH = "0x563855c38743aa03f1eecb32844cb751549b4284"
FARCASTER_CHALLENGE = "APV2-2mkeCfQOKexN5-ZJI1hiECTs"
FARCASTER_ISSUED_AT = X_ISSUED_AT
FARCASTER_EXPIRES_AT = X_EXPIRES_AT
FARCASTER_PROFILE_EXPIRES_AT = X_PROFILE_EXPIRES_AT

CAMPAIGN_NONCE = "v3-review-lifecycle-20260904"
CAMPAIGN_SOURCE = "FARCASTER"
CAMPAIGN_TITLE = "V3 bounded resolution review"
CAMPAIGN_BRIEF = (
    "Publish a public Farcaster cast confirming the InfluencedX V3 bounded "
    "resolution canary."
)
CAMPAIGN_REQUIRED = '["InfluencedX","bounded resolution"]'
CAMPAIGN_FORBIDDEN = '["prohibited-marker"]'
CAMPAIGN_APPLICATION_DEADLINE = 1_788_555_831
CAMPAIGN_SELECTION_DEADLINE = 1_788_563_031
CAMPAIGN_SUBMISSION_DEADLINE = 1_788_635_031
CAMPAIGN_RETENTION_SECONDS = 60
CAMPAIGN_MAX_RETRIES = 2
CAMPAIGN_BUDGET_ATTO = 100
CAMPAIGN_RATE_ATTO = 100
PITCH_COMMITMENT = "0x" + hashlib.sha256(
    b"InfluencedX StudioNet V3 reviewer lifecycle canary pitch"
).hexdigest()
AGREEMENT_HASH = "0x" + hashlib.sha256(
    b"InfluencedX StudioNet V3 reviewer lifecycle canary agreement"
).hexdigest()
EVIDENCE_CAST_HASH = "0x7878cb2b583714ff9662706b50370093fe080131"
EVIDENCE_CAST_URL = "https://farcaster.xyz/milechain/0x7878cb2b"
EVIDENCE_TEXT = "InfluencedX V3 bounded resolution canary is live on StudioNet. #ad"
EVIDENCE_PUBLISHED_AT = 1_788_549_492
SUBMISSION_HASH = "0x" + hashlib.sha256(
    EVIDENCE_TEXT.encode("utf-8")
).hexdigest()
WITHDRAWAL_ID = "0xca46af640a00a3daf49aec2fe7d4a2e4fbf56f068d99f5127a479d41939aa258"
TRANSFER_EVIDENCE_HASH = (
    "0x3cf197036e9362c26e0cdf9d0a6d00dd15cdd482e8e12139f8c8f49f1e3e55ad"
)


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_STUDIONET_V3_REVIEW_CANARY") != "1",
    reason="live StudioNet V3 review canary mutation requires the explicit guard",
)


def _tx_hash(receipt: dict[str, Any]) -> str:
    value = receipt.get("tx_id") or receipt.get("hash")
    assert isinstance(value, str) and value.startswith("0x") and len(value) == 66
    return value


def _assert_finalized_consensus_success(receipt: dict[str, Any]) -> None:
    assert receipt.get("status_name") == "FINALIZED", receipt
    assert receipt.get("result_name") == "MAJORITY_AGREE", receipt
    assert tx_execution_succeeded(receipt), receipt


def _sha256_text(value: str) -> str:
    return "0x" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _campaign_ids(wallet: str) -> tuple[str, str, str]:
    terms = {
        "content_source": CAMPAIGN_SOURCE,
        "title": CAMPAIGN_TITLE,
        "brief": CAMPAIGN_BRIEF,
        "required_phrases": json.loads(CAMPAIGN_REQUIRED),
        "forbidden_phrases": json.loads(CAMPAIGN_FORBIDDEN),
        "require_ad_disclosure": True,
        "application_deadline_epoch": CAMPAIGN_APPLICATION_DEADLINE,
        "selection_deadline_epoch": CAMPAIGN_SELECTION_DEADLINE,
        "submission_deadline_epoch": CAMPAIGN_SUBMISSION_DEADLINE,
        "retention_seconds": CAMPAIGN_RETENTION_SECONDS,
        "max_undetermined_retries": CAMPAIGN_MAX_RETRIES,
    }
    terms_hash = _sha256_text(
        json.dumps(terms, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    )
    normalized_wallet = wallet.lower()
    campaign_id = _sha256_text("|".join((
        "influencedx-campaign-v2",
        normalized_wallet,
        CAMPAIGN_NONCE,
        terms_hash,
        str(CAMPAIGN_BUDGET_ATTO),
    )))
    application_id = _sha256_text("|".join((
        "influencedx-application-v1", campaign_id, normalized_wallet,
    )))
    assignment_id = _sha256_text("|".join((
        "influencedx-assignment-v1",
        campaign_id,
        normalized_wallet,
        str(CAMPAIGN_RATE_ATTO),
        AGREEMENT_HASH,
    )))
    return campaign_id, application_id, assignment_id


def _submission_request_id(assignment_id: str, round_index: int = 0) -> str:
    return _sha256_text("|".join((
        "influencedx-resolution-v2",
        assignment_id,
        AGREEMENT_HASH,
        SUBMISSION_HASH,
        CAMPAIGN_SOURCE,
        EVIDENCE_CAST_HASH,
        str(round_index),
    )))


def _wait_for_triggered_transaction_ids(
    gl_client: Any,
    parent_hash: str,
    *,
    expected: int,
    attempts: int = 60,
) -> list[str]:
    last: list[str] = []
    for _ in range(attempts):
        try:
            last = [
                str(value)
                for value in gl_client.get_triggered_transaction_ids(parent_hash)
            ]
            if len(last) >= expected:
                return last
        except Exception:
            pass
        time.sleep(2)
    raise AssertionError(
        f"expected {expected} triggered transactions but observed {len(last)}"
    )


def _review_account() -> Any:
    assert REVIEW_KEYSTORE.is_file()
    assert REVIEW_PASSWORD.is_file()
    encrypted = json.loads(REVIEW_KEYSTORE.read_text(encoding="utf-8"))
    password = REVIEW_PASSWORD.read_text(encoding="utf-8")
    account = Account.from_key(Account.decrypt(encrypted, password))
    assert account.address.lower() == WALLET.lower()
    return account


def test_01_activate_public_identity_bundle(gl_client: Any) -> None:
    assert gl_client.chain.id == STUDIONET_CHAIN_ID
    signer = _review_account()
    account = CalldataAddress(signer.address)
    marketplace = get_contract_factory(
        contract_name="InfluencedXMarketplace"
    ).build_contract(MARKETPLACE, account=signer)

    x_request_id = marketplace.compute_ownership_request_id(
        args=[
            account,
            X_HANDLE,
            X_POST_ID,
            X_CHALLENGE,
            X_ISSUED_AT,
            X_EXPIRES_AT,
            X_PROFILE_EXPIRES_AT,
        ]
    ).call()
    farcaster_request_id = marketplace.compute_farcaster_ownership_request_id(
        args=[
            account,
            FARCASTER_USERNAME,
            FARCASTER_FID,
            FARCASTER_CAST_HASH,
            FARCASTER_CHALLENGE,
            FARCASTER_ISSUED_AT,
            FARCASTER_EXPIRES_AT,
            FARCASTER_PROFILE_EXPIRES_AT,
        ]
    ).call()
    bundle_request_id = marketplace.compute_identity_bundle_request_id(
        args=[account, x_request_id, farcaster_request_id]
    ).call()

    bundle_result = marketplace.get_ownership_result(
        args=[bundle_request_id]
    ).call()
    receipt = None
    if not bundle_result:
        receipt = marketplace.activate_identity_bundle(
            args=[
                bundle_request_id,
                x_request_id,
                X_HANDLE,
                X_POST_ID,
                X_CHALLENGE,
                X_ISSUED_AT,
                X_EXPIRES_AT,
                X_PROFILE_EXPIRES_AT,
                farcaster_request_id,
                FARCASTER_USERNAME,
                FARCASTER_FID,
                FARCASTER_CAST_HASH,
                FARCASTER_CHALLENGE,
                FARCASTER_ISSUED_AT,
                FARCASTER_EXPIRES_AT,
                FARCASTER_PROFILE_EXPIRES_AT,
            ]
        ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
        _assert_finalized_consensus_success(receipt)

    profile = marketplace.get_profile(args=[account]).call()
    x_identity = marketplace.get_identity(args=[account, "X"]).call()
    farcaster_identity = marketplace.get_identity(
        args=[account, "FARCASTER"]
    ).call()
    bundle_result = marketplace.get_ownership_result(args=[bundle_request_id]).call()
    x_result = marketplace.get_ownership_result(args=[x_request_id]).call()
    farcaster_result = marketplace.get_ownership_result(
        args=[farcaster_request_id]
    ).call()
    print(json.dumps({
        "bundle_result": bundle_result,
        "x_result": x_result,
        "farcaster_result": farcaster_result,
        "profile": profile,
    }, sort_keys=True))
    assert profile["active"] is True
    assert x_identity["status"] == "ACTIVE"
    assert x_identity["handle"] == X_HANDLE
    assert farcaster_identity["status"] == "ACTIVE"
    assert farcaster_identity["fid"] == FARCASTER_FID
    assert bundle_result["outcome"] == "VERIFIED"

    print(json.dumps({
        "phase": "identity_activation",
        "contract": MARKETPLACE,
        "wallet": signer.address,
        "x_post_url": f"https://x.com/{X_HANDLE}/status/{X_POST_ID}",
        "farcaster_cast_url": (
            f"https://farcaster.xyz/{FARCASTER_USERNAME}/"
            f"{FARCASTER_CAST_HASH[:10]}"
        ),
        "farcaster_cast_hash": FARCASTER_CAST_HASH,
        "bundle_request_id": bundle_request_id,
        "x_request_id": x_request_id,
        "farcaster_request_id": farcaster_request_id,
        "activation_tx": _tx_hash(receipt) if receipt is not None else None,
        "outcome": bundle_result["outcome"],
    }, sort_keys=True))


def test_02_fund_campaign_and_accept_assignment(gl_client: Any) -> None:
    assert gl_client.chain.id == STUDIONET_CHAIN_ID
    signer = _review_account()
    account = CalldataAddress(signer.address)
    marketplace = get_contract_factory(
        contract_name="InfluencedXMarketplace"
    ).build_contract(MARKETPLACE, account=signer)
    profile = marketplace.get_profile(args=[account]).call()
    assert profile["active"] is True

    campaign_args = [
        CAMPAIGN_NONCE,
        CAMPAIGN_SOURCE,
        CAMPAIGN_TITLE,
        CAMPAIGN_BRIEF,
        CAMPAIGN_REQUIRED,
        CAMPAIGN_FORBIDDEN,
        True,
        CAMPAIGN_APPLICATION_DEADLINE,
        CAMPAIGN_SELECTION_DEADLINE,
        CAMPAIGN_SUBMISSION_DEADLINE,
        CAMPAIGN_RETENTION_SECONDS,
        CAMPAIGN_MAX_RETRIES,
        CAMPAIGN_BUDGET_ATTO,
    ]
    campaign_id, application_id, assignment_id = _campaign_ids(signer.address)

    balance = gl_client.get_balance(signer.address)
    if balance < CAMPAIGN_BUDGET_ATTO:
        funded = gl_client.provider.make_request(
            "sim_fundAccount", [signer.address, CAMPAIGN_BUDGET_ATTO - balance]
        )
        assert "error" not in funded, funded

    create_receipt = marketplace.create_campaign(
        args=[campaign_id, *campaign_args]
    ).transact(
        value=CAMPAIGN_BUDGET_ATTO,
        wait_transaction_status=TransactionStatus.FINALIZED,
    )
    _assert_finalized_consensus_success(create_receipt)
    apply_receipt = marketplace.apply_to_campaign(
        args=[campaign_id, application_id, CAMPAIGN_RATE_ATTO, PITCH_COMMITMENT]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    _assert_finalized_consensus_success(apply_receipt)
    select_receipt = marketplace.select_creator(
        args=[campaign_id, assignment_id, account, CAMPAIGN_RATE_ATTO, AGREEMENT_HASH]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    _assert_finalized_consensus_success(select_receipt)
    accept_receipt = marketplace.accept_assignment(args=[assignment_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED
    )
    _assert_finalized_consensus_success(accept_receipt)

    campaign = marketplace.get_campaign(args=[campaign_id]).call()
    application = marketplace.get_application(args=[campaign_id, account]).call()
    assignment = marketplace.get_assignment(args=[assignment_id]).call()
    assert campaign["budget_atto"] == CAMPAIGN_BUDGET_ATTO
    assert campaign["reserved_atto"] == CAMPAIGN_RATE_ATTO
    assert application["status"] == "SELECTED"
    assert assignment["status"] == "ACCEPTED"

    print(json.dumps({
        "phase": "funded_campaign_through_acceptance",
        "campaign_id": campaign_id,
        "application_id": application_id,
        "assignment_id": assignment_id,
        "create_tx": _tx_hash(create_receipt),
        "apply_tx": _tx_hash(apply_receipt),
        "select_tx": _tx_hash(select_receipt),
        "accept_tx": _tx_hash(accept_receipt),
        "assignment_status": assignment["status"],
        "accepted_at_epoch": assignment["accepted_at_epoch"],
    }, sort_keys=True))


def test_03_submit_campaign_evidence(gl_client: Any) -> None:
    assert gl_client.chain.id == STUDIONET_CHAIN_ID
    signer = _review_account()
    marketplace = get_contract_factory(
        contract_name="InfluencedXMarketplace"
    ).build_contract(MARKETPLACE, account=signer)
    _, _, assignment_id = _campaign_ids(signer.address)
    request_id = _submission_request_id(assignment_id)
    before = marketplace.get_assignment(args=[assignment_id]).call()
    assert before["status"] == "ACCEPTED"
    assert EVIDENCE_PUBLISHED_AT >= before["accepted_at_epoch"]

    receipt = marketplace.submit_evidence(args=[
        assignment_id,
        request_id,
        EVIDENCE_CAST_HASH,
        SUBMISSION_HASH,
    ]).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    _assert_finalized_consensus_success(receipt)
    assignment = marketplace.get_assignment(args=[assignment_id]).call()
    assert assignment["status"] == "SUBMITTED"
    assert assignment["post_id"] == EVIDENCE_CAST_HASH
    assert assignment["resolution_request_id"] == request_id
    assert assignment["resolution_attempts"] == 0

    print(json.dumps({
        "phase": "evidence_submission",
        "assignment_id": assignment_id,
        "cast_url": EVIDENCE_CAST_URL,
        "cast_hash": EVIDENCE_CAST_HASH,
        "published_at_epoch": EVIDENCE_PUBLISHED_AT,
        "submission_hash": SUBMISSION_HASH,
        "resolution_request_id": request_id,
        "submit_tx": _tx_hash(receipt),
        "assignment_status": assignment["status"],
        "resolution_eligible_at_epoch": assignment["resolution_eligible_at_epoch"],
    }, sort_keys=True))


def test_04_resolve_through_bounded_children(gl_client: Any) -> None:
    assert gl_client.chain.id == STUDIONET_CHAIN_ID
    signer = _review_account()
    marketplace = get_contract_factory(
        contract_name="InfluencedXMarketplace"
    ).build_contract(MARKETPLACE, account=signer)
    _, _, assignment_id = _campaign_ids(signer.address)
    request_id = _submission_request_id(assignment_id)
    before = marketplace.get_assignment(args=[assignment_id]).call()
    assert before["status"] == "SUBMITTED"
    wait_seconds = max(0, int(before["resolution_eligible_at_epoch"]) - int(time.time()))
    if wait_seconds:
        time.sleep(wait_seconds + 2)

    parent_receipt = marketplace.resolve_assignment(
        args=[assignment_id, request_id]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    _assert_finalized_consensus_success(parent_receipt)
    parent_hash = _tx_hash(parent_receipt)
    child_ids = _wait_for_triggered_transaction_ids(
        gl_client, parent_hash, expected=2
    )
    child_receipts = []
    for child_id in child_ids:
        child = gl_client.wait_for_transaction_receipt(
            transaction_hash=child_id,
            status=TransactionStatus.FINALIZED,
            interval=3_000,
            retries=80,
            full_transaction=True,
        )
        assert child.get("status_name") == "FINALIZED", child
        assert child.get("triggered_by") == parent_hash, child
        child_receipts.append(child)

    assignment = marketplace.get_assignment(args=[assignment_id]).call()
    assert assignment["status"] == "SETTLED_PASS", assignment
    assert assignment["outcome"] == "PASS"
    assert assignment["resolution_attempts"] == 1
    assert assignment["resolution_pending"] is False
    checks = assignment["resolution_checks"]
    assert checks["author_match"] is True
    assert checks["post_id_match"] is True
    assert checks["stable_identity_match"] is True
    assert checks["publication_in_window"] is True
    assert checks["required_checks"] == [True, True]
    assert checks["forbidden_checks"] == [False]
    assert checks["disclosure_present"] is True
    assert checks["semantic_evaluated"] is True
    assert checks["semantic_pass"] is True

    print(json.dumps({
        "phase": "bounded_resolution",
        "assignment_id": assignment_id,
        "request_id": request_id,
        "resolve_parent_tx": parent_hash,
        "resolution_child_txs": child_ids,
        "resolution_child_statuses": [
            child.get("status_name") for child in child_receipts
        ],
        "assignment_status": assignment["status"],
        "outcome": assignment["outcome"],
        "resolution_attempts": assignment["resolution_attempts"],
        "resolution_checks": checks,
        "evidence_hash": assignment["evidence_hash"],
        "creator_credit_atto": assignment["creator_credit_atto"],
        "fee_atto": assignment["fee_atto"],
    }, sort_keys=True))


def test_05_withdraw_creator_credit(gl_client: Any) -> None:
    assert gl_client.chain.id == STUDIONET_CHAIN_ID
    signer = _review_account()
    account = CalldataAddress(signer.address)
    marketplace = get_contract_factory(
        contract_name="InfluencedXMarketplace"
    ).build_contract(MARKETPLACE, account=signer)
    _, _, assignment_id = _campaign_ids(signer.address)
    assignment = marketplace.get_assignment(args=[assignment_id]).call()
    assert assignment["status"] == "SETTLED_PASS"
    amount = int(assignment["creator_credit_atto"])
    assert amount == 98

    claimable = marketplace.get_claimable(args=[account]).call()
    assert claimable["claimable_atto"] == amount
    nonce = int(claimable["next_withdrawal_nonce"])
    withdrawal_id = _sha256_text("|".join((
        "influencedx-withdrawal-v1",
        signer.address.lower(),
        str(nonce),
        str(amount),
    )))

    request_receipt = marketplace.request_withdrawal(
        args=[withdrawal_id, amount]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    _assert_finalized_consensus_success(request_receipt)
    execute_receipt = marketplace.execute_withdrawal(
        args=[withdrawal_id]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    _assert_finalized_consensus_success(execute_receipt)
    execute_hash = _tx_hash(execute_receipt)
    transfer_ids = _wait_for_triggered_transaction_ids(
        gl_client, execute_hash, expected=1
    )
    assert len(transfer_ids) == 1, transfer_ids
    transfer = gl_client.wait_for_transaction_receipt(
        transaction_hash=transfer_ids[0],
        status=TransactionStatus.FINALIZED,
        interval=3_000,
        retries=80,
        full_transaction=True,
    )
    assert transfer.get("status_name") == "FINALIZED", transfer
    assert transfer.get("triggered_by") == execute_hash, transfer
    assert str(transfer.get("triggered_on", "")).upper() == "FINALIZED"
    assert str(
        transfer.get("sender") or transfer.get("from_address") or ""
    ).lower() == MARKETPLACE.lower()
    assert str(
        transfer.get("recipient") or transfer.get("to_address") or ""
    ).lower() == signer.address.lower()
    assert int(transfer.get("value", 0)) == amount
    assert transfer.get("value_credited") is True

    withdrawal = marketplace.get_withdrawal(args=[withdrawal_id]).call()
    assert withdrawal["status"] == "EMITTED_UNCONFIRMED"
    assert withdrawal["amount_atto"] == amount
    remaining = marketplace.get_claimable(args=[account]).call()
    assert remaining["claimable_atto"] == 0
    proof = {
        "schemaVersion": 1,
        "domain": "influencedx-withdrawal-transfer-evidence-v1",
        "network": "studionet",
        "chainId": STUDIONET_CHAIN_ID,
        "contractAddress": MARKETPLACE.lower(),
        "withdrawalId": withdrawal_id,
        "account": signer.address.lower(),
        "amountAtto": str(amount),
        "emittedAtEpoch": withdrawal["emitted_at_epoch"],
        "parentTxHash": execute_hash,
        "childTxHash": transfer_ids[0],
        "valueCredited": True,
    }
    transfer_evidence_hash = _sha256_text(
        json.dumps(proof, sort_keys=True, separators=(",", ":"))
    )

    print(json.dumps({
        "phase": "creator_withdrawal",
        "assignment_id": assignment_id,
        "withdrawal_id": withdrawal_id,
        "amount_atto": amount,
        "request_withdrawal_tx": _tx_hash(request_receipt),
        "execute_withdrawal_tx": execute_hash,
        "external_transfer_tx": transfer_ids[0],
        "external_transfer_finalized": True,
        "external_value_credited": True,
        "contract_confirmation_status": withdrawal["status"],
        "transfer_evidence_hash": transfer_evidence_hash,
    }, sort_keys=True))


def test_06_confirm_emitted_transfer(gl_client: Any) -> None:
    """Bind the finalized transfer proof into the isolated V3 withdrawal state."""

    assert gl_client.chain.id == STUDIONET_CHAIN_ID
    signer = _review_account()
    confirmer_marketplace = get_contract_factory(
        contract_name="InfluencedXMarketplace"
    ).build_contract(MARKETPLACE, account=signer)
    config = confirmer_marketplace.get_config(args=[]).call()
    configured_confirmer = str(config["withdrawal_confirmer"]).lower().replace(
        "addr#", "0x"
    )
    assert configured_confirmer == signer.address.lower()

    before = confirmer_marketplace.get_withdrawal(args=[WITHDRAWAL_ID]).call()
    counts_before = confirmer_marketplace.get_counts(args=[]).call()
    confirm_receipt = None
    if before["status"] == "EMITTED_UNCONFIRMED":
        confirm_receipt = confirmer_marketplace.confirm_withdrawal(
            args=[WITHDRAWAL_ID, TRANSFER_EVIDENCE_HASH]
        ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
        _assert_finalized_consensus_success(confirm_receipt)

    confirmed = confirmer_marketplace.get_withdrawal(args=[WITHDRAWAL_ID]).call()
    counts_after = confirmer_marketplace.get_counts(args=[]).call()
    assert confirmed["status"] == "CONFIRMED"
    assert confirmed["evidence_hash"] == TRANSFER_EVIDENCE_HASH
    assert confirmed["reconciled_at_epoch"] > 0
    if confirm_receipt is not None:
        amount = int(confirmed["amount_atto"])
        assert (
            counts_after["total_emitted_unconfirmed_atto"]
            == counts_before["total_emitted_unconfirmed_atto"] - amount
        )
        assert (
            counts_after["total_withdrawn_atto"]
            == counts_before["total_withdrawn_atto"] + amount
        )

    print(json.dumps({
        "phase": "withdrawal_confirmation",
        "contract": MARKETPLACE,
        "withdrawal_id": WITHDRAWAL_ID,
        "withdrawal_confirmer": signer.address,
        "confirm_withdrawal_tx": (
            _tx_hash(confirm_receipt) if confirm_receipt is not None else None
        ),
        "transfer_evidence_hash": TRANSFER_EVIDENCE_HASH,
        "withdrawal_status": confirmed["status"],
        "reconciled_at_epoch": confirmed["reconciled_at_epoch"],
    }, sort_keys=True))
