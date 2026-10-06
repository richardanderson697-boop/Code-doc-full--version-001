import React from "react";
import { X } from "lucide-react";

export type LegalDoc = "privacy" | "terms";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="text-sm font-bold text-slate-100 mb-1.5">{title}</h3>
      <div className="text-[13px] text-slate-400 leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

function PrivacyPolicy() {
  return (
    <>
      <p className="text-[13px] text-slate-500 mb-6">Last updated: October 6, 2026</p>
      <Section title="What we collect">
        <p><strong className="text-slate-300">Account information.</strong> When you sign up, we collect your email address and a password (stored as a salted scrypt hash — we never see your plaintext password). We use this to operate your account and manage sessions (30-day login cookies).</p>
        <p><strong className="text-slate-300">Code you upload.</strong> When you run an analysis, the code you provide is stored in our database, isolated per user — your workspace is visible only to you. We need it to run the analysis you asked for and to let you re-run or review past results.</p>
        <p><strong className="text-slate-300">Usage and metering.</strong> We record API usage per request (token counts from our AI provider) to deduct credits accurately and to detect abuse.</p>
        <p><strong className="text-slate-300">Payment information.</strong> Payments are processed by Stripe. We never see or store your card number — Stripe handles all card data. We store which credit pack you bought and your credit balance.</p>
      </Section>
      <Section title="What we do with your code — the important part">
        <p>Your code is used <strong className="text-slate-300">only</strong> to produce the analysis you requested.</p>
        <p>We do <strong className="text-slate-300">not</strong> use your code to train AI models — ours or anyone else's.</p>
        <p>We do <strong className="text-slate-300">not</strong> sell, share, or show your code to third parties except the processors listed below, who receive only what's needed to run the service.</p>
        <p>Code sent to our AI provider (Google Gemini) is transmitted for analysis under Google's API data-processing terms for paid usage.</p>
      </Section>
      <Section title="Processors and third parties">
        <p><strong className="text-slate-300">Stripe</strong> — payment processing (sees purchase details, never your code).</p>
        <p><strong className="text-slate-300">Google (Gemini API)</strong> — receives code excerpts you submit for analysis; used only to generate your report.</p>
        <p><strong className="text-slate-300">Railway / hosting infrastructure</strong> — runs our servers and database.</p>
      </Section>
      <Section title="Data retention">
        <p>Your account data and uploaded code are kept while your account is active so your history and re-runs work. If you delete your account, we delete your code and personal data within 30 days, except records we're legally required to keep (e.g., payment records for tax purposes).</p>
      </Section>
      <Section title="Your rights">
        <p>You can request a copy of your data, correct it, or delete your account and data at any time by contacting gradevibes0k@gmail.com. If you're in the EU/UK, you also have the right to object to or restrict certain processing and to lodge a complaint with your data protection authority.</p>
      </Section>
      <Section title="Security">
        <p>We use industry-standard measures: hashed passwords, encrypted connections (HTTPS), per-user data isolation, and authenticated API routes. No system is perfectly secure, but we treat your code like we'd want ours treated.</p>
      </Section>
      <Section title="Cookies">
        <p>We use a session cookie to keep you logged in. We don't use advertising or cross-site tracking cookies.</p>
      </Section>
      <Section title="Children">
        <p>GradeVibes isn't directed at anyone under 18, and we don't knowingly collect their data.</p>
      </Section>
      <Section title="Changes">
        <p>If we change this policy materially, we'll update the date above and, for significant changes, notify you by email. Continued use after changes means you accept the updated policy.</p>
      </Section>
    </>
  );
}

function TermsOfService() {
  return (
    <>
      <p className="text-[13px] text-slate-500 mb-6">Last updated: October 6, 2026</p>
      <Section title="1. What the service does">
        <p>GradeVibes analyzes code you provide and reports on its completeness and security posture using static analysis and AI-assisted review. <strong className="text-slate-300">No code is executed.</strong> Reports are informational assessments, not certifications.</p>
      </Section>
      <Section title="2. No security guarantee — read this">
        <p>A good report does not mean your code is secure, and a bad report does not mean it isn't. Static analysis can't catch everything, AI review can be wrong, and threats evolve. <strong className="text-slate-300">GradeVibes is not a substitute for professional security review, penetration testing, or legal/regulatory compliance assessment.</strong> You are solely responsible for deciding whether your software is fit to ship. To the maximum extent permitted by law, we are not liable for vulnerabilities our analysis didn't flag, for business decisions you make based on a report, or for any resulting damages.</p>
      </Section>
      <Section title="3. Accounts">
        <p>You must be 18 or older. You're responsible for keeping your login credentials confidential and for activity under your account.</p>
      </Section>
      <Section title="4. Credits and payments">
        <p>The service runs on credits. 1 credit ≈ $0.01 of AI processing cost. New accounts receive 50 welcome credits, free.</p>
        <p>Credit packs are one-time purchases (Starter $10 / 400 credits, Builder $25 / 1,100, Pro $50 / 2,400), processed by Stripe. Prices may change; the price at purchase applies.</p>
        <p>Credits are deducted per analysis based on actual metered usage. Some features (like the PreFlight scan) are free and don't consume credits.</p>
        <p><strong className="text-slate-300">Credits are non-refundable</strong> except where required by law or where we fail to deliver the purchased analysis. If a paid request errors before producing usable output, we don't charge for it — that's a bug, tell us.</p>
        <p>Credits don't expire, but they're tied to your account and can't be transferred or redeemed for cash.</p>
      </Section>
      <Section title="5. Your code and intellectual property">
        <p>You retain all rights to code you upload. By using the service you grant us a limited license to store, process, and analyze that code solely to operate the service for you (see Privacy Policy). We claim no ownership over your code or over reports generated from it — those are yours.</p>
        <p>Don't upload code you don't have the right to share (e.g., someone else's proprietary code, or code under a license that prohibits this kind of processing). You're responsible for having the rights to what you submit.</p>
      </Section>
      <Section title="6. Acceptable use">
        <p>Don't: break the law with the service; try to access other users' data; abuse the API (scraping, circumventing credit metering); upload malware; or use the service to attack third-party systems. We may suspend accounts for abuse.</p>
      </Section>
      <Section title="7. Availability">
        <p>We aim for reliable service but don't guarantee uptime. We may update, limit, or discontinue features with reasonable notice.</p>
      </Section>
      <Section title="8. Termination">
        <p>You can delete your account anytime (see Privacy Policy for data deletion). We may suspend or terminate accounts that violate these terms.</p>
      </Section>
      <Section title="9. Changes to these terms">
        <p>We'll update the date above and notify you of material changes by email. Continued use after changes means you accept them.</p>
      </Section>
      <Section title="10. Governing law">
        <p>These terms are governed by the laws of Georgia, excluding conflict rules. Disputes will be resolved in Georgia courts. Operator: GradeVibes. Contact: gradevibes0k@gmail.com.</p>
      </Section>
    </>
  );
}

export default function LegalModal({ doc, onClose }: { doc: LegalDoc; onClose: () => void }) {
  const title = doc === "privacy" ? "Privacy Policy" : "Terms of Service";
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
          <h2 className="font-bold text-slate-100">{title}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          {doc === "privacy" ? <PrivacyPolicy /> : <TermsOfService />}
        </div>
      </div>
    </div>
  );
}
