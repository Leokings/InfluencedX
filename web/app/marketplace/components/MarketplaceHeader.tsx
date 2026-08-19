"use client";

import Link from "next/link";
import { useState } from "react";
import {
  STUDIONET_FUNDING_GUIDE_URL,
  STUDIONET_MARKETPLACE_ADDRESS,
  STUDIONET_MARKETPLACE_DEPLOYMENT_TX,
  studioNetExplorerLink,
} from "../marketplace-types";

export function MarketplaceHeader({ active = "campaigns" }: { active?: "campaigns" | "create" | "dashboard" | "verify" | null }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="site-header marketplace-header">
      <Link className="brand brand-wordmark-only" href="/" aria-label="InfluencedX home">
        <span className="brand-name">INFLUENCEDX</span>
      </Link>

      <button
        className="menu-toggle"
        type="button"
        aria-label="Toggle navigation"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((current) => !current)}
      >
        {menuOpen ? "CLOSE" : "MENU"}
      </button>

      <nav className={menuOpen ? "main-nav is-open" : "main-nav"} aria-label="Primary navigation">
        <Link aria-current={active === "campaigns" ? "page" : undefined} href="/#campaigns">CAMPAIGNS</Link>
        <Link aria-current={active === "create" ? "page" : undefined} href="/marketplace/create">CREATE</Link>
        <Link aria-current={active === "dashboard" ? "page" : undefined} href="/marketplace/dashboard">DASHBOARD</Link>
        <Link aria-current={active === "verify" ? "page" : undefined} href="/verify">VERIFY IDENTITY</Link>
        <Link href="/#proof">HOW IT WORKS</Link>
      </nav>

      <div className="header-actions">
        <span className="network-label"><i /> GENLAYER STUDIONET</span>
        <Link className="button button-small" href="/marketplace/create">CREATE CAMPAIGN →</Link>
      </div>
    </header>
  );
}

export function MarketplaceFooter() {
  const contractUrl = studioNetExplorerLink("address", STUDIONET_MARKETPLACE_ADDRESS)!;
  const deploymentUrl = studioNetExplorerLink("tx", STUDIONET_MARKETPLACE_DEPLOYMENT_TX)!;
  return (
    <footer>
      <div className="footer-brand">
        <strong>INFLUENCEDX</strong>
      </div>
      <div><span>MARKET</span><Link href="/#campaigns">Campaigns</Link><Link href="/marketplace/create">Create campaign</Link><Link href="/marketplace/dashboard">Dashboard</Link></div>
      <div><span>PROTOCOL</span><Link href="/#proof">How it works</Link><Link href="/verify">Verification</Link></div>
      <div className="footer-networks"><span>NETWORK</span><a href={contractUrl} target="_blank" rel="noreferrer">StudioNet V2 contract</a><a href={deploymentUrl} target="_blank" rel="noreferrer">Verified deployment</a><a href={STUDIONET_FUNDING_GUIDE_URL} target="_blank" rel="noreferrer">Get test GEN · official guide</a></div>
      <div><span>LEGAL</span><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></div>
      <p className="footer-note">INFLUENCEDX PREVIEW · GENLAYER STUDIONET · NATIVE TEST GEN ONLY</p>
    </footer>
  );
}
