import type { Metadata } from "next";

import VerifyFlow from "./VerifyFlow";

export const metadata: Metadata = {
  title: "Verify X + Farcaster | InfluencedX",
  description: "Verify X and Farcaster together in one GenLayer transaction.",
};

export default function VerifyPage() {
  return <VerifyFlow />;
}
