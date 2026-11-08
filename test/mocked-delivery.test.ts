// Mocked-delivery detection tests (Rules A, B, C).
// Spec: finalread-mocked-delivery-detection-spec.md.
// The Whistle-stop cleaning app is the motivating case: notifications
// marked 'Delivered' with no provider, user data in server memory only,
// and a success screen claiming the photos were sent to the admin.
import { describe, it, expect } from "vitest";
import { computeDeterministicAssessment } from "../server/deterministic-score";
import { buildFinalReadReport } from "../shared/finalread-report";
import type { PreFlightReport } from "../shared/preflight-types";
import type { WorkspaceFile } from "../server/workspace";

function wf(path: string, content: string): WorkspaceFile {
  return { path, content, lineCount: content.split("\n").length } as WorkspaceFile;
}

function emptyPreflight(score = 100): PreFlightReport {
  return {
    engine: "PreFlight",
    probeCount: 113,
    filesScanned: 1,
    filesSkipped: [],
    score,
    counts: {},
    findings: [],
    probeFailures: [],
    failed: null,
  };
}

const NOTIF_CODE = `import { sampleEstimateRequests, sampleNotificationLogs } from "./src/data/initialData";

let estimateStore: EstimateRequest[] = [...sampleEstimateRequests];
let notificationStore: NotificationLog[] = [...sampleNotificationLogs];

app.post("/api/estimates", (req, res) => {
  const data = req.body;
  const newEstimate: EstimateRequest = {
    id: \`EST-\${crypto.randomInt(1000, 10000)}\`,
    photos: Array.isArray(data.photos) ? data.photos.slice(0, 10) : [],
    customerName: String(data.customerName).slice(0, 100),
    status: 'pending',
  };
  estimateStore.unshift(newEstimate);

  const adminEmailNotif: NotificationLog = {
    id: \`NOTIF-ADM-\${Date.now()}\`,
    recipient: process.env.ADMIN_EMAIL || "admin@whistlestopcleaning.com",
    channel: 'EMAIL',
    subject: \`New Estimate Request \${newEstimate.id}\`,
    message: \`Photos: \${newEstimate.photos.length} uploaded.\`,
    timestamp: new Date().toISOString(),
    status: 'Delivered',
  };

  const customerSmsNotif: NotificationLog = {
    id: \`NOTIF-CUST-\${Date.now()}\`,
    recipient: newEstimate.customerPhone,
    channel: 'SMS',
    subject: 'Confirmation',
    message: \`We received your estimate request.\`,
    timestamp: new Date().toISOString(),
    status: 'Delivered',
  };

  notificationStore.unshift(adminEmailNotif, customerSmsNotif);
  return res.json({ success: true, estimate: newEstimate });
});
`;

const ORDER_CODE = `export function markOrderDelivered(order: Order) {
  order.status = 'Delivered';
  return order;
}
`;

const PROVIDER_CODE = `import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({ host: 'smtp.example.com' });

export async function sendAdminEmail(to: string, subject: string, body: string) {
  await transporter.sendMail({ from: 'noreply@example.com', to, subject, text: body });
}
`;

const PRISMA_CODE = `import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function saveEstimate(data: any) {
  return prisma.estimate.create({ data });
}
`;

const STATIC_CODE = `export const PRICING = [
  { tier: 'basic', price: 99 },
  { tier: 'deep', price: 199 },
];

export const sampleData = [
  { id: 'EST-1', customerName: 'Sample' },
];
`;

const CLAIM_CODE = `export function SuccessScreen({ submissionSuccess }: Props) {
  return (
    <div>
      Thank you, <strong>{submissionSuccess.customerName}</strong>! Your questionnaire and property photos have been sent directly to our administrator (<strong>RichardAnderson697@gmail.com</strong>).
    </div>
  );
}
`;

const FUTURE_CODE = `export function PromiseScreen() {
  return (
    <div>
      <p>We'll send your quote within 24 hours!</p>
      <p>Your order will be sent directly to your door.</p>
    </div>
  );
}
`;

describe("Rule A: notification marked delivered with no provider", () => {
  it("fires on the Whistle-stop notification literals", () => {
    const a = computeDeterministicAssessment([wf("server.ts", NOTIF_CODE)], emptyPreflight());
    const found = a.deterministicFindings.filter((f) => f.probe === "Mocked Notification");
    expect(found).toHaveLength(2);
    for (const f of found) {
      expect(f.title).toBe("Notification marked delivered with no delivery provider call");
      expect(f.unverified).toBe(true);
      expect(f.severity).toBe("medium");
    }
    expect(found.map((f) => f.line).sort()).toEqual([23, 33]);
  });

  it("does not fire on an order marked delivered (business state, no channel)", () => {
    const a = computeDeterministicAssessment([wf("orders.ts", ORDER_CODE)], emptyPreflight());
    expect(a.deterministicFindings.filter((f) => f.probe === "Mocked Notification")).toHaveLength(0);
  });

  it("does not fire when a delivery provider exists anywhere in the repo", () => {
    const a = computeDeterministicAssessment(
      [wf("server.ts", NOTIF_CODE), wf("src/mailer.ts", PROVIDER_CODE)],
      emptyPreflight()
    );
    expect(a.deterministicFindings.filter((f) => f.probe === "Mocked Notification")).toHaveLength(0);
  });

  it("does not fire on a type definition or on seed data", () => {
    const typeDef = `export interface NotificationLog {
  id: string;
  channel: 'SMS' | 'EMAIL';
  status: 'Sent' | 'Delivered';
}
`;
    const seed = `export const sampleNotificationLogs: NotificationLog[] = [
  {
    id: 'NOTIF-3001',
    channel: 'EMAIL',
    status: 'Delivered',
  },
];
`;
    const a = computeDeterministicAssessment(
      [wf("src/types.ts", typeDef), wf("src/data/initialData.ts", seed)],
      emptyPreflight()
    );
    expect(a.deterministicFindings.filter((f) => f.probe === "Mocked Notification")).toHaveLength(0);
  });
});

