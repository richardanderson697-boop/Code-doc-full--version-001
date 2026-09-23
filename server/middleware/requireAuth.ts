// Requires a valid session cookie. Attaches req.user. Public for PreFlight
// and other free endpoints; AI routes add this plus a credit check.
import type { Request, Response, NextFunction } from "express";
import { getSessionUser, SessionUser } from "../auth";
import { getBalance, MIN_CREDITS, CreditTier } from "../credits";

export interface AuthedRequest extends Request {
  user?: SessionUser;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Sign in required", code: "AUTH_REQUIRED" });
    return;
  }
  req.user = user;
  next();
}

// 402 when the balance is below the tier minimum. The true cost is metered
// and deducted after the Gemini call completes.
export function requireCredits(tier: CreditTier) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Sign in required", code: "AUTH_REQUIRED" });
      return;
    }
    const min = MIN_CREDITS[tier];
    const balance = getBalance(req.user.id);
    if (balance < min) {
      res.status(402).json({
        error: `Not enough credits for this action (needs ~${min}). Top up to continue.`,
        code: "INSUFFICIENT_CREDITS",
        balance,
        required: min,
      });
      return;
    }
    next();
  };
}
