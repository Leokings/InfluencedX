import type { Metadata } from "next";
import { applicationOriginForMetadata } from "@/lib/verification-config";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const metadataBase = new URL(applicationOriginForMetadata());

  return {
    metadataBase,
    title: "InfluencedX",
    description: "An X creator marketplace with campaign payments on Base and public-work resolution on GenLayer.",
    applicationName: "InfluencedX",
    keywords: ["creator marketplace", "X creators", "Base", "GenLayer", "USDC"],
    openGraph: {
      title: "InfluencedX",
      description: "Brands post. Creators apply. Public work gets verified. Payments settle on Base.",
      type: "website",
      images: [{ url: "/og.png", width: 1734, height: 907, alt: "InfluencedX" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "InfluencedX",
      description: "Brands post. Creators apply. Public work gets verified. Payments settle on Base.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
