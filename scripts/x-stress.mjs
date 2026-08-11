import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_HANDLES = [
  'XDevelopers',
  'BuildOnBase',
  'coinbase',
  'circle',
  'OpenAI',
  'genlayer',
  'ethereum',
  'VitalikButerin',
  'github',
  'vercel',
  'Cloudflare',
  'stripe',
  'LayerZero_Core',
  'Optimism',
  'arbitrum',
  'solana',
  '0xPolygon',
  'Uniswap',
  'AaveAave',
  'chainlink',
  'MetaMask',
  'Ledger',
  'a16zcrypto',
  'base',
  'jessepollak',
];

const EDGE_CASES = [
  {
    name: 'old_post',
    handle: 'XDevelopers',
    postId: '1346889436626259968',
    expected: 'available',
  },
  {
    name: 'renamed_account_old_handle',
    handle: 'TwitterDev',
    postId: '1346889436626259968',
    expected: 'renamed_or_available',
  },
  {
    name: 'deleted_or_nonexistent_post',
    handle: 'XDevelopers',
    postId: '1',
    expected: 'unavailable',
  },
  {
    name: 'nonexistent_profile',
    handle: 'adproof_missing_7f4c2a',
    expected: 'unavailable',
  },
  {
    name: 'protected_profile',
    handle: 'RepGeoffDiehl',
    expected: 'protected_or_public_state_change',
  },
  {
    name: 'protected_profile_candidate_two',
    handle: 'tooampm',
    expected: 'protected',
  },
  {
    name: 'protected_profile_candidate_three',
    handle: 'zoemjack',
    expected: 'protected',
  },
  {
    name: 'suspended_profile',
    handle: '____mks',
    expected: 'suspended_or_missing',
  },
  {
    name: 'official_docs_image_post',
    handle: 'FloodSocial',
    postId: '907974220298125312',
    expected: 'image',
  },
  {
    name: 'official_docs_video_post',
    handle: 'FloodSocial',
    postId: '869318041078820864',
    expected: 'video',
  },
  {
    name: 'edited_post_from_official_docs',
    mode: 'universal_post',
    postId: '1557445923210514432',
    expected: 'edited_or_removed',
  },
  {
    name: 'public_self_thread_chain',
    mode: 'thread_chain',
    handle: 'XDevelopers',
    postId: '2019881223666233717',
    replyPostId: '2019881225587167406',
    expected: 'thread',
  },
];

function integerArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] ?? '', 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function stringArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const passes = integerArg('passes', Number.parseInt(process.env.X_STRESS_PASSES ?? '2', 10));
const concurrency = integerArg(
  'concurrency',
  Number.parseInt(process.env.X_STRESS_CONCURRENCY ?? '6', 10),
);
const timeoutMs = integerArg('timeout-ms', 20_000);
const projectRoot = path.resolve(import.meta.dirname, '..');
const outputPath = path.resolve(
  projectRoot,
  stringArg('output', path.join('reports', 'x-stress-latest.json')),
);
let previousReport = null;
if (fs.existsSync(outputPath)) {
  try {
    previousReport = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch {
    previousReport = null;
  }
}

const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 AdProof-X-Stress/1.0';

let activeRequests = 0;
let maxActiveRequests = 0;

async function fetchPublic(url) {
  const startedAt = Date.now();
  activeRequests += 1;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.8',
        'user-agent': userAgent,
      },
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      elapsedMs: Date.now() - startedAt,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      elapsedMs: Date.now() - startedAt,
      body: '',
      error: error instanceof Error ? error.name : 'UnknownError',
    };
  } finally {
    activeRequests -= 1;
  }
}

function unique(values) {
  return [...new Set(values)];
}

