import hashlib
import json
from pathlib import Path

from gltest.direct.sdk_loader import setup_sdk_paths


CONTRACT_PATH = Path("contracts/genlayer/AdProofXResolver.py")
POST_ID = "1346889436626259968"
POST_TIME = ((int(POST_ID) >> 22) + 1_288_834_974_657) // 1000
CHECKSUMMED_WALLET = "0x52908400098527886E0F7030069857D2E4169EE7"
WALLET = CHECKSUMMED_WALLET.lower()
X_USER_ID = "2244994945"
IDENTITY_HASH = "0x" + hashlib.sha256(f"x-user-id:{X_USER_ID}".encode()).hexdigest()
CHALLENGE = "APV2-abcdefghijklmnopqrstuvwx"
ISSUED_AT = POST_TIME - 60
EXPIRES_AT = ISSUED_AT + 15 * 60
CREDENTIAL_EXPIRES_AT = ISSUED_AT + 30 * 24 * 60 * 60
AGREEMENT_HASH = "0x" + "88" * 32
SUBMISSION_HASH = "0x" + "99" * 32


def ownership_request_id(
    wallet=WALLET,
    handle="xdevelopers",
    post_id=POST_ID,
    challenge=CHALLENGE,
    issued_at=ISSUED_AT,
    expires_at=EXPIRES_AT,
    credential_expires_at=CREDENTIAL_EXPIRES_AT,
):
    envelope = "|".join((
        "xproof-x-ownership-v2",
        wallet.lower(),
        handle.lstrip("@").lower(),
        post_id,
        challenge,
        str(issued_at),
        str(expires_at),
        str(credential_expires_at),
    ))
    return "0x" + hashlib.sha256(envelope.encode()).hexdigest()


def ownership_post_text(
    wallet=CHECKSUMMED_WALLET,
    challenge=CHALLENGE,
    issued_at=ISSUED_AT,
    expires_at=EXPIRES_AT,
    credential_expires_at=CREDENTIAL_EXPIRES_AT,
):
    return (
        f"XProof v2 w={wallet} n={challenge} i={issued_at} "
        f"e={expires_at} c={credential_expires_at}"
    )


def deploy(direct_vm, direct_deploy):
    setup_sdk_paths(CONTRACT_PATH, "v0.2.16")
    direct_vm.warp("2021-01-06T18:45:00Z")
    direct_vm.check_pickling = True
    return direct_deploy(str(CONTRACT_PATH))


def mock_post(direct_vm, handle="xdevelopers", text=None):
    if text is None:
        text = ownership_post_text()
    direct_vm.mock_web(
        rf".*x\.com/{handle}$",
        {
            "status": 200,
            "body": (
                f'rest_id:"{X_USER_ID}",__typename:"User",privacy:{{}},core:{{}},relationship_counts:{{}}'
                f'__typename:"UserPrivacy",protected:!1,__typename:"UserCore",name:"Developers",'
                f'screen_name:"{handle}",created_at_ms:1386995755036,'
                '__typename:"UserRelationshipCounts",followers:695819,following:762,'
                '__typename:"UserTweetCounts",tweets:4319,'
            ),
        },
    )
    direct_vm.mock_web(
        rf".*x\.com/{handle}/status/{POST_ID}.*",
        {
            "status": 200,
            "body": (
                f'<meta name="twitter:creator" content="@{handle}">'
                f'<meta property="og:description" content="{text}">'
                f'<meta property="og:url" content="https://x.com/{handle}/status/{POST_ID}">'
            ),
        },
    )
    direct_vm.mock_web(
        r".*publish\.twitter\.com/oembed.*",
        {
            "status": 200,
            "body": json.dumps(
                {
                    "url": f"https://x.com/{handle}/status/{POST_ID}",
                    "author_name": handle,
                    "author_url": f"https://x.com/{handle}",
                    "provider_name": "X",
                    "html": f"<blockquote><p>{text}</p> — {handle} status {POST_ID}</blockquote>",
                }
            ),
        },
    )


