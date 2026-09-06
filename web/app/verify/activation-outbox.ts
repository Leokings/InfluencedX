import type { MarketplaceTransactionDto } from "../marketplace/marketplace-types.ts";
import { isExplicitEip1193UserRejection } from "../marketplace/marketplace-transaction.ts";
import type { BoundIdentityBundleRecovery } from "./verification-recovery.ts";

const PREFIX = "influencedx:activation-outbox:v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ActivationPreparation = {
  preparedId: string;
  transaction: MarketplaceTransactionDto;
  submissionToken: string;
};
export type ActivationAttempt = {
  version: 1;
  wallet: string;
  requestId: string;
  preparedId: string;
  phase: "ready" | "wallet" | "submitted";
  submissionToken: string;
  txHash: string | null;
  receiptRecorded?: boolean;
};
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type LockLike = Pick<LockManager, "request">;

export function activationOutboxKey(wallet: string, requestId: string): string {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet) || !UUID.test(requestId)) throw new Error("Invalid verification recovery binding.");
  return `${PREFIX}${wallet.toLowerCase()}:${requestId}`;
}

export function readActivationAttempt(wallet: string, requestId: string, storage: StorageLike = window.localStorage): ActivationAttempt | null {
  const raw = storage.getItem(activationOutboxKey(wallet, requestId));
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Saved verification recovery is invalid. Do not resend."); }
  const row = value as Partial<ActivationAttempt> | null;
  if (!row || row.version !== 1 || row.wallet !== wallet.toLowerCase() || row.requestId !== requestId
    || typeof row.preparedId !== "string" || !UUID.test(row.preparedId)
    || !["ready", "wallet", "submitted"].includes(row.phase ?? "")
    || typeof row.submissionToken !== "string" || row.submissionToken.length === 0 || row.submissionToken.length > 2_048
    || (row.receiptRecorded !== undefined && typeof row.receiptRecorded !== "boolean")
    || (row.phase === "submitted" ? typeof row.txHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(row.txHash) : row.txHash !== null)) {
    throw new Error("Saved verification recovery is invalid. Do not resend.");
  }
  return row as ActivationAttempt;
}

export function activationAttemptRecovery(attempt: ActivationAttempt | null): BoundIdentityBundleRecovery | null {
  return attempt?.phase === "submitted" && attempt.txHash
    ? { requestId: attempt.requestId, preparedId: attempt.preparedId, txHash: attempt.txHash }
    : null;
}

export function clearActivationAttempt(wallet: string, requestId: string, preparedId: string, storage: StorageLike = window.localStorage): void {
  const current = readActivationAttempt(wallet, requestId, storage);
  if (current?.preparedId === preparedId) storage.removeItem(activationOutboxKey(wallet, requestId));
}

/** This coordinator outlives a signed-in React screen. READY is persisted
 * before any session fence; WALLET is persisted before calling the provider.
 * A WALLET entry without a hash is never assumed to be safe to resend. */
