"""Guarded StudioNet canary for InfluencedX native GEN value movement.

This test intentionally targets the frozen StudioNet V2 deployment. It is skipped
unless explicitly enabled because every successful run appends one tiny cancelled
campaign and one withdrawal record to the live test deployment.

Run from the repository root with::

    $env:RUN_STUDIONET_NATIVE_VALUE_CANARY = "1"
    $env:ACKNOWLEDGE_STUDIONET_CANARY_RECONCILIATION = "1"
    gltest tests/integration/test_studionet_native_value_canary.py -v -s --network studionet

The emitted withdrawal must then be confirmed by the hosted restricted
withdrawal confirmer using the printed evidence hash. The second guard prevents an ordinary test run from
silently leaving an emitted-but-unconfirmed accounting liability.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from typing import Any

import pytest
from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded
from gltest.types import CalldataAddress, TransactionStatus
from genlayer_py.abi import calldata
from genlayer_py.abi.transactions import serialize
from genlayer_py.contracts.utils import make_calldata_object
import requests


MARKETPLACE = "0xEaCeBa807a7A4dc370f3B5a8e45539596b8551b4"
STUDIONET_CHAIN_ID = 61_999
CANARY_AMOUNT_ATTO = 1


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_STUDIONET_NATIVE_VALUE_CANARY") != "1"
    or os.getenv("ACKNOWLEDGE_STUDIONET_CANARY_RECONCILIATION") != "1",
    reason="live StudioNet mutation and owner reconciliation require both canary guards",
)


def _tx_hash(receipt: dict[str, Any]) -> str:
    value = receipt.get("tx_id") or receipt.get("hash")
    assert isinstance(value, str) and value.startswith("0x") and len(value) == 66
    return value


def _assert_finalized_consensus_success(receipt: dict[str, Any]) -> None:
    """Require lifecycle finality, majority agreement, and one successful leader."""

    assert receipt.get("status_name") == "FINALIZED", receipt
    assert receipt.get("result_name") == "MAJORITY_AGREE", receipt
    assert tx_execution_succeeded(receipt), receipt

    leader_receipts = [
        item
        for item in receipt.get("consensus_data", {}).get("leader_receipt", [])
        if item.get("mode") == "leader"
    ]
    assert len(leader_receipts) == 1, receipt
    leader = leader_receipts[0]
    assert leader.get("execution_result") == "SUCCESS", leader
    assert leader.get("result", {}).get("status") == "return", leader


def _wait_for_triggered_transaction_ids(
    gl_client: Any, parent_hash: str, *, attempts: int = 30
) -> list[str]:
    """Wait for StudioNet's finalized internal-message event to become queryable."""

    last_error: Exception | None = None
    for _ in range(attempts):
        try:
            ids = gl_client.get_triggered_transaction_ids(parent_hash)
            if ids:
                return [str(value) for value in ids]
        except Exception as error:  # StudioNet log indexing can briefly lag finality.
            last_error = error
        time.sleep(2)
    if last_error is not None:
        raise AssertionError("triggered transaction lookup never stabilized") from last_error
    raise AssertionError("withdrawal emitted no triggered transaction")


def _read_error_diagnostics(
    gl_client: Any, sender: str, method: str, args: list[Any]
) -> str:
    """Return a sanitized GenVM error when the SDK hides gen_call details."""

    encoded = serialize(
        [calldata.encode(make_calldata_object(method=method, args=args)), b"\x00"]
    )
    response = requests.post(
        gl_client.provider.url,
        json={
            "jsonrpc": "2.0",
            "id": int(time.time() * 1000),
            "method": "gen_call",
            "params": [
                {
                    "type": "read",
                    "to": MARKETPLACE,
                    "from": sender,
                    "data": encoded,
                    "transaction_hash_variant": "latest-nonfinal",
                }
            ],
        },
        headers={"Content-Type": "application/json", "User-Agent": "InfluencedX-canary"},
        timeout=30,
    ).json()
    receipt = response.get("error", {}).get("data", {}).get("receipt", {})
    result = receipt.get("result")
    decoded_result = None
    if isinstance(result, str):
        try:
            decoded_result = (
                base64.b64decode(result)
                .decode("utf-8", errors="replace")
                .lstrip("\x01")
            )
        except Exception:
            pass
    return json.dumps(
        {
            "execution_result": receipt.get("execution_result"),
            "result": decoded_result,
            "genvm_result": receipt.get("genvm_result"),
        },
        sort_keys=True,
    )


