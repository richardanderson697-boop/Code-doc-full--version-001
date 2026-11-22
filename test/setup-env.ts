// Point every filesystem-touching module at a disposable directory before any
// test module is imported. Without this, the store tests operated on the real
// data/ directory and a test run deleted the developer's project history.
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-doc-test-"));
process.env.CODEDOC_DATA_DIR = path.join(root, "data");
process.env.CODEDOC_UPLOAD_DIR = path.join(root, "uploaded_project");

// No API key in tests: the AI pass must fail so the deterministic paths and
// the degraded responses are what gets exercised.
delete process.env.GEMINI_API_KEY;
delete process.env.APP_ACCESS_TOKEN;

// The auth routes throttle signups/logins/resets per email and per IP
// (in-memory, per process). The suite creates dozens of users from one IP,
// which would trip the per-IP limits across tests, so each test starts
// with a fresh throttle map. The dynamic import keeps the router module
// from loading before the temp data dirs above are set.
beforeEach(async () => {
  const { _resetAuthThrottlesForTests } = await import("../server/routes/auth");
  _resetAuthThrottlesForTests();
});
