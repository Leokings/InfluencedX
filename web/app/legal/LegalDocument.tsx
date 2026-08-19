import Link from "next/link";
import type { ReactNode } from "react";
import { MarketplaceFooter, MarketplaceHeader } from "../marketplace/components/MarketplaceHeader";

type LegalDocumentProps = {
  eyebrow: string;
  title: string;
  summary: ReactNode;
  children: ReactNode;
};

export function LegalDocument({ eyebrow, title, summary, children }: LegalDocumentProps) {
  return (
    <main className="legal-page">
      <MarketplaceHeader active={null} />

      <section className="legal-hero">
        <p className="eyebrow"><span /> {eyebrow}</p>
        <h1>{title}</h1>
        <div className="legal-meta">
          <span>LAST UPDATED</span>
          <time dateTime="2026-08-19">AUGUST 19, 2026</time>
        </div>
        <div className="legal-summary">{summary}</div>
      </section>

      <div className="legal-layout">
        <aside className="legal-index" aria-label="Legal pages">
          <span>DOCUMENTS</span>
          <Link href="/privacy">PRIVACY NOTICE</Link>
          <Link href="/terms">TESTNET TERMS</Link>
          <Link href="/">BACK TO MARKETPLACE</Link>
        </aside>
        <article className="legal-document">{children}</article>
      </div>

      <MarketplaceFooter />
    </main>
  );
}