def test_frozen_v2_native_gen_escrow_refund_and_eoa_withdrawal(
    gl_client: Any, default_account: Any
) -> None:
    """Prove one atto enters escrow, becomes credit, and reaches the brand EOA."""

    assert gl_client.chain.id == STUDIONET_CHAIN_ID
    brand = default_account
    brand_address = brand.address
    brand_calldata = CalldataAddress(brand_address)

    factory = get_contract_factory(contract_name="InfluencedXMarketplace")
    marketplace = factory.build_contract(MARKETPLACE, account=brand)

    config = marketplace.get_config(args=[]).call()
    assert config["protocol_version"] == "INFLUENCEDX_MARKETPLACE_V2"
    assert config["storage_schema_version"] == 2
    assert config["paused"] is False
    assert config["upgrade_delay_seconds"] == 7 * 24 * 60 * 60

    now = int(time.time())
    client_nonce = "canary-" + secrets.token_hex(12)
    required_phrases_json = json.dumps(["InfluencedX"], separators=(",", ":"))
    forbidden_phrases_json = "[]"
    args_without_id = [
        client_nonce,
        "X",
        "StudioNet canary",
        "One-atto native escrow and withdrawal integration canary.",
        required_phrases_json,
        forbidden_phrases_json,
        True,
        now + 3_600,
        now + 7_200,
        now + 10_800,
        60,
        1,
        CANARY_AMOUNT_ATTO,
    ]
    compute_args = [brand_calldata, *args_without_id]
    try:
        campaign_id = marketplace.compute_campaign_id(args=compute_args).call()
    except Exception as error:
        diagnostic = _read_error_diagnostics(
            gl_client, brand_address, "compute_campaign_id", compute_args
        )
        raise AssertionError(f"compute_campaign_id failed: {diagnostic}") from error

    counts_before = marketplace.get_counts(args=[]).call()
    brand_balance_before_faucet = gl_client.get_balance(brand_address)

    # StudioNet's documented built-in faucet is exposed by the Studio simulator RPC.
    faucet_hash = None
    if brand_balance_before_faucet < CANARY_AMOUNT_ATTO:
        faucet_result = gl_client.provider.make_request(
            "sim_fundAccount",
            [brand_address, CANARY_AMOUNT_ATTO - brand_balance_before_faucet],
        )
        assert "error" not in faucet_result, faucet_result
        faucet_hash = faucet_result.get("result")
        assert isinstance(faucet_hash, str) and faucet_hash.startswith("0x")
    funded_brand_balance = gl_client.get_balance(brand_address)
    assert funded_brand_balance >= CANARY_AMOUNT_ATTO

    create_receipt = marketplace.create_campaign(
        args=[campaign_id, *args_without_id]
    ).transact(
        value=CANARY_AMOUNT_ATTO,
        wait_transaction_status=TransactionStatus.FINALIZED,
    )
    _assert_finalized_consensus_success(create_receipt)
    assert gl_client.get_balance(brand_address) == funded_brand_balance - CANARY_AMOUNT_ATTO

    funded = marketplace.get_campaign(args=[campaign_id]).call()
    assert funded["status"] == "OPEN"
    assert funded["budget_atto"] == CANARY_AMOUNT_ATTO
    assert funded["available_atto"] == CANARY_AMOUNT_ATTO
    assert funded["brand"] == brand_address.lower()

    cancel_receipt = marketplace.cancel_campaign(args=[campaign_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED
    )
    _assert_finalized_consensus_success(cancel_receipt)

    cancelled = marketplace.get_campaign(args=[campaign_id]).call()
    assert cancelled["status"] == "CANCELLED"
    assert cancelled["available_atto"] == 0
    assert cancelled["brand_refunded_atto"] == CANARY_AMOUNT_ATTO
    credit = marketplace.get_claimable(args=[brand_calldata]).call()
    assert credit["claimable_atto"] == CANARY_AMOUNT_ATTO

    withdrawal_id = marketplace.compute_withdrawal_id(
        args=[brand_calldata, CANARY_AMOUNT_ATTO]
    ).call()
    request_receipt = marketplace.request_withdrawal(
        args=[withdrawal_id, CANARY_AMOUNT_ATTO]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    _assert_finalized_consensus_success(request_receipt)

    pending = marketplace.get_withdrawal(args=[withdrawal_id]).call()
    assert pending["status"] == "PENDING"
    assert pending["account"] == brand_address.lower()
    assert pending["amount_atto"] == CANARY_AMOUNT_ATTO

    execute_receipt = marketplace.execute_withdrawal(args=[withdrawal_id]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED
    )
    _assert_finalized_consensus_success(execute_receipt)
    execute_hash = _tx_hash(execute_receipt)

    triggered_ids = _wait_for_triggered_transaction_ids(gl_client, execute_hash)
    assert len(triggered_ids) == 1, triggered_ids
    transfer_receipt = gl_client.wait_for_transaction_receipt(
        transaction_hash=triggered_ids[0],
        status=TransactionStatus.FINALIZED,
        interval=3_000,
        retries=50,
        full_transaction=True,
    )
    assert transfer_receipt.get("status_name") == "FINALIZED", transfer_receipt
    assert transfer_receipt.get("triggered_by") == execute_hash, transfer_receipt
    assert (
        str(transfer_receipt.get("triggered_on", "")).upper() == "FINALIZED"
    ), transfer_receipt
    assert str(
        transfer_receipt.get("sender")
        or transfer_receipt.get("from_address")
        or ""
    ).lower() == MARKETPLACE.lower()
    assert str(
        transfer_receipt.get("recipient")
        or transfer_receipt.get("to_address")
        or ""
    ).lower() == brand_address.lower()
    assert int(transfer_receipt.get("value", 0)) == CANARY_AMOUNT_ATTO
    assert transfer_receipt.get("value_credited") is True

    emitted = marketplace.get_withdrawal(args=[withdrawal_id]).call()
    assert emitted["status"] == "EMITTED_UNCONFIRMED"
    assert emitted["amount_atto"] == CANARY_AMOUNT_ATTO
    assert gl_client.get_balance(brand_address) == funded_brand_balance

    counts_after = marketplace.get_counts(args=[]).call()
    assert counts_after["campaign_count"] == counts_before["campaign_count"] + 1
    assert counts_after["withdrawal_count"] == counts_before["withdrawal_count"] + 1
    assert (
        counts_after["total_emitted_unconfirmed_atto"]
        == counts_before["total_emitted_unconfirmed_atto"] + CANARY_AMOUNT_ATTO
    )
    assert counts_after["contract_balance_atto"] == counts_before["contract_balance_atto"]

    proof_base = {
        "schemaVersion": 1,
        "domain": "influencedx-withdrawal-transfer-evidence-v1",
        "network": "studionet",
        "chainId": STUDIONET_CHAIN_ID,
        "contractAddress": MARKETPLACE.lower(),
        "withdrawalId": withdrawal_id,
        "account": brand_address.lower(),
        "amountAtto": str(CANARY_AMOUNT_ATTO),
        "emittedAtEpoch": emitted["emitted_at_epoch"],
        "parentTxHash": execute_hash,
        "childTxHash": triggered_ids[0],
        "valueCredited": True,
    }
    evidence_hash = "0x" + hashlib.sha256(
        json.dumps(proof_base, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    print(
        json.dumps(
            {
                "network": "studionet",
                "chain_id": STUDIONET_CHAIN_ID,
                "contract": MARKETPLACE,
                "brand": brand_address,
                "amount_atto": CANARY_AMOUNT_ATTO,
                "faucet_tx": faucet_hash,
                "campaign_id": campaign_id,
                "create_tx": _tx_hash(create_receipt),
                "cancel_tx": _tx_hash(cancel_receipt),
                "withdrawal_id": withdrawal_id,
                "request_withdrawal_tx": _tx_hash(request_receipt),
                "execute_withdrawal_tx": execute_hash,
                "external_transfer_tx": triggered_ids[0],
                "evidence_hash": evidence_hash,
                "brand_balance_before": brand_balance_before_faucet,
                "brand_balance_after": gl_client.get_balance(brand_address),
                "withdrawal_status": emitted["status"],
            },
            sort_keys=True,
        )
    )