def test_ownership_verification_binds_wallet_identity_and_post(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    mock_post(direct_vm)
    request_id = ownership_request_id()
    contract.verify_ownership(
        request_id,
        WALLET,
        "@XDevelopers",
        POST_ID,
        CHALLENGE,
        ISSUED_AT,
        EXPIRES_AT,
        CREDENTIAL_EXPIRES_AT,
    )
    result = json.loads(contract.get_result(request_id))
    assert result["kind"] == "OWNERSHIP"
    assert result["outcome"] == "VERIFIED"
    assert result["base_wallet"] == WALLET
    assert result["identity_hash"] == IDENTITY_HASH
    assert result["x_user_id"] == X_USER_ID
    assert result["challenge_hash"] == "0x" + hashlib.sha256(CHALLENGE.encode()).hexdigest()
    assert result["request_match"] is True
    assert result["author_match"] is True
    assert result["challenge_match"] is True
    assert result["wallet_match"] is True
    assert result["issued_at_epoch"] == ISSUED_AT
    assert result["expires_at_epoch"] == EXPIRES_AT
    assert result["credential_expires_at_epoch"] == CREDENTIAL_EXPIRES_AT

    with direct_vm.expect_revert("Request already resolved"):
        contract.verify_ownership(
            request_id,
            WALLET,
            "XDevelopers",
            POST_ID,
            CHALLENGE,
            ISSUED_AT,
            EXPIRES_AT,
            CREDENTIAL_EXPIRES_AT,
        )


def test_ownership_rejects_wrong_challenge(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    mock_post(direct_vm)
    wrong_challenge = "APV2-zyxwvutsrqponmlkjihgfedc"
    request_id = ownership_request_id(challenge=wrong_challenge)
    contract.verify_ownership(
        request_id,
        WALLET,
        "XDevelopers",
        POST_ID,
        wrong_challenge,
        ISSUED_AT,
        EXPIRES_AT,
        CREDENTIAL_EXPIRES_AT,
    )
    result = json.loads(contract.get_result(request_id))
    assert result["outcome"] == "REJECTED"
    assert result["challenge_match"] is False


def test_wrong_post_request_mismatch_reverts_without_consuming_legitimate_id(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    mock_post(direct_vm)
    request_id = ownership_request_id()

    with direct_vm.expect_revert("Request ID does not match ownership envelope"):
        contract.verify_ownership(
            request_id,
            WALLET,
            "XDevelopers",
            str(int(POST_ID) + 1),
            CHALLENGE,
            ISSUED_AT,
            EXPIRES_AT,
            CREDENTIAL_EXPIRES_AT,
        )

    contract.verify_ownership(
        request_id,
        WALLET,
        "XDevelopers",
        POST_ID,
        CHALLENGE,
        ISSUED_AT,
        EXPIRES_AT,
        CREDENTIAL_EXPIRES_AT,
    )
    assert json.loads(contract.get_result(request_id))["outcome"] == "VERIFIED"


def test_ownership_rejects_post_without_exact_wallet_marker(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    other_wallet = "0x" + "22" * 20
    mock_post(direct_vm, text=ownership_post_text(wallet=other_wallet))
    request_id = ownership_request_id()
    contract.verify_ownership(
        request_id,
        WALLET,
        "XDevelopers",
        POST_ID,
        CHALLENGE,
        ISSUED_AT,
        EXPIRES_AT,
        CREDENTIAL_EXPIRES_AT,
    )
    result = json.loads(contract.get_result(request_id))
    assert result["wallet_match"] is False
    assert result["outcome"] == "REJECTED"


def test_ownership_requires_all_exact_timestamp_tokens(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    incomplete_text = ownership_post_text().replace(f" c={CREDENTIAL_EXPIRES_AT}", "")
    mock_post(direct_vm, text=incomplete_text)
    request_id = ownership_request_id()
    contract.verify_ownership(
        request_id,
        WALLET,
        "XDevelopers",
        POST_ID,
        CHALLENGE,
        ISSUED_AT,
        EXPIRES_AT,
        CREDENTIAL_EXPIRES_AT,
    )
    result = json.loads(contract.get_result(request_id))
    assert result["issued_at_match"] is True
    assert result["expires_at_match"] is True
    assert result["credential_expires_at_match"] is False
    assert result["outcome"] == "REJECTED"


def test_public_profile_snapshot_extracts_metrics_without_oauth(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    counts = "".join(
        f'__typename:"ApiCounts",bookmark_count:0,favorite_count:{100 + index},'
        f'reply_count:{10 + index},retweet_count:{20 + index},quote_count:{index}'
        f'__typename:"ViewCountInfo",count:"{1000 + index * 10}"'
        for index in range(8)
    )
    body = (
        'rest_id:"2244994945",__typename:"User",privacy:{},core:{},relationship_counts:{}'
        '__typename:"UserPrivacy",protected:!1,'
        '__typename:"UserCore",name:"Developers",screen_name:"xdevelopers",created_at_ms:1386995755036,'
        '__typename:"UserRelationshipCounts",followers:695819,following:762,'
        '__typename:"UserTweetCounts",tweets:4319,'
        + counts
    )
    direct_vm.mock_web(r".*x\.com/xdevelopers$", {"status": 200, "body": body})
    request_id = "0x" + "55" * 32
    contract.snapshot_metrics(
        request_id,
        WALLET,
        IDENTITY_HASH,
        "XDevelopers",
        POST_TIME + 24 * 60 * 60,
    )
    result = json.loads(contract.get_result(request_id))
    assert result["kind"] == "METRICS"
    assert result["outcome"] == "VERIFIED"
    assert result["x_user_id"] == "2244994945"
    assert result["base_wallet"] == WALLET
    assert result["followers"] == 695819
    assert result["following"] == 762
    assert result["posts_analyzed"] == 8
    assert result["median_likes"] == 103
    assert result["engagement_consistency"] == "LOW_RISK"


def test_campaign_resolution_checks_author_disclosure_and_phrases(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    mock_post(
        direct_vm,
        text="APV-TEST-1234 #ad Try the AdProof app with automatic creator escrow. No hidden fees.",
    )
    request_id = "0x" + "66" * 32
    contract.resolve_submission(
        request_id,
        "XDevelopers",
        POST_ID,
        json.dumps(["AdProof app", "creator escrow"]),
        json.dumps(["guaranteed profit"]),
        True,
        "",
        POST_TIME,
        1,
        AGREEMENT_HASH,
        SUBMISSION_HASH,
    )
    result = json.loads(contract.get_result(request_id))
    assert result["kind"] == "CAMPAIGN"
    assert result["outcome"] == "PASS"
    assert result["disclosure_present"] is True
    assert result["required_checks"] == [True, True]
    assert result["forbidden_checks"] == [False]


def test_campaign_resolution_cannot_run_before_retention(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    with direct_vm.expect_revert("Retention period has not ended"):
        contract.resolve_submission(
            "0x" + "77" * 32,
            "XDevelopers",
            POST_ID,
            "[]",
            "[]",
            False,
            "",
            POST_TIME + 10_000,
            1,
            AGREEMENT_HASH,
            SUBMISSION_HASH,
        )


def test_protected_profile_cannot_produce_verified_metrics(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    body = (
        f'rest_id:"{X_USER_ID}",__typename:"User",privacy:{{}},core:{{}},relationship_counts:{{}}'
        '__typename:"UserPrivacy",protected:!0,'
        '__typename:"UserCore",name:"Developers",screen_name:"xdevelopers",created_at_ms:1386995755036,'
        '__typename:"UserRelationshipCounts",followers:100,following:20,'
        '__typename:"UserTweetCounts",tweets:50,'
    )
    direct_vm.mock_web(r".*x\.com/xdevelopers$", {"status": 200, "body": body})
    request_id = "0x" + "aa" * 32
    contract.snapshot_metrics(
        request_id,
        WALLET,
        IDENTITY_HASH,
        "XDevelopers",
        POST_TIME + 24 * 60 * 60,
    )
    result = json.loads(contract.get_result(request_id))
    assert result["outcome"] == "REJECTED"
    assert result["protected"] is True


def test_rate_limited_profile_is_undetermined(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    direct_vm.mock_web(r".*x\.com/xdevelopers$", {"status": 429, "body": ""})
    request_id = "0x" + "ab" * 32
    contract.snapshot_metrics(
        request_id,
        WALLET,
        IDENTITY_HASH,
        "XDevelopers",
        POST_TIME + 24 * 60 * 60,
    )
    assert json.loads(contract.get_result(request_id))["outcome"] == "UNDETERMINED"


def test_deleted_campaign_post_fails_after_retention(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    direct_vm.mock_web(r".*x\.com/xdevelopers/status/.*", {"status": 404, "body": ""})
    direct_vm.mock_web(r".*publish\.twitter\.com/oembed.*", {"status": 404, "body": ""})
    request_id = "0x" + "ac" * 32
    contract.resolve_submission(
        request_id,
        "XDevelopers",
        POST_ID,
        "[]",
        "[]",
        False,
        "",
        POST_TIME,
        1,
        AGREEMENT_HASH,
        SUBMISSION_HASH,
    )
    assert json.loads(contract.get_result(request_id))["outcome"] == "FAIL"


def test_renamed_handle_does_not_match_old_expected_author(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    direct_vm.mock_web(
        rf".*x\.com/twitterdev/status/{POST_ID}.*",
        {
            "status": 200,
            "body": (
                '<meta name="twitter:creator" content="@xdevelopers">'
                f'<meta property="og:url" content="https://x.com/XDevelopers/status/{POST_ID}">'
                f'<meta property="og:description" content="#ad current text {POST_ID}">'
            ),
        },
    )
    direct_vm.mock_web(
        r".*publish\.twitter\.com/oembed.*",
        {
            "status": 200,
            "body": json.dumps({
                "url": f"https://x.com/XDevelopers/status/{POST_ID}",
                "author_url": "https://x.com/XDevelopers",
                "html": f"<blockquote><p>#ad current text</p> status {POST_ID}</blockquote>",
            }),
        },
    )
    request_id = "0x" + "ad" * 32
    contract.resolve_submission(
        request_id,
        "TwitterDev",
        POST_ID,
        "[]",
        "[]",
        True,
        "",
        POST_TIME,
        1,
        AGREEMENT_HASH,
        SUBMISSION_HASH,
    )
    result = json.loads(contract.get_result(request_id))
    assert result["author_match"] is False
    assert result["outcome"] == "FAIL"


def test_edited_current_text_is_evaluated_not_original_text(direct_vm, direct_deploy):
    contract = deploy(direct_vm, direct_deploy)
    mock_post(direct_vm, text="#ad Revised post with the required claim removed")
    request_id = "0x" + "ae" * 32
    contract.resolve_submission(
        request_id,
        "XDevelopers",
        POST_ID,
        json.dumps(["original required claim"]),
        "[]",
        True,
        "",
        POST_TIME,
        1,
        AGREEMENT_HASH,
        SUBMISSION_HASH,
    )
    result = json.loads(contract.get_result(request_id))
    assert result["required_checks"] == [False]
    assert result["outcome"] == "FAIL"