function firstMatch(body, pattern, fallback = null) {
  const match = body.match(pattern);
  return match ? match[1] : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function classifyUnavailable(status, body) {
  const lower = body.toLowerCase();
  if (status === 429) return 'rate_limited';
  if (status === 0 || status >= 500) return 'transient_error';
  if (lower.includes('these posts are protected') || lower.includes('protected:!0')) return 'protected';
  if (lower.includes('account suspended') || lower.includes('this account doesn')) return 'suspended_or_missing';
  if (status === 401 || status === 403 || status === 404) return 'unavailable';
  return 'unresolved';
}

function parseProfile(handle, response) {
  const lower = response.body.toLowerCase();
  const marker = `screen_name:"${handle.toLowerCase()}"`;
  const markerIndex = lower.indexOf(marker);
  const available = response.status === 200 && markerIndex >= 0;
  const scope = available
    ? response.body.slice(Math.max(0, markerIndex - 4_000), markerIndex + 12_000)
    : response.body.slice(0, 60_000);
  const relationship = scope.match(/followers:([0-9]+),following:([0-9]+)/);
  const protectedValue = firstMatch(scope, /protected:!([01])/);
  const postIds = unique(
    [...response.body.matchAll(/entry_id:"tweet-([0-9]{5,25})"/g)].map((match) => match[1]),
  ).slice(0, 5);

  return {
    handle,
    available,
    availability: available ? 'public' : classifyUnavailable(response.status, response.body),
    httpStatus: response.status,
    elapsedMs: response.elapsedMs,
    finalHost: (() => {
      try {
        return new URL(response.finalUrl).host;
      } catch {
        return null;
      }
    })(),
    xUserId: firstMatch(scope, /rest_id:"([0-9]+)"/),
    accountCreatedAtMs: numberOrNull(firstMatch(scope, /created_at_ms:([0-9]+)/)),
    followers: numberOrNull(relationship?.[1]),
    following: numberOrNull(relationship?.[2]),
    totalPosts: numberOrNull(firstMatch(scope, /__typename:"UserTweetCounts",tweets:([0-9]+)/)),
    protected: protectedValue === null ? null : protectedValue === '0',
    recentPostIds: postIds,
    error: response.error ?? null,
  };
}

function parseOEmbed(response) {
  if (response.status !== 200) return { available: false, authorUrl: null, html: '' };
  try {
    const parsed = JSON.parse(response.body);
    return {
      available: typeof parsed === 'object' && parsed !== null,
      authorUrl: typeof parsed.author_url === 'string' ? parsed.author_url : null,
      html: typeof parsed.html === 'string' ? parsed.html : '',
    };
  } catch {
    return { available: false, authorUrl: null, html: '' };
  }
}

function parsePost(handle, postId, direct, oembedResponse) {
  const oembed = parseOEmbed(oembedResponse);
  const body = direct.body;
  const lower = body.toLowerCase();
  const authorUrl = oembed.authorUrl?.toLowerCase().replace(/\/$/, '') ?? '';
  const requestedAuthorMatch =
    authorUrl.endsWith(`/${handle.toLowerCase()}`)
    || lower.includes(`screen_name:"${handle.toLowerCase()}"`)
    || lower.includes(`content="@${handle.toLowerCase()}"`);
  const editGroups = [...body.matchAll(/edit_tweet_ids:\$R\[[0-9]+\]=\[([^\]]*)\]/g)]
    .map((match) => unique([...match[1].matchAll(/"([0-9]{5,25})"/g)].map((item) => item[1])));
  const targetEditGroup = editGroups.find((ids) => ids.includes(postId)) ?? [];
  const available =
    (direct.status === 200 && body.includes(postId))
    || (oembed.available && (oembed.html.includes(postId) || oembedResponse.body.includes(postId)));
  // Do not use generic pbs/video host strings or ConversationThread: X includes
  // those in application bootstrap data on every status page. These are tweet
  // payload markers, and the oEmbed success confirms the requested target exists.
  const hasImage = /type:"photo"/i.test(body);
  const hasVideo = /type:"video"|video_info:/i.test(body);
  const tweetIds = unique(
    [...body.matchAll(/rest_id:"([0-9]{15,25})"/g)].map((match) => match[1]),
  );
  const thread = /self_thread_metadata:/i.test(body) && tweetIds.length > 1;

  return {
    handle,
    postId,
    available,
    availability: available
      ? 'public'
      : classifyUnavailable(
        direct.status === 429 || oembedResponse.status === 429
          ? 429
          : Math.max(direct.status, oembedResponse.status),
        `${direct.body.slice(0, 40_000)} ${oembedResponse.body.slice(0, 10_000)}`,
      ),
    directStatus: direct.status,
    oembedStatus: oembedResponse.status,
    directElapsedMs: direct.elapsedMs,
    oembedElapsedMs: oembedResponse.elapsedMs,
    requestedAuthorMatch,
    canonicalAuthor: oembed.authorUrl ? oembed.authorUrl.split('/').filter(Boolean).at(-1) : null,
    media: available
      ? (hasVideo && hasImage ? 'mixed' : hasVideo ? 'video' : hasImage ? 'image' : 'text')
      : 'unavailable',
    mediaSignals: { imagePayload: hasImage, videoPayload: hasVideo },
    classificationSource: 'public_status_payload_markers',
    selfThreadSignal: thread,
    relatedPostIds: tweetIds.filter((id) => id !== postId).slice(0, 10),
    edited: targetEditGroup.length > 1,
    editVersionCount: targetEditGroup.length,
    error: direct.error ?? oembedResponse.error ?? null,
  };
}

