import assert from "node:assert/strict";
import test from "node:test";

import { campaignTermsHash } from "../lib/marketplace-commitments.ts";
import {
  DEFAULT_CAMPAIGN_RETENTION_SECONDS,
  MAXIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS,
  MINIMUM_CALLER_CAMPAIGN_RETENTION_SECONDS,
  MINIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS,
  PREVIEW_CAMPAIGN_RETENTION_ENV,
  configuredCampaignRetentionDefault,
  resolveCampaignRetentionSeconds,
} from "../lib/marketplace-retention.ts";

function previewEnvironment(
  retention = "300",
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_TARGET_ENV: "preview",
    [PREVIEW_CAMPAIGN_RETENTION_ENV]: retention,
  };
}

function localEnvironment(): NodeJS.ProcessEnv {
  return { NODE_ENV: "test" };
}

test("campaign retention defaults to 30 days without an explicit server override", () => {
  for (const environment of [
    localEnvironment(),
    { NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview" },
    { NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production" },
  ] satisfies NodeJS.ProcessEnv[]) {
    assert.equal(
      resolveCampaignRetentionSeconds(undefined, environment),
      DEFAULT_CAMPAIGN_RETENTION_SECONDS,
    );
  }
});

test("short campaign retention is an exact Vercel Preview server default", () => {
  assert.equal(
    configuredCampaignRetentionDefault(previewEnvironment()),
    300,
  );
  assert.equal(
    resolveCampaignRetentionSeconds(undefined, previewEnvironment("60")),
    MINIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS,
  );
  assert.equal(
    resolveCampaignRetentionSeconds(
      undefined,
      previewEnvironment(String(MAXIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS)),
    ),
    MAXIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS,
  );
  assert.equal(
    resolveCampaignRetentionSeconds(undefined, {
      ...previewEnvironment(),
      VERCEL_TARGET_ENV: undefined,
    }),
    300,
    "VERCEL_TARGET_ENV is optional, but must agree when Vercel supplies it",
  );
});

test("a Preview retention override fails closed outside Vercel Preview", () => {
  const invalidEnvironments: NodeJS.ProcessEnv[] = [
    {
      ...localEnvironment(),
      [PREVIEW_CAMPAIGN_RETENTION_ENV]: "300",
    },
    { ...previewEnvironment(), VERCEL: undefined },
    { ...previewEnvironment(), VERCEL_ENV: "production" },
    { ...previewEnvironment(), VERCEL_ENV: "development" },
    { ...previewEnvironment(), VERCEL_TARGET_ENV: "production" },
  ];
  for (const environment of invalidEnvironments) {
    assert.throws(
      () => resolveCampaignRetentionSeconds(undefined, environment),
      /allowed only on a Vercel Preview deployment/,
    );
  }
});

test("a malformed or out-of-policy Preview default fails closed", () => {
  for (const value of [
    "",
    "0",
    "01",
    " 300",
    "300 ",
    "300.5",
    "-300",
    String(MINIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS - 1),
    String(MAXIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS + 1),
  ]) {
    assert.throws(
      () => configuredCampaignRetentionDefault(previewEnvironment(value)),
      /Invalid campaign retention configuration/,
      value,
    );
  }
});

test("caller input can never opt into the short Preview retention policy", () => {
  assert.throws(
    () => resolveCampaignRetentionSeconds(300, previewEnvironment()),
    /between one day and one year/,
  );
  assert.throws(
    () => resolveCampaignRetentionSeconds("300", localEnvironment()),
    /between one day and one year/,
  );
  assert.equal(
    resolveCampaignRetentionSeconds(
      String(MINIMUM_CALLER_CAMPAIGN_RETENTION_SECONDS),
      previewEnvironment(),
    ),
    MINIMUM_CALLER_CAMPAIGN_RETENTION_SECONDS,
  );
});

test("the effective Preview retention is committed into the campaign terms hash", () => {
  const normalRetention = resolveCampaignRetentionSeconds(
    undefined,
    localEnvironment(),
  );
  const previewRetention = resolveCampaignRetentionSeconds(
    undefined,
    previewEnvironment(),
  );
  const fixedTerms = {
    schemaVersion: 1,
    network: "base-sepolia",
    campaignRecordId: "campaign-1",
    title: "Demo campaign",
  };
  const normalTerms = {
    ...fixedTerms,
    retentionSeconds: String(normalRetention),
  };
  const previewTerms = {
    ...fixedTerms,
    retentionSeconds: String(previewRetention),
  };

  assert.equal(previewTerms.retentionSeconds, "300");
  assert.notEqual(campaignTermsHash(previewTerms), campaignTermsHash(normalTerms));
  assert.equal(campaignTermsHash(previewTerms), campaignTermsHash({
    ...fixedTerms,
    retentionSeconds: "300",
  }));
});
