// Project history ledger routes.
import { Router } from "express";
import { readProjects, writeProjects } from "../db";
import { log } from "../logger";

const router = Router();

// 1. Get all projects
router.get("/api/projects", (req, res) => {
  const projects = readProjects();
  res.json(projects);
});

// 2. Save a new or update an existing project
router.post("/api/projects", (req, res) => {
  const { id, title, prompt, code, purpose, createdAt } = req.body;
  if (!title || !prompt) {
    return res.status(400).json({ error: "Title and prompt are required" });
  }

  const projects = readProjects();
  const existingIndex = projects.findIndex((p: any) => p.id === id);

  const projectData = {
    id: id || `project_${Date.now()}`,
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

// 3. Delete a project
router.delete("/api/projects/:id", (req, res) => {
  const { id } = req.params;
  const projects = readProjects();
  const filtered = projects.filter((p: any) => p.id !== id);

  if (projects.length === filtered.length) {
    return res.status(404).json({ error: "Project not found" });
  }

  if (writeProjects(filtered)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: "Failed to delete project" });
  }
});


export default router;
