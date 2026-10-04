import { apiFetch } from "./apiFetch";
import { logError } from "./logger";

// Downloads the user's current workspace as a ZIP archive via
// GET /api/download-workspace. Throws with a human message on failure.
export async function downloadWorkspaceZip(): Promise<void> {
  const res = await apiFetch("/api/download-workspace");
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || "Workspace download failed.");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = "gradevibes-project.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on a tick so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function tryDownloadWorkspaceZip(onError: (msg: string) => void): Promise<void> {
  try {
    await downloadWorkspaceZip();
  } catch (e: any) {
    logError("workspace zip download failed", e);
    onError(e.message || "Workspace download failed.");
  }
}
