// Outbound email via Resend (server-side only; the API key never reaches
// the browser). Used for password-reset links. If RESEND_API_KEY is unset,
// sends are skipped and a warning is logged — the auth endpoints degrade to
// a clear "email not configured" error instead of failing silently.
import { log } from "./logger";

const RESEND_API = "https://api.resend.com/emails";

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export function resetEmailFrom(): string {
  return process.env.RESET_EMAIL_FROM || "GradeVibes <noreply@gradevibes.com>";
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("sendPasswordResetEmail skipped: RESEND_API_KEY is not set");
    throw new Error("Email sending is not configured.");
  }
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: resetEmailFrom(),
      to: [to],
      subject: "Reset your GradeVibes password",
      html: [
        `<p>You requested a password reset for your GradeVibes account (${escapeHtml(to)}).</p>`,
        `<p><a href="${escapeHtml(resetUrl)}">Set a new password</a> — this link expires in 1 hour and can only be used once.</p>`,
        `<p>If you didn't request this, you can safely ignore this email; your password won't change.</p>`,
      ].join("\n"),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.error(`Resend API error: ${res.status} ${body.slice(0, 200)}`);
    throw new Error("Could not send the reset email.");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Tell a FinalRead buyer their $199 payment was refunded because the
 * invite-code activation failed (spec §9.7, the losing payment). The
 * buyer keeps the 400 credits + 2 re-scan entitlements from the purchase;
 * only the report access is not granted. Best-effort: a send failure is
 * logged, never thrown — the refund record is the durable trace.
 */
export async function sendFinalReadRefundEmail(
  to: string,
  opts: { amount: string; reason: string; inviteCodeId: string }
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("sendFinalReadRefundEmail skipped: RESEND_API_KEY is not set");
    return;
  }
  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: resetEmailFrom(),
        to: [to],
        subject: "Your FinalRead payment was refunded",
        html: [
          `<p>Your FinalRead payment of ${escapeHtml(opts.amount)} was refunded because the report access could not be activated (${escapeHtml(opts.reason)}).</p>`,
          `<p>Your 400 credits and 2 included re-scans from the purchase are still on your account. If you still want the report, ask the seller for a new invite code and check out again — you will not be charged twice for the same report.</p>`,
          `<p>If you think this is a mistake, reply to this email and include the code reference ${escapeHtml(opts.inviteCodeId)}.</p>`,
        ].join("\n"),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error(`Resend API error (refund email): ${res.status} ${body.slice(0, 200)}`);
    }
  } catch (err: any) {
    log.error(`sendFinalReadRefundEmail failed: ${err?.message || err}`);
  }
}
