import type { Metadata } from "next";
import { LegalDocument } from "../legal/LegalDocument";

export const metadata: Metadata = {
  title: "Privacy notice · InfluencedX",
  description: "How the InfluencedX testnet application handles wallet sessions, public X evidence, marketplace records, and blockchain commitments.",
};

export default function PrivacyPage() {
  return (
    <LegalDocument
      eyebrow="PUBLIC NOTICE / TESTNET DATA"
      title="PRIVACY NOTICE"
      summary={(
        <>
          <strong>InfluencedX is an experimental testnet application.</strong>
          <p>
            It uses a wallet-bound session, reads public X evidence, stores application records in Neon Postgres,
            and writes commitments to public test networks. Never provide a seed phrase, private key, or confidential content.
          </p>
        </>
      )}
    >
      <section id="scope">
        <span>01 / SCOPE</span>
        <h2>WHAT THIS NOTICE COVERS</h2>
        <p>
          This notice describes the InfluencedX web application as it exists on August 11, 2026. The current build is
          hosted on Vercel and operates only with Base Sepolia, GenLayer Bradbury, and test USDC. It is not a mainnet
          service and should not be used for real-value transactions or sensitive personal information.
        </p>
      </section>

      <section id="data">
        <span>02 / DATA PROCESSED</span>
        <h2>WALLET, X, AND MARKETPLACE RECORDS</h2>
        <h3>Wallet sessions</h3>
        <p>
          The application processes an EVM wallet address, signed authentication messages, session issue and expiry
          times, and a pseudonymous session subject. The authenticated session is stored in a signed, HttpOnly,
          SameSite=Strict cookie. The application does not need or ask for a wallet seed phrase or private key.
        </p>
        <h3>Public X evidence</h3>
        <p>
          Ownership and campaign flows may process a public X handle, account profile information, public post URL and
          identifier, public post text, timestamps, follower and engagement counts, and availability signals such as a
          deleted, protected, suspended, edited, or renamed account. InfluencedX does not use X OAuth and cannot post
          from an X account on a creator&apos;s behalf.
        </p>
        <p>
          Raw X responses used to calculate marketplace metrics are not persisted in the metrics tables. Ownership
          material needed for the fixed verification relay is sealed server-side at rest and is subject to the purge
          process described below.
        </p>
        <h3>Marketplace records</h3>
        <p>
          Neon Postgres stores campaign briefs and criteria, budgets denominated in test-USDC units, applications,
          creator pitches and requested rates, selections, acceptances, public-post submissions, resolution state,
          receipt hashes, and public creator profile commitments. Application details are returned only to the owning
          brand and the applying creator by the current API authorization rules.
        </p>
        <h3>Security and request records</h3>
        <p>
          The service may process request timestamps, status and error codes, transaction identifiers, and network
          request information needed for hosting, security, reconciliation, and abuse prevention. Rate-limit records
          use keyed digests rather than storing raw client IP addresses, wallet addresses, session subjects, or request
          identifiers in the rate-limit bucket table.
        </p>
      </section>

      <section id="use">
        <span>03 / USE</span>
        <h2>WHY THE DATA IS USED</h2>
        <ul>
          <li>Authenticate the wallet that creates, applies to, or acts on a campaign.</li>
          <li>Verify that a creator controls the public X account they claim.</li>
          <li>Operate the marketplace lifecycle and reconcile it with confirmed Base Sepolia receipts.</li>
          <li>Ask GenLayer validators to evaluate the committed public evidence and campaign criteria.</li>
          <li>Produce sanitized creator metrics, estimated pay ranges, and risk signals when evidence is current.</li>
          <li>Prevent abuse, diagnose failures, enforce rate limits, and avoid duplicate broadcasts.</li>
        </ul>
      </section>

      <section id="services">
        <span>04 / PROCESSORS + PUBLIC NETWORKS</span>
        <h2>WHERE RECORDS GO</h2>
        <div className="legal-grid">
          <div><strong>VERCEL</strong><p>Hosts the Next.js application and server-side testnet services. Hosting and security systems may process request metadata.</p></div>
          <div><strong>NEON POSTGRES</strong><p>Stores verification state, marketplace records, sealed relay material, sanitized metrics, and reconciliation status.</p></div>
          <div><strong>BASE SEPOLIA</strong><p>Publicly records wallet addresses, commitments, test-USDC amounts, campaign events, and transaction outcomes.</p></div>
          <div><strong>GENLAYER BRADBURY</strong><p>Validators retrieve and interpret committed public X evidence. Requests, results, and related transaction data may be publicly observable.</p></div>
        </div>
        <p>
          X, wallet software, RPC providers, block explorers, Base, GenLayer, Vercel, and Neon operate under their own
          terms and data practices. Deleting an InfluencedX database record does not delete data those services already
          received or independently hold.
        </p>
      </section>

      <section id="public-records">
        <span>05 / RETENTION + DELETION</span>
        <h2>DELETABLE DATA IS NOT THE SAME AS BLOCKCHAIN DATA</h2>
        <p>
          X-derived database records are designed for expiry and deletion. The purge path removes expired challenges
          and metric evidence and removes stored X identifiers, handles, and post URLs when they are no longer needed,
          while retaining the minimum commitments required to reconcile immutable chain state. A signed wallet session
          can be ended with the in-app sign-out control and otherwise expires automatically.
        </p>
        <div className="legal-warning">
          <strong>PUBLIC RECORD WARNING</strong>
          <p>
            Base Sepolia and GenLayer Bradbury are public, append-only test networks. Wallet addresses, hashes,
            transaction data, and outcomes written there cannot be erased by InfluencedX. Public X posts may also remain
            available through X or third-party archives after an offchain InfluencedX copy is removed.
          </p>
        </div>
        <p>
          Campaign and application records may remain in Neon while they are needed for the testnet workflow,
          reconciliation, fraud prevention, or database recovery. The current UI does not provide a general self-service
          database deletion request. Do not place secrets, confidential information, or unnecessary personal information
          in a campaign brief, pitch, or public post.
        </p>
      </section>

      <section id="choices">
        <span>06 / YOUR CONTROLS</span>
        <h2>AVAILABLE CHOICES</h2>
        <ul>
          <li>Use the sign-out or switch-wallet control to clear the InfluencedX wallet-session cookie.</li>
          <li>Reject a wallet signature or transaction before it is broadcast.</li>
          <li>Manage or delete the original X post through X, understanding that this can make verification or resolution unavailable.</li>
          <li>Use a fresh test wallet and avoid submitting sensitive content during this testnet phase.</li>
        </ul>
      </section>

      <section id="security">
        <span>07 / SECURITY + CHANGES</span>
        <h2>NO SYSTEM IS RISK-FREE</h2>
        <p>
          InfluencedX uses wallet signatures, same-origin session controls, server-only secrets, sealed ownership
          evidence, receipt verification, and bounded rate limits. These controls reduce risk but cannot guarantee
          security, availability, or recovery. This notice may change as the testnet build changes; the date at the top
          identifies the version currently shown.
        </p>
        <p>
          This testnet build does not publish an operator identity or privacy-contact channel. Those details, a reviewed
          retention schedule, and a user-request process must be added before any real-value or public production launch.
        </p>
      </section>
    </LegalDocument>
  );
}
