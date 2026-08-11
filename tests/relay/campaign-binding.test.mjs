import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters } from 'viem';

import {
  assertVerifiedBaseCampaignBinding,
  deriveBaseCampaignRequestId,
  normalizeCampaignBinding,
  readBaseCampaignBinding,
} from '../../src/relay/campaign-binding.mjs';

const receiver = getAddress(`0x${'11'.repeat(20)}`);
const escrow = getAddress(`0x${'22'.repeat(20)}`);
const brand = getAddress(`0x${'33'.repeat(20)}`);
const creator = getAddress(`0x${'44'.repeat(20)}`);
const termsHash = `0x${'55'.repeat(32)}`;
const agreementHash = `0x${'66'.repeat(32)}`;
const submissionHash = `0x${'77'.repeat(32)}`;
const identityHash = `0x${'88'.repeat(32)}`;
const postIdHash = `0x${'99'.repeat(32)}`;
const assignmentId = 9n;
const campaignId = 17n;
const round = 2n;
const submittedAt = 1_800_000_000n;
const retentionSeconds = 600n;
const requestId = deriveBaseCampaignRequestId({
  chainId: 84_532,
  escrow,
  assignmentId,
  resolutionRound: round,
  agreementHash,
  submissionHash,
});

function expectedBinding(overrides = {}) {
  return {
    chainId: 84_532,
    receiver,
    escrow,
    campaignId: campaignId.toString(),
    assignmentId: assignmentId.toString(),
    brand,
    creator,
    termsHash,
    agreementHash,
    submissionHash,
    expectedHandle: 'creator_name',
    postId: '2109876543210987654',
    requiredPhrasesJson: '["InfluencedX","creator escrow"]',
    forbiddenPhrasesJson: '["guaranteed profit"]',
    requireAdDisclosure: true,
    semanticBrief: 'Explain the product accurately.',
    ...overrides,
  };
}

function assignment() {
  return [
    campaignId,
    creator,
    identityHash,
    agreementHash,
    125_500_000n,
    1_799_999_000n,
    submittedAt,
    postIdHash,
    submissionHash,
    requestId,
    round,
    250,
    4,
  ];
}

function assignmentWith(overrides = {}) {
  const fields = assignment();
  const indexes = {
    campaignId: 0,
    creator: 1,
    agreementHash: 3,
    submittedAt: 6,
    submissionHash: 8,
    requestId: 9,
    resolutionRound: 10,
    status: 12,
  };
  for (const [key, value] of Object.entries(overrides)) fields[indexes[key]] = value;
  return fields;
}

function campaignWith(overrides = {}) {
  const fields = [
    brand,
    termsHash,
    500_000_000n,
    125_500_000n,
    0n,
    0n,
    1_799_000_000n,
    1_799_500_000n,
    1_800_500_000n,
    retentionSeconds,
  ];
  const indexes = { brand: 0, termsHash: 1, retentionSeconds: 9 };
  for (const [key, value] of Object.entries(overrides)) fields[indexes[key]] = value;
  return fields;
}

function mockClient({
  chainId = 84_532,
  receiverEscrow = escrow,
  assignmentValue = assignmentWith(),
  campaignValue = campaignWith(),
} = {}) {
  return {
    getChainId: async () => chainId,
    readContract: async ({ functionName }) => {
      if (functionName === 'escrow') return receiverEscrow;
      if (functionName === 'assignments') return assignmentValue;
      if (functionName === 'campaigns') return campaignValue;
      throw new Error(`Unexpected read ${functionName}`);
    },
  };
}

test('Base binding derives the exact resolver arguments from persisted data and live escrow state', async () => {
  const binding = await readBaseCampaignBinding({
    publicClient: mockClient(),
    receiver,
    requestId,
    expected: expectedBinding(),
  });
  assert.deepEqual(binding, {
    requestId,
    expectedHandle: 'creator_name',
    postId: '2109876543210987654',
    requiredPhrasesJson: '["InfluencedX","creator escrow"]',
    forbiddenPhrasesJson: '["guaranteed profit"]',
    requireAdDisclosure: true,
    semanticBrief: 'Explain the product accurately.',
    resolveNotBeforeEpoch: submittedAt + retentionSeconds,
    assignmentId,
    agreementHash,
    submissionHash,
  });
  assert.equal(assertVerifiedBaseCampaignBinding(binding), binding);
  assert.throws(
    () => assertVerifiedBaseCampaignBinding({ ...binding }),
    /not verified against live Base state/,
  );
});

