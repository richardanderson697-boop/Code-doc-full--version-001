import express from "express";
import path from "path";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

import { log } from "./server/logger";
import { initProjectsStore } from "./server/db";
import { initAuthStore } from "./server/authdb";
import authRouter from "./server/routes/auth";
import billingRouter, { handleStripeWebhook } from "./server/routes/billing";
import projectsRouter from "./server/routes/projects";
import aiRouter from "./server/routes/ai";
import coldAuditRouter from "./server/routes/cold-audit";
import workspaceRouter from "./server/routes/workspace";
import intelligenceRouter from "./server/routes/intelligence";

dotenv.config();

const app = express();
// Cloud Run (and most hosts) inject PORT; 3000 is the local-dev fallback.
const PORT = Number(process.env.PORT) || 3000;

// Optional shared-token gate for self-hosted deployments. Off by default so
// the AI Studio flow is unchanged; set APP_ACCESS_TOKEN to require
// "Authorization: Bearer <token>" on every /api route.
//
// Registered BEFORE the body parsers on purpose. Behind them, an anonymous
// request still got its body buffered and JSON-parsed (up to 100MB for the
// upload route) before being rejected, so the gate could be made to do
// unbounded work by callers it was there to turn away.
const ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN || "";
app.use("/api", (req, res, next) => {
  if (!ACCESS_TOKEN) return next();
  const supplied = Buffer.from(String(req.headers.authorization || ""));
  const expected = Buffer.from(`Bearer ${ACCESS_TOKEN}`);
  if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized: missing or invalid access token" });
});

// Stripe webhook needs the RAW body for signature verification, so it is
// registered before the JSON parsers below (which would consume the bytes).
app.post("/api/billing/webhook", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  handleStripeWebhook(req, res).catch((err) => {
    log.error("Stripe webhook handler error:", err);
    res.status(500).json({ error: "Webhook failed" });
  });
});

// JSON body parsing. Only the ZIP upload route carries base64 archives and
// needs a large budget; every other route is code/prompt payloads. The path
// compare is deliberately strict: any spelling that misses it falls through
// to the smaller limit, which is the safe direction.
const jsonDefault = express.json({ limit: "10mb" });
const jsonZipUpload = express.json({ limit: "100mb" });
app.use((req, res, next) =>
  req.path === "/api/upload-zip" ? jsonZipUpload(req, res, next) : jsonDefault(req, res, next)
);

initProjectsStore();
initAuthStore();

// API routes
app.use(authRouter);
app.use(billingRouter);
app.use(projectsRouter);
app.use(aiRouter);
app.use(coldAuditRouter);
app.use(workspaceRouter);
app.use(intelligenceRouter);

// Global Error Handling Middleware to catch JSON body parsing & payload limits
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  log.error("Express App Error:", err);
  if (err.status === 413 || err.type === "entity.too.large") {
    return res.status(413).json({
      error: "The uploaded file is too large. Please select a smaller ZIP file."
    });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      error: "Malformed request payload. Invalid JSON format."
    });
  }
  res.status(err.status || 500).json({
    error: err.message || "An unexpected server error occurred."
  });
});

// Catch-all 404 handler for unhandled /api requests to prevent HTML SPA fallback
app.all("/api/*", (req, res) => {
  res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
});

// Vite / static asset serving configuration
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    log.info(`Server running on http://localhost:${PORT} in ${process.env.NODE_ENV || "development"} mode`);
  });
}

startServer().catch((err) => {
  log.error("Fatal: server failed to start:", err);
  process.exit(1);
});
