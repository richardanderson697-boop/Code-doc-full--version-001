// Project history ledger routes.
//
// Tenant isolation: every project is owned by exactly one user. All three
// routes require a session, and every read/write/delete is scoped to
// req.user.id. A request for another user's project behaves exactly like a
// request for a nonexistent one (404), so project ids cannot be probed.
import { Router } from "express";
import { readProjects, writeProjects } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";
import { log } from "../logger";

const router = Router();

// 1. Get the caller's own projects, newest first.
router.get("/api/projects", requireAuth, (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const projects = readProjects().filter((p: any) => p.userId === userId);
  res.json(projects);
});

// 2. Save a new project, or update an existing one the caller owns.
router.post("/api/projects", requireAuth, (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const { id, title, prompt, code, purpose, createdAt } = req.body;
  if (!title || !prompt) {
    return res.status(400).json({ error: "Title and prompt are required" });
  }

  const projects = readProjects();
  const existingIndex = projects.findIndex((p: any) => p.id === id);

  // An id that exists but belongs to someone else is treated as not found:
  // the caller may not overwrite it, and learns nothing about it.
  if (existingIndex > -1 && projects[existingIndex].userId !== userId) {
    return res.status(404).json({ error: "Project not found" });
  }

  const projectData = {
    id: id || `project_${Date.now()}`,
    userId,
    title,
    prompt,
    code: code || "",
    purpose: purpose || "",
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (existingIndex > -1) {
    projects[existingIndex] = projectData;
  } else {
    projects.unshift(projectData); // Newest first
  }

  if (writeProjects(projects)) {
    res.json({ success: true, project: projectData });
  } else {
    res.status(500).json({ error: "Failed to save project" });
  }
});

// 3. Delete a project the caller owns.
router.delete("/api/projects/:id", requireAuth, (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const { id } = req.params;
  const projects = readProjects();
  const target = projects.find((p: any) => p.id === id);

  // Not found or not yours: identical response either way.
  if (!target || target.userId !== userId) {
    return res.status(404).json({ error: "Project not found" });
  }

  const filtered = projects.filter((p: any) => p.id !== id);
  if (writeProjects(filtered)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: "Failed to delete project" });
  }
});

export default router;
