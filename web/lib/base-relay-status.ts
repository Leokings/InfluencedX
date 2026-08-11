export type BaseRelayStatus =
  | "NOT_STARTED"
  | "QUORUM_PENDING"
  | "BROADCASTING"
  | "CONFIRMED"
  | "FAILED"
  | "RECONCILIATION_REQUIRED";

export type BaseRelayBoardState = "complete" | "pending" | "future" | "error";

export function shouldPollVerificationStatus(input: {
  submissionStatus: string;
  genlayerOutcome: string | null;
  baseRelayStatus: BaseRelayStatus;
}): boolean {
  if (input.submissionStatus === "NOT_SUBMITTED") return false;
  const genlayerTerminal = new Set([
    "FINALIZED",
    "EXECUTION_FAILED",
    "NETWORK_TERMINATED",
    "RECONCILIATION_REQUIRED",
    "POLLING_EXHAUSTED",
    "POISONED",
  ]);
  if (!genlayerTerminal.has(input.submissionStatus)) return true;
  const baseTerminal = new Set<BaseRelayStatus>([
    "CONFIRMED",
    "FAILED",
    "RECONCILIATION_REQUIRED",
  ]);
  return input.submissionStatus === "FINALIZED" &&
    input.genlayerOutcome === "VERIFIED" &&
    !baseTerminal.has(input.baseRelayStatus);
}

export function baseRelayPresentation(input: {
  status: BaseRelayStatus;
  genlayerVerified: boolean;
  profileId: string | null;
  profileActive: boolean | null;
  profileVerified: boolean | null;
  profileExpiresAt: string | null;
  nowMs?: number;
}): {
  currentProfile: boolean;
  needsReview: boolean;
  boardState: BaseRelayBoardState;
  detail: string;
} {
  const expiresAtMs = input.profileExpiresAt ? Date.parse(input.profileExpiresAt) : Number.NaN;
  const currentProfile = input.status === "CONFIRMED" &&
    input.profileActive === true &&
    input.profileVerified === true &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > (input.nowMs ?? Date.now());
  const needsReview = input.status === "FAILED" ||
    input.status === "RECONCILIATION_REQUIRED" ||
    (input.status === "CONFIRMED" && !currentProfile);

  let boardState: BaseRelayBoardState = "future";
  if (currentProfile) boardState = "complete";
  else if (needsReview) boardState = "error";
  else if (input.genlayerVerified || input.status === "BROADCASTING") boardState = "pending";

  let detail = "NOT STARTED";
  if (currentProfile) detail = `PROFILE #${input.profileId ?? "RECORDED"}`;
  else if (input.status === "BROADCASTING") detail = "TRANSACTION PENDING";
  else if (input.status === "FAILED") detail = "RELAY FAILED";
  else if (input.status === "RECONCILIATION_REQUIRED") detail = "REVIEW REQUIRED";
  else if (input.status === "CONFIRMED") detail = "PROFILE INACTIVE OR EXPIRED";
  else if (input.genlayerVerified) detail = "WATCHER QUORUM PENDING";

  return { currentProfile, needsReview, boardState, detail };
}
