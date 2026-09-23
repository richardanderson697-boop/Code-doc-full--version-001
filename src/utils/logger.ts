// Minimal env-aware logger. Keeps diagnostic output out of production
// bundles while preserving error visibility during development.
// This is the one file allowed to touch console.* directly.

export function logDebug(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.log(...args);
  }
}

export function logError(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.error(...args);
  }
}