async function inspectUniversalPost(postId) {
  const response = await fetchPublic(`https://x.com/i/web/status/${postId}`);
  const editGroups = [...response.body.matchAll(/edit_tweet_ids:\$R\[[0-9]+\]=\[([^\]]*)\]/g)]
    .map((match) => unique([...match[1].matchAll(/"([0-9]{5,25})"/g)].map((item) => item[1])));
  const targetGroup = editGroups.find((ids) => ids.includes(postId)) ?? [];
  return {
    postId,
    available: response.status === 200 && response.body.includes(postId),
    availability: response.status === 200
      ? 'public'
      : classifyUnavailable(response.status, response.body),
    httpStatus: response.status,
    elapsedMs: response.elapsedMs,
    edited: targetGroup.length > 1,
    editVersionCount: targetGroup.length,
    error: response.error ?? null,
  };
}

async function inspectThreadChain(testCase) {
  const [root, reply] = await Promise.all([
    inspectPost(testCase.handle, testCase.postId),
    inspectPost(testCase.handle, testCase.replyPostId),
  ]);
  const sameAuthor = Boolean(
    root.canonicalAuthor
    && reply.canonicalAuthor
    && root.canonicalAuthor.toLowerCase() === reply.canonicalAuthor.toLowerCase(),
  );
  return {
    handle: testCase.handle,
    rootPostId: testCase.postId,
    replyPostId: testCase.replyPostId,
    available: root.available && reply.available,
    availability: root.available && reply.available ? 'public' : 'unavailable',
    sameAuthor,
    rootReferencesReply: root.relatedPostIds.includes(testCase.replyPostId),
    threadVerified: root.available && reply.available && sameAuthor && root.relatedPostIds.includes(testCase.replyPostId),
    rootStatus: root.directStatus,
    replyStatus: reply.directStatus,
  };
}

async function inspectPost(handle, postId) {
  const [direct, oembed] = await Promise.all([
    fetchPublic(`https://x.com/${encodeURIComponent(handle)}/status/${postId}`),
    fetchPublic(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/${handle}/status/${postId}`)}&omit_script=true`,
    ),
  ]);
  return parsePost(handle, postId, direct, oembed);
}

