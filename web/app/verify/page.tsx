import type { Metadata } from "next";

import VerifyFlow from "./VerifyFlow";

export const metadata: Metadata = {
  title: "Verify X + Farcaster | InfluencedX",
  description: "Verify X + Farcaster in one transaction.",
};

export default function VerifyPage() {
  return <VerifyFlow />;
}
