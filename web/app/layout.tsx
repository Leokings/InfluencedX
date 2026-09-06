import type { Metadata } from "next";
import { applicationOriginForMetadata } from "@/lib/verification-config";
import { MarketplaceWalletProvider } from "./marketplace/use-marketplace-wallet";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const metadataBase = new URL(applicationOriginForMetadata());

  return {
    metadataBase,
    title: "InfluencedX",
    description: "A GenLayer-native creator marketplace for X and Farcaster campaigns, public-work resolution, payouts, and refunds.",
    applicationName: "InfluencedX",
    keywords: ["creator marketplace", "X creators", "Farcaster creators", "GenLayer", "GEN"],
    openGraph: {
      title: "InfluencedX",
      description: "Brands post. Creators apply. Public work and native GEN settlement finalize on GenLayer.",
      type: "website",
      images: [{ url: "/og.png", width: 1734, height: 907, alt: "InfluencedX" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "InfluencedX",
      description: "Brands post. Creators apply. Public work and native GEN settlement finalize on GenLayer.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><MarketplaceWalletProvider>{children}</MarketplaceWalletProvider></body>
    </html>
  );
}