async function mapConcurrent(items, limit, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function runPass(passNumber) {
  const startedAt = new Date().toISOString();
  const profiles = await mapConcurrent(DEFAULT_HANDLES, concurrency, async (handle) => {
    const response = await fetchPublic(`https://x.com/${encodeURIComponent(handle)}`);
    return parseProfile(handle, response);
  });
  const currentPostTargets = profiles
    .filter((profile) => profile.recentPostIds.length > 0)
    .map((profile) => ({ handle: profile.handle, postId: profile.recentPostIds[0] }));
  const currentPosts = await mapConcurrent(
    currentPostTargets,
    concurrency,
    (target) => inspectPost(target.handle, target.postId),
  );
  const edges = await mapConcurrent(EDGE_CASES, concurrency, async (testCase) => {
    if (testCase.mode === 'universal_post') {
      return { ...testCase, observation: await inspectUniversalPost(testCase.postId) };
    }
    if (testCase.mode === 'thread_chain') {
      return { ...testCase, observation: await inspectThreadChain(testCase) };
    }
    if (!testCase.postId) {
      const response = await fetchPublic(`https://x.com/${encodeURIComponent(testCase.handle)}`);
      return { ...testCase, observation: parseProfile(testCase.handle, response) };
    }
    return { ...testCase, observation: await inspectPost(testCase.handle, testCase.postId) };
  });
  return { passNumber, startedAt, completedAt: new Date().toISOString(), profiles, currentPosts, edges };
}

function summarize(allPasses) {
  const profiles = allPasses.flatMap((pass) => pass.profiles);
  const posts = allPasses.flatMap((pass) => pass.currentPosts);
  const edges = allPasses.flatMap((pass) => pass.edges.map((edge) => edge.observation));
  const statuses = [...profiles, ...posts, ...edges]
    .map((item) => item.httpStatus ?? item.directStatus ?? null)
    .filter((status) => status !== null);
  const profileStability = DEFAULT_HANDLES.map((handle) => {
    const observations = allPasses.map((pass) => pass.profiles.find((profile) => profile.handle === handle));
    return {
      handle,
      availabilityStable: new Set(observations.map((item) => item?.availability)).size === 1,
      identityStable: new Set(observations.map((item) => item?.xUserId)).size === 1,
      statuses: observations.map((item) => item?.httpStatus ?? 0),
    };
  });
  const classificationCounts = {};
  for (const post of posts) classificationCounts[post.media] = (classificationCounts[post.media] ?? 0) + 1;

  return {
    configuredAccounts: DEFAULT_HANDLES.length,
    passes: allPasses.length,
    profileRequests: profiles.length,
    postPairs: posts.length,
    edgeCases: edges.length,
    publicProfiles: profiles.filter((item) => item.availability === 'public').length,
    publicPosts: posts.filter((item) => item.availability === 'public').length,
    rateLimitedResponses: statuses.filter((status) => status === 429).length,
    transientResponses: statuses.filter((status) => status === 0 || status >= 500).length,
    protectedObservations: [...profiles, ...edges].filter((item) =>
      item.availability === 'protected' || item.protected === true,
    ).length,
    unavailableObservations: [...profiles, ...posts, ...edges].filter((item) =>
      ['unavailable', 'suspended_or_missing', 'unresolved'].includes(item.availability),
    ).length,
    postClassifications: classificationCounts,
    selfThreadSignalPages: posts.filter((item) => item.selfThreadSignal).length,
    editedObservations: posts.filter((item) => item.edited).length,
    maxSimultaneousHttpRequests: maxActiveRequests,
    stableProfiles: profileStability.filter((item) => item.availabilityStable && item.identityStable).length,
    profileStability,
  };
}

function compareWithPrevious(currentPasses, prior) {
  if (!prior?.passes?.length) return null;
  const previousProfiles = prior.passes.at(-1)?.profiles ?? [];
  const currentProfiles = currentPasses[0]?.profiles ?? [];
  const handles = DEFAULT_HANDLES.map((handle) => {
    const previous = previousProfiles.find((item) => item.handle === handle);
    const current = currentProfiles.find((item) => item.handle === handle);
    return {
      handle,
      availabilityChanged: previous?.availability !== current?.availability,
      identityChanged: previous?.xUserId !== current?.xUserId,
      previousStatus: previous?.httpStatus ?? null,
      currentStatus: current?.httpStatus ?? null,
    };
  });
  const previousDate = String(prior.generatedAt ?? '').slice(0, 10);
  const currentDate = new Date().toISOString().slice(0, 10);
  return {
    previousGeneratedAt: prior.generatedAt ?? null,
    spansDifferentUtcDates: Boolean(previousDate && previousDate !== currentDate),
    changedAvailabilityCount: handles.filter((item) => item.availabilityChanged).length,
    changedIdentityCount: handles.filter((item) => item.identityChanged).length,
    handles,
  };
}

const startedAt = new Date().toISOString();
const allPasses = [];
for (let passNumber = 1; passNumber <= passes; passNumber += 1) {
  allPasses.push(await runPass(passNumber));
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  startedAt,
  sourcePolicy: 'Public X HTML and public X oEmbed only; no OAuth, API token, cookie, or raw response retained.',
  limits: {
    accountCount: DEFAULT_HANDLES.length,
    passes,
    concurrency,
    timeoutMs,
    crossDayCoverage: 'Requires this same harness to run on multiple UTC dates.',
  },
  summary: summarize(allPasses),
  previousRunComparison: compareWithPrevious(allPasses, previousReport),
  passes: allPasses,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, summary: report.summary }, null, 2));