export async function runDurableActivation(input: {
  wallet: string;
  requestId: string;
  isCurrent(): boolean;
  prepare(): Promise<ActivationPreparation>;
  resume(preparedId: string): Promise<ActivationPreparation | { recovery: BoundIdentityBundleRecovery }>;
  broadcast(prepared: ActivationPreparation, callbacks: {
    beforeWalletRequest(): void;
    onSubmitted(hash: string): Promise<void>;
  }): Promise<string>;
  record(attempt: ActivationAttempt): Promise<void>;
  onSubmitted?(recovery: BoundIdentityBundleRecovery): void;
  storage?: StorageLike;
  locks?: LockLike;
}): Promise<BoundIdentityBundleRecovery | null> {
  const storage = input.storage ?? window.localStorage;
  const locks = input.locks ?? navigator.locks;
  const key = activationOutboxKey(input.wallet, input.requestId);
  if (!locks) throw new Error("Use an up-to-date wallet browser to safely resume verification.");
  return locks.request(key, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("Verification is already running in another tab. Its transaction will remain recoverable.");
    if (!input.isCurrent()) return null;
    let attempt = readActivationAttempt(input.wallet, input.requestId, storage);
    const recovery = activationAttemptRecovery(attempt);
    if (recovery) return recovery;
    if (attempt?.phase === "wallet") throw new Error("A wallet transaction may still be pending. Recover its transaction hash below; do not resend it.");
    // Check durable storage before asking the server to reserve a new intent.
    const probe = `${key}:probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    const prepared = attempt ? await input.resume(attempt.preparedId) : await input.prepare();
    if ("recovery" in prepared) return prepared.recovery;
    if (attempt && attempt.preparedId !== prepared.preparedId) throw new Error("The saved verification intent changed.");
    attempt = { version: 1, wallet: input.wallet.toLowerCase(), requestId: input.requestId, preparedId: prepared.preparedId, submissionToken: prepared.submissionToken, phase: "ready", txHash: null };
    storage.setItem(key, JSON.stringify(attempt));
    if (!input.isCurrent()) return null;
    try {
      await input.broadcast(prepared, {
        beforeWalletRequest() {
          if (!input.isCurrent()) throw new Error("Wallet disconnected. Your prepared verification is saved.");
          attempt = { ...attempt!, phase: "wallet" };
          storage.setItem(key, JSON.stringify(attempt));
        },
        async onSubmitted(hash) {
          if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error("Invalid submitted transaction hash.");
          attempt = { ...attempt!, phase: "submitted", txHash: hash.toLowerCase() };
          // Still submit the server receipt if browser storage becomes full.
          try { storage.setItem(key, JSON.stringify(attempt)); }
          finally {
            try { input.onSubmitted?.(activationAttemptRecovery(attempt)!); } catch { /* A stale UI cannot block receipt delivery. */ }
            await input.record(attempt);
          }
        },
      });
    } catch (error) {
      if (isExplicitEip1193UserRejection(error) && attempt.phase === "wallet" && attempt.txHash === null) {
        storage.setItem(key, JSON.stringify({ ...attempt, phase: "ready" }));
      }
      throw error;
    }
    return activationAttemptRecovery(attempt);
  });
}

export async function submitActivationReceipt(attempt: ActivationAttempt, options: {
  fetcher?: typeof fetch;
  storage?: StorageLike;
} = {}): Promise<void> {
  if (attempt.phase !== "submitted" || !attempt.txHash) return;
  const response = await (options.fetcher ?? fetch)("/api/verification/activation/submitted", {
    method: "POST", credentials: "omit", cache: "no-store", keepalive: true,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ preparedId: attempt.preparedId, txHash: attempt.txHash, submissionToken: attempt.submissionToken }),
  });
  const acknowledgement = await response.json().catch(() => null);
  if (!response.ok || acknowledgement?.accepted !== true
    || acknowledgement.preparedId !== attempt.preparedId || acknowledgement.txHash !== attempt.txHash) {
    throw new Error("Transaction sent. Its receipt is saved; reconnect to finish recovery.");
  }
  try {
    const storage = options.storage ?? window.localStorage;
    const current = readActivationAttempt(attempt.wallet, attempt.requestId, storage);
    if (current?.preparedId === attempt.preparedId && current.txHash === attempt.txHash) {
      storage.setItem(activationOutboxKey(attempt.wallet, attempt.requestId), JSON.stringify({ ...current, receiptRecorded: true }));
    }
  } catch { /* The server owns the receipt even if local storage is unavailable. */ }
}

/** Replays only narrow receipt capabilities, never wallet authentication or a
 * blockchain broadcast. Can run while the user is signed out. */
export async function flushActivationReceipts(storage: Storage = window.localStorage): Promise<void> {
  const attempts: ActivationAttempt[] = [];
  for (let index = 0; index < storage.length && attempts.length < 20; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(PREFIX) || key.endsWith(":probe")) continue;
    const [wallet, requestId] = key.slice(PREFIX.length).split(":");
    try {
      const attempt = readActivationAttempt(wallet, requestId, storage);
      if (attempt?.phase === "submitted" && !attempt.receiptRecorded) attempts.push(attempt);
    } catch { /* Invalid entries are never broadcast or deleted. */ }
  }
  await Promise.allSettled(attempts.map((attempt) => submitActivationReceipt(attempt, { storage })));
}
