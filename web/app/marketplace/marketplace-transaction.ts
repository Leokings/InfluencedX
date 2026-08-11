import type { MarketplaceTransactionDto } from "../../lib/marketplace-types.ts";

export async function broadcastMarketplaceTransaction(
  transaction: MarketplaceTransactionDto,
  actor: string,
  options: Readonly<{
    onSubmitted?: (hash: `0x${string}`) => void;
  }> = {},
): Promise<`0x${string}`> {
  if (transaction.chainId !== 84_532) throw new Error("The prepared transaction is not for Base Sepolia.");
  if (!/^0x[\da-f]{40}$/i.test(transaction.to)) throw new Error("The prepared transaction target is invalid.");
  if (!/^0x(?:[\da-f]{2})+$/i.test(transaction.data)) throw new Error("The prepared transaction data is invalid.");
  if (transaction.value !== "0") throw new Error("Marketplace transactions must not request native currency.");
  if (!/^0x[\da-f]{40}$/i.test(actor)) throw new Error("The transaction actor is invalid.");
  const provider = window.ethereum;
  if (!provider) throw new Error("No browser wallet is available.");

  const [{ createPublicClient, createWalletClient, custom, getAddress }, { baseSepolia }] = await Promise.all([
    import("viem"),
    import("viem/chains"),
  ]);
  const account = getAddress(actor);
  const to = getAddress(transaction.to);
  const data = transaction.data as `0x${string}`;
  const transport = custom(provider);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ chain: baseSepolia, transport });

  const [providerAccounts, providerChainId] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  const selected = Array.isArray(providerAccounts) && typeof providerAccounts[0] === "string"
    ? getAddress(providerAccounts[0])
    : null;
  if (selected !== account) {
    throw new Error("The active wallet account no longer matches the authenticated marketplace session.");
  }
  if (typeof providerChainId !== "string" || providerChainId.toLowerCase() !== "0x14a34") {
    throw new Error("Switch the active wallet to Base Sepolia before broadcasting.");
  }
  await publicClient.call({ account, to, data, value: 0n });
  const hash = await walletClient.sendTransaction({ account, chain: baseSepolia, to, data, value: 0n });
  options.onSubmitted?.(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The Base Sepolia transaction failed.");
  const confirmed = await publicClient.getTransaction({ hash });
  if (
    getAddress(confirmed.from) !== account ||
    !confirmed.to ||
    getAddress(confirmed.to) !== to ||
    confirmed.input.toLowerCase() !== data.toLowerCase() ||
    confirmed.value !== 0n ||
    confirmed.blockHash !== receipt.blockHash
  ) {
    throw new Error("The confirmed Base Sepolia transaction does not match the simulated wallet action.");
  }
  return hash;
}
