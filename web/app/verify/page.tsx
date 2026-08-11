import type { Metadata } from "next";

import VerifyFlow from "./VerifyFlow";

export const metadata: Metadata = {
  title: "Verify your X account | InfluencedX",
  description:
    "Bind a public X creator account to a Base Sepolia wallet with a one-time proof resolved by GenLayer.",
};

export default function VerifyPage() {
  return <VerifyFlow />;
}
