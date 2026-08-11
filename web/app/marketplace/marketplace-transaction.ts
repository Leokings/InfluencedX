import type { MarketplaceTransactionDto } from "../../lib/marketplace-types.ts";

export async function broadcastMarketplaceTransaction(
  transaction: MarketplaceTransactionDto,
  actor: string,
): Promise<`0x${string}`> {
  if (transaction.chainId !== 84_532) throw new Error("The prepared transaction is not for Base Sepolia.");
  if (!/^0x[\da-f]{40}$/i.test(transaction.to)) throw new Error("The prepared transaction target is invalid.");
  if (!/^0x(?:[\da-f]{2})+$/i.test(transaction.data)) throw new Error("The prepared transaction data is invalid.");
  if (transaction.value !== "0") throw new Error("Marketplace transactions must not request native currency.");
  if (!/^0x[\da-f]{40}$/i.test(actor)) throw new Error("The transaction actor is invalid.");
  if (!window.ethereum) throw new Error("No browser wallet is available.");

  const [{ createPublicClient, createWalletClient, custom, getAddress }, { baseSepolia }] = await Promise.all([
    import("viem"),
    import("viem/chains"),
  ]);
  const account = getAddress(actor);
  const to = getAddress(transaction.to);
  const data = transaction.data as `0x${string}`;
  const transport = custom(window.ethereum);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ chain: baseSepolia, transport });

  await publicClient.call({ account, to, data, value: 0n });
  const hash = await walletClient.sendTransaction({ account, chain: baseSepolia, to, data, value: 0n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The Base Sepolia transaction failed.");
  return hash;
}
