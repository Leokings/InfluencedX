import type { Metadata } from "next";

import VerifyFlow from "./VerifyFlow";

export const metadata: Metadata = {
  title: "Verify your creator identity | InfluencedX",
  description:
    "Bind a public X or Farcaster creator identity to a StudioNet wallet with a one-time proof finalized on GenLayer.",
};

export default function VerifyPage() {
  return <VerifyFlow />;
}
