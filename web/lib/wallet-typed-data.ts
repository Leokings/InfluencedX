import { getTypesForEIP712Domain, type TypedDataDomain } from "viem";

type TypedDataField = Readonly<{ name: string; type: string }>;

export const XPROOF_EIP712_DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export function typedDataForWalletRpc<
  T extends {
    domain: TypedDataDomain;
    types: Record<string, readonly TypedDataField[]>;
  },
>(typedData: T): T & {
  types: T["types"] & { EIP712Domain: typeof XPROOF_EIP712_DOMAIN_TYPES };
} {
  const derivedDomainTypes = getTypesForEIP712Domain({ domain: typedData.domain });
  if (JSON.stringify(derivedDomainTypes) !== JSON.stringify(XPROOF_EIP712_DOMAIN_TYPES)) {
    throw new Error("The XProof ownership domain is invalid.");
  }
  return {
    ...typedData,
    types: {
      ...typedData.types,
      // eth_signTypedData_v4 requires this explicit schema. Keep it derived
      // from the saved domain so the wallet and server hash the same payload.
      EIP712Domain: XPROOF_EIP712_DOMAIN_TYPES,
    },
  };
}
