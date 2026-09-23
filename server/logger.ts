// Server-side logger. Errors and warnings always print (they are the ops
// interface on Cloud Run); info is muted in production unless DEBUG=1.
// This is the one server file allowed to touch console.* directly.
const verbose = process.env.DEBUG === "1" || process.env.NODE_ENV !== "production";

export const log = {
  info: (...args: unknown[]): void => {
    if (verbose) console.log(...args);
  },
  warn: (...args: unknown[]): void => {
    console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
};
