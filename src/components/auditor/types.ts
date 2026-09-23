// Shared result/report types for the Code Auditor surfaces.
import type { PreFlightReport } from "../../../shared/preflight-types";

export interface InventoryItem {
  name: string;
  purpose: string;
  lines: string;
}

export interface ClaimCheckItem {
  name: string;
  claim: string;
  verified: boolean;
  lines: string;
  detail: string;
  snippet?: string;
}

export interface GapItem {
  lines: string;
  issue: string;
  snippet?: string;
}

export interface StructuralFlagItem {
  lines: string;
  issue: string;
}

export interface KeyConsequenceItem {
  finding: string;
  consequence: string;
  type: "success" | "risk";
}

export interface CategoryScoreDetail {
  score: number;
  max: number;
  reason: string;
}

export interface CategoryScores {
  serverStarts?: CategoryScoreDetail;
  authentication?: CategoryScoreDetail;
  databaseLayer?: CategoryScoreDetail;
  errorHandling?: CategoryScoreDetail;
  coreLogic?: CategoryScoreDetail;
  backgroundAutomation?: CategoryScoreDetail;
  externalIntegrations?: CategoryScoreDetail;
  security?: CategoryScoreDetail;
  performance?: CategoryScoreDetail;
  documentationVerified?: CategoryScoreDetail;
}

export interface FileEvidenceItem {
  lines: string;
  codeSnippet: string;
  conclusion: string;
  confidence: "High" | "Medium" | "Low";
}

export interface AuditResult {
  truncated: boolean;
  fileName: string;
  evidence: FileEvidenceItem[];
  // Deterministic PreFlight report attached by /api/cold-audit.
  preflight?: PreFlightReport;
}
