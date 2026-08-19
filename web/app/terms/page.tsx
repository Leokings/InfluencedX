import Link from "next/link";
import type { Metadata } from "next";
import { LegalDocument } from "../legal/LegalDocument";

export const metadata: Metadata = {
  title: "Testnet terms · InfluencedX",
  description: "Terms for evaluating the InfluencedX creator marketplace on GenLayer StudioNet.",
};

export default function TermsPage() {
  return (
    <LegalDocument
      eyebrow="EVALUATION ONLY / NO REAL VALUE"
      title="TESTNET TERMS"
      summary={(
        <>
          <strong>Use InfluencedX only for testnet evaluation.</strong>
          <p>
            Native test GEN has no promised monetary value. InfluencedX does not custody wallet keys and does not guarantee
            selection, resolution, payment, refund, uptime, or recovery.
          </p>
        </>
      )}
    >
      <section id="scope">
        <span>01 / SCOPE</span>
        <h2>AN EXPERIMENTAL CREATOR MARKETPLACE</h2>
        <p>
          These terms apply to the InfluencedX web interface available on August 19, 2026. The application lets brands
          create X or Farcaster creator campaigns, creators apply and set their requested rate, and public work be evaluated through
          GenLayer StudioNet, where native test-GEN campaign funding and outcomes are recorded. It is a test environment demonstration, not a
          mainnet marketplace, bank, custodian, broker, employment service, or financial product.
        </p>
      </section>

      <section id="wallet">
        <span>02 / WALLET AUTHORITY</span>
        <h2>YOU CONTROL YOUR WALLET</h2>
        <p>
          You must control the wallet you connect and have authority to sign for it. InfluencedX authenticates with
          wallet signatures but never needs your seed phrase or private key. Review every signature, chain, contract
          address, call, amount, and deadline in your wallet before approving it.
        </p>
        <p>
          InfluencedX does not take custody of wallet keys. Native test GEN sent to the GenLayer marketplace contract is controlled by
          its deployed rules rather than a conventional custodial account. Transactions may be
          irreversible even when the interface, database, or another service later fails.
        </p>
      </section>

      <section id="marketplace">
        <span>03 / MARKETPLACE FLOW</span>
        <h2>CAMPAIGN TERMS BECOME COMMITMENTS</h2>
        <ol>
          <li>A brand saves a campaign draft with a public brief, criteria, deadlines, and a native test-GEN budget.</li>
          <li>The campaign opens only after GenLayer finalizes the exact payable funding transaction.</li>
          <li>A creator applies with their own requested rate; the brand may select an application.</li>
          <li>Selection, acceptance, public-post submission, and resolution each require the expected signed transaction and confirmed event.</li>
          <li>GenLayer evaluates the committed public evidence and credits the creator or brand according to the finalized outcome.</li>
        </ol>
        <p>
          A saved draft is not funded. A selected creator is not accepted. A submitted post is not verified. A finalized
          GenLayer result is not a promise of real-value payment. InfluencedX presents each state only after the required API and GenLayer
          evidence is available.
        </p>
      </section>

      <section id="testnet">
        <span>04 / TESTNET RISK</span>
        <h2>TEST GEN HAS NO PROMISED MONETARY VALUE</h2>
        <div className="legal-warning">
          <strong>NO GUARANTEED PAYMENT OR REFUND</strong>
          <p>
            A campaign may transfer native test GEN under the test contract rules, but neither InfluencedX nor this interface
            promises a payment, refund, exchange value, conversion to a real-value asset, or compensation for time, content,
            gas, or losses.
          </p>
        </div>
        <p>
          GenLayer StudioNet, the marketplace contract, validators, RPC
          services, and wallets are experimental dependencies. Risks include contract defects, incorrect or
          indeterminate AI evaluation, unavailable or changed X or Farcaster evidence, chain reorganization, stalled finality,
          validator disagreement, execution failure, lost keys, rate limits, service outages, and reset or discontinued test
          networks. Do not send mainnet assets or anything you cannot afford to lose.
        </p>
      </section>

      <section id="social-content">
        <span>05 / CREATOR IDENTITIES + CONTENT</span>
        <h2>SUBMIT ONLY PUBLIC WORK YOU CONTROL</h2>
        <ul>
          <li>Claim only an X or Farcaster identity you own or are authorized to operate.</li>
          <li>Submit the canonical public X post or Farcaster cast requested by the campaign; protected or unavailable evidence may be impossible to resolve.</li>
          <li>Do not impersonate, manipulate engagement, misstate ownership, reuse another creator&apos;s work, or submit unlawful, infringing, deceptive, malicious, or confidential content.</li>
          <li>Ensure any advertising disclosure, required phrase, prohibited phrase, and semantic brief committed by the campaign is satisfied.</li>
          <li>You remain responsible for your use of X or Farcaster and for rights in the content you publish.</li>
        </ul>
      </section>

      <section id="dependencies">
        <span>06 / THIRD-PARTY SYSTEMS</span>
        <h2>NO CONTROL OVER EXTERNAL SERVICES</h2>
        <p>
          InfluencedX depends on Vercel, Neon, X, Farcaster, GenLayer StudioNet, wallet software, RPC providers, and block
          explorers. Their availability, rules, fees, rate limits, security,
          and data practices are outside this interface&apos;s control. Links to those services are provided for convenience
          and do not guarantee their accuracy or continued availability.
        </p>
      </section>

      <section id="privacy">
        <span>07 / DATA</span>
        <h2>PUBLIC EVIDENCE CAN REMAIN PUBLIC</h2>
        <p>
          Wallet addresses, hashes, test-GEN amounts, requests, and outcomes written to GenLayer StudioNet
          may be publicly visible during its temporary retention window and cannot be removed by InfluencedX. Offchain social evidence is subject
          to the deletion policy described in the <Link href="/privacy">Privacy Notice</Link>, but deletion cannot erase
          public-chain history or copies held by X, Farcaster, or third parties.
        </p>
      </section>

      <section id="availability">
        <span>08 / AVAILABILITY + CHANGES</span>
        <h2>THE TESTNET BUILD MAY CHANGE OR STOP</h2>
        <p>
          Features, contracts, addresses, criteria, test balances, and stored test records may be changed, suspended, or
          discontinued to protect the system, repair defects, comply with platform constraints, or complete the
          evaluation. A change to the interface cannot reverse public-chain transactions already confirmed.
        </p>
      </section>

      <section id="disclaimer">
        <span>09 / DISCLAIMER</span>
        <h2>USE AT YOUR OWN RISK</h2>
        <p>
          The testnet application is provided for evaluation as available, without a promise that it is accurate,
          complete, secure, uninterrupted, fit for a particular purpose, or able to produce a specific GenLayer
          outcome. To the extent permitted by rules that apply to you, you accept the risks of testnet use and remain
          responsible for your wallet, content, transactions, and independent verification.
        </p>
        <p>
          This build does not identify an operating legal entity, contact channel, or governing jurisdiction. Reviewed
          production terms, operator details, dispute procedures, and jurisdiction-specific notices must be added before
          any public mainnet or real-value launch. The date at the top identifies this testnet version.
        </p>
      </section>
    </LegalDocument>
  );
}
