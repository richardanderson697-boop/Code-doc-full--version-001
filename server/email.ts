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

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
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
