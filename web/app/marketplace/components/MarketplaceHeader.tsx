"use client";

import Link from "next/link";
import { useState } from "react";

export function MarketplaceHeader({ active = "campaigns" }: { active?: "campaigns" | "create" | "verify" | null }) {
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
        <Link aria-current={active === "verify" ? "page" : undefined} href="/verify">VERIFY X</Link>
        <Link href="/#proof">HOW IT WORKS</Link>
      </nav>

      <div className="header-actions">
        <span className="network-label"><i /> BASE SEPOLIA</span>
        <Link className="button button-small" href="/marketplace/create">CREATE CAMPAIGN →</Link>
      </div>
    </header>
  );
}

export function MarketplaceFooter() {
  return (
    <footer>
      <div className="footer-brand">
        <strong>INFLUENCEDX</strong>
      </div>
      <div><span>MARKET</span><Link href="/#campaigns">Campaigns</Link><Link href="/marketplace/create">Create campaign</Link></div>
      <div><span>PROTOCOL</span><Link href="/#proof">How it works</Link><Link href="/verify">Verification</Link></div>
      <div className="footer-networks"><span>NETWORKS</span><a href="https://sepolia.basescan.org" target="_blank" rel="noreferrer">Base Sepolia</a><span>GenLayer Bradbury</span></div>
      <div><span>LEGAL</span><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></div>
      <p className="footer-note">INFLUENCEDX TESTNET · BASE SEPOLIA + GENLAYER BRADBURY · TEST USDC ONLY</p>
    </footer>
  );
}