test('request ID derivation matches Solidity abi.encode order and types', () => {
  const manual = keccak256(encodeAbiParameters(
    parseAbiParameters(
      'uint256 chainId, address escrow, uint256 assignmentId, uint32 resolutionRound, bytes32 agreementHash, bytes32 submissionHash',
    ),
    [84_532n, escrow, assignmentId, Number(round), agreementHash, submissionHash],
  ));
  assert.equal(requestId, manual);
});

test('Base binding rejects a wrong chain or receiver-to-escrow wiring', async () => {
  await assert.rejects(readBaseCampaignBinding({
    publicClient: mockClient({ chainId: 8453 }),
    receiver,
    requestId,
    expected: expectedBinding(),
  }), /RPC chain/);
  await assert.rejects(readBaseCampaignBinding({
    publicClient: mockClient({ receiverEscrow: getAddress(`0x${'ab'.repeat(20)}`) }),
    receiver,
    requestId,
    expected: expectedBinding(),
  }), /different escrow/);
  await assert.rejects(readBaseCampaignBinding({
    publicClient: mockClient(),
    receiver: getAddress(`0x${'ac'.repeat(20)}`),
    requestId,
    expected: expectedBinding(),
  }), /does not match the attestation receiver/);
});

test('Base assignment binding rejects every mutable resolution commitment or lifecycle mismatch', async () => {
  const cases = [
    [{ campaignId: 18n }, /different campaign/],
    [{ creator: getAddress(`0x${'aa'.repeat(20)}`) }, /different creator/],
    [{ agreementHash: `0x${'ab'.repeat(32)}` }, /agreement hash/],
    [{ submittedAt: 0n }, /no submission timestamp/],
    [{ submissionHash: `0x${'ac'.repeat(32)}` }, /submission hash/],
    [{ requestId: `0x${'ad'.repeat(32)}` }, /different resolution request ID/],
    [{ resolutionRound: 0n }, /resolution round/],
    [{ resolutionRound: 3n }, /escrow formula/],
    [{ status: 3n }, /not awaiting resolution/],
  ];
  for (const [mutation, pattern] of cases) {
    await assert.rejects(readBaseCampaignBinding({
      publicClient: mockClient({ assignmentValue: assignmentWith(mutation) }),
      receiver,
      requestId,
      expected: expectedBinding(),
    }), pattern);
  }
});

test('Base campaign binding rejects brand, terms, and retention mismatches', async () => {
  const cases = [
    [{ brand: getAddress(`0x${'ba'.repeat(20)}`) }, /different brand/],
    [{ termsHash: `0x${'bb'.repeat(32)}` }, /terms hash/],
    [{ retentionSeconds: 0n }, /retention period/],
  ];
  for (const [mutation, pattern] of cases) {
    await assert.rejects(readBaseCampaignBinding({
      publicClient: mockClient({ campaignValue: campaignWith(mutation) }),
      receiver,
      requestId,
      expected: expectedBinding(),
    }), pattern);
  }
});

test('persisted campaign arguments must already use resolver-canonical forms', () => {
  assert.throws(
    () => normalizeCampaignBinding(expectedBinding({ expectedHandle: '@Creator_Name' })),
    /canonical lowercase/,
  );
  assert.throws(
    () => normalizeCampaignBinding(expectedBinding({ requiredPhrasesJson: '[ "InfluencedX" ]' })),
    /not canonical/,
  );
  assert.throws(
    () => normalizeCampaignBinding(expectedBinding({ semanticBrief: ' trailing ' })),
    /not canonical/,
  );
});