describe("Rule B: user data held only in server memory", () => {
  it("fires on the Whistle-stop stores, naming them as evidence", () => {
    const a = computeDeterministicAssessment([wf("server.ts", NOTIF_CODE)], emptyPreflight());
    const feat = a.missingFeatures.find((m) => m.feature === "Add database persistence layer");
    expect(feat).toBeDefined();
    expect(feat!.evidence.some((e) => e.includes("estimateStore"))).toBe(true);
    expect(feat!.evidence.some((e) => e.includes("notificationStore"))).toBe(true);
  });

  it("does not fire on static config arrays or sample-data seeds alone", () => {
    const a = computeDeterministicAssessment([wf("src/data.ts", STATIC_CODE)], emptyPreflight());
    expect(a.missingFeatures.filter((m) => m.feature === "Add database persistence layer")).toHaveLength(0);
  });

  it("does not fire when a persistence implementation exists", () => {
    const a = computeDeterministicAssessment(
      [wf("server.ts", NOTIF_CODE), wf("src/db.ts", PRISMA_CODE)],
      emptyPreflight()
    );
    expect(a.missingFeatures.filter((m) => m.feature === "Add database persistence layer")).toHaveLength(0);
  });
});

describe("Rule C: UI delivery claim with no sending code", () => {
  it("fires on the Whistle-stop success-screen claim", () => {
    const a = computeDeterministicAssessment(
      [wf("server.ts", NOTIF_CODE), wf("src/components/QuestionnaireView.tsx", CLAIM_CODE)],
      emptyPreflight()
    );
    const feat = a.missingFeatures.find((m) => m.feature.startsWith("Claimed delivery with no sending code"));
    expect(feat).toBeDefined();
    expect(feat!.feature).toContain("have been sent directly to our administrator");
  });

  it("does not fire on future-tense promises", () => {
    const a = computeDeterministicAssessment(
      [wf("src/components/PromiseScreen.tsx", FUTURE_CODE)],
      emptyPreflight()
    );
    expect(a.missingFeatures.filter((m) => m.feature.startsWith("Claimed delivery"))).toHaveLength(0);
  });

  it("does not fire when a delivery provider exists anywhere in the repo", () => {
    const a = computeDeterministicAssessment(
      [wf("src/components/QuestionnaireView.tsx", CLAIM_CODE), wf("src/mailer.ts", PROVIDER_CODE)],
      emptyPreflight()
    );
    expect(a.missingFeatures.filter((m) => m.feature.startsWith("Claimed delivery"))).toHaveLength(0);
  });
});

describe("mocked-delivery report mapping", () => {
  it("routes Rule A to needsVerification and Rules B + C to halfBuilt", () => {
    const a = computeDeterministicAssessment(
      [wf("server.ts", NOTIF_CODE), wf("src/components/QuestionnaireView.tsx", CLAIM_CODE)],
      emptyPreflight()
    );
    const report = buildFinalReadReport({
      projectTitle: "whistle-stop-cleaning",
      completenessScore: a.completenessScore,
      categoryScores: a.categories,
      findings: a.deterministicFindings,
      missingFeatures: a.missingFeatures,
    } as any);
    expect(report.needsVerification.map((i) => i.title)).toContain(
      "Notification marked delivered with no delivery provider call"
    );
    expect(report.halfBuilt.map((i) => i.title)).toContain("Add database persistence layer");
    expect(report.halfBuilt.some((i) => i.title.startsWith("Claimed delivery with no sending code"))).toBe(true);
    // Never a liability: the delivery could be made by another service.
    expect(report.liabilities.map((i) => i.title)).not.toContain(
      "Notification marked delivered with no delivery provider call"
    );
  });

  it("does not flag the mocked-payment fixture with any new rule", () => {
    const checkout = `export async function POST(req: Request) {
  const sale = { id: '1', status: 'completed' };
  return Response.json(sale);
}
`;
    const a = computeDeterministicAssessment([wf("app/api/checkout/route.ts", checkout)], emptyPreflight());
    expect(a.deterministicFindings.some((f) => f.probe === "Mocked Payment")).toBe(true);
    expect(a.deterministicFindings.filter((f) => f.probe === "Mocked Notification")).toHaveLength(0);
    expect(a.missingFeatures.filter((m) => m.feature.startsWith("Claimed delivery"))).toHaveLength(0);
  });
});
