// The original regex evidence scan still feeds the cold-audit sheet.
// These pin its behavior so the PreFlight layer landing beside it cannot
// silently change what it reports.
import { describe, it, expect } from "vitest";
import { runDeterministicScan } from "../server/deterministic-scan";

describe("runDeterministicScan", () => {
  it("counts express endpoints", () => {
    const s = runDeterministicScan(`app.get("/a", h);\napp.post("/b", h);\nrouter.delete("/c", h);`);
    expect(s.endpointCount).toBe(3);
    expect(s.endpoints[0].lines).toBe("1");
  });

  it("counts fetch and axios calls but not commented ones", () => {
    const s = runDeterministicScan(`fetch("/api/x");\n// fetch("/api/y");\naxios.post("/api/z");`);
    expect(s.fetchCount).toBe(2);
  });

  it("finds TODO and FIXME markers only in comments", () => {
    const s = runDeterministicScan(`// TODO: wire this up\nconst label = "TODO in a string";\n// FIXME: broken`);
    expect(s.todoCount).toBe(2);
  });

  it("flags a hardcoded port and clears it when process.env.PORT is used", () => {
    const hard = runDeterministicScan(`app.listen(3000);`);
    expect(hard.hardcodedPortCount).toBe(1);
    expect(hard.usesProcessEnvPort).toBe(false);

    const soft = runDeterministicScan(`const PORT = process.env.PORT || 3000;\napp.listen(PORT);`);
    expect(soft.usesProcessEnvPort).toBe(true);
  });

  it("counts any-type bypasses", () => {
    const s = runDeterministicScan(`function f(x: any) {}\nconst y = z as any;\nconst ok: string = "s";`);
    expect(s.anyCount).toBe(2);
  });

  it("finds commented-out schedulers", () => {
    const s = runDeterministicScan(`// setInterval(tick, 1000);\nsetInterval(realTick, 1000);`);
    expect(s.commentedSchedulersCount).toBe(1);
  });

  it("detects test assertions", () => {
    const s = runDeterministicScan(`describe("x", () => {\n  it("works", () => {\n    expect(1).toBe(1);\n  });\n});`);
    expect(s.testCount).toBeGreaterThan(0);
  });

  it("returns zeroed counts for an empty file", () => {
    const s = runDeterministicScan("");
    expect(s.endpointCount).toBe(0);
    expect(s.fetchCount).toBe(0);
    expect(s.todoCount).toBe(0);
    expect(s.anyCount).toBe(0);
  });

  it("reports 1-based line numbers", () => {
    const s = runDeterministicScan(`const a = 1;\nconst b = 2;\napp.get("/x", h);`);
    expect(s.endpoints[0].lines).toBe("3");
  });

  // Dead action elements (Rule 1): a Button/link that promises an action
  // but has no wiring. Automate-AI pricing page, 2026-11-07: three
  // "Get Started" buttons, zero handlers.
  it("flags dead pricing buttons with no handler", () => {
    const code = `<Button className="w-full">Get Started</Button>\n<Button className="w-full">Get Started</Button>`;
    const s = runDeterministicScan(code, "app/pricing/pricing-client.tsx");
    expect(s.deadActionCount).toBe(2);
    expect(s.deadActions[0].label).toBe("Get Started");
    expect(s.deadActions[0].paymentRelated).toBe(true);
    expect(s.deadActions[0].lines).toBe("1");
  });

  it("flags a dead non-payment button as not payment-related", () => {
    const code = `<Button>\n  <Plus className="mr-2 h-4 w-4" />\n  Add Part\n</Button>`;
    const s = runDeterministicScan(code, "app/dashboard/inventory/inventory-client.tsx");
    expect(s.deadActionCount).toBe(1);
    expect(s.deadActions[0].label).toBe("Add Part");
    expect(s.deadActions[0].paymentRelated).toBe(false);
  });

  it("does not flag a button that forwards props with a spread", () => {
    const code = `<button data-slot="button" className={cn(variants({ variant }))} {...props} />`;
    const s = runDeterministicScan(code, "components/ui/button.tsx");
    expect(s.deadActionCount).toBe(0);
  });

  it("does not flag a button with an onClick handler", () => {
    const code = `<Button onClick={handleDiagnosis} disabled={loading || !symptoms.trim()}>Diagnose</Button>`;
    const s = runDeterministicScan(code, "app/dashboard/diagnostics/diagnostics-client.tsx");
    expect(s.deadActionCount).toBe(0);
  });

  it("does not flag a submit button inside a form", () => {
    const code = `<form onSubmit={handleSubmit}>\n  <Button type="submit">Save</Button>\n</form>`;
    const s = runDeterministicScan(code, "app/customer/request/request-client.tsx");
    expect(s.deadActionCount).toBe(0);
  });

  it("does not flag a disabled button", () => {
    const code = `<Button disabled>Save</Button>`;
    const s = runDeterministicScan(code, "app/dashboard/settings/settings-client.tsx");
    expect(s.deadActionCount).toBe(0);
  });

  it("does not flag an asChild button wrapping a link", () => {
    const code = `<Button asChild size="lg">\n  <Link href="/customer/request">Submit Diagnostic Request</Link>\n</Button>`;
    const s = runDeterministicScan(code, "app/customer/page.tsx");
    expect(s.deadActionCount).toBe(0);
  });

  it("does not flag a button wrapped in a link", () => {
    const code = `<Link href="/customer">\n  <Button variant="outline">Customer Portal</Button>\n</Link>`;
    const s = runDeterministicScan(code, "app/page.tsx");
    expect(s.deadActionCount).toBe(0);
  });

  it("does not flag a link with an href, but flags a bare anchor", () => {
    const wired = runDeterministicScan(`<a href="/pricing">View pricing</a>`, "app/page.tsx");
    expect(wired.deadActionCount).toBe(0);
    const dead = runDeterministicScan(`<a>Click here</a>`, "app/page.tsx");
    expect(dead.deadActionCount).toBe(1);
    expect(dead.deadActions[0].label).toBe("Click here");
    expect(dead.deadActions[0].paymentRelated).toBe(false);
  });

  it("does not run the JSX pass on non-JSX files", () => {
    const s = runDeterministicScan(`// <Button>Get Started</Button>`, "server/routes/billing.ts");
    expect(s.deadActionCount).toBe(0);
  });

  // Mocked payments (Rule 2): a checkout route that records the sale as
  // complete without calling any payment provider.
  const CHECKOUT_NO_PROVIDER = `import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const { cart, paymentMethod } = await request.json()
  const supabase = await createClient()
  const { data: sale } = await supabase.from('sales').insert({
    organization_id: 'org-1',
    total: 99,
    payment_method: paymentMethod,
    status: 'completed',
  }).select().single()
  return NextResponse.json({ success: true, saleId: sale.id })
}`;

  it("flags a checkout route that marks sales complete with no provider", () => {
    const s = runDeterministicScan(CHECKOUT_NO_PROVIDER, "app/api/checkout/route.ts");
    expect(s.mockedPaymentCount).toBe(1);
    expect(s.mockedPayments[0].code).toContain("status: 'completed'");
  });

  it("does not flag a checkout route that calls Stripe", () => {
    const withStripe = `import Stripe from 'stripe'
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
export async function POST(request: NextRequest) {
  const session = await stripe.checkout.sessions.create({ mode: 'payment' })
  await db.insert({ status: 'completed' })
}`;
    const s = runDeterministicScan(withStripe, "app/api/checkout/route.ts");
    expect(s.mockedPaymentCount).toBe(0);
  });

  it("does not flag a completed status outside a checkout route", () => {
    const s = runDeterministicScan(`const order = { status: 'completed' }`, "app/dashboard/orders/page.tsx");
    expect(s.mockedPaymentCount).toBe(0);
  });

  it("does not flag bare mock/simulated keywords in comments as stubs", () => {
    const s = runDeterministicScan(
      `// Returns simulated data for the preview pane\n// mock response shape documented here\nconst data = await fetchReal();`,
      "src/api.ts"
    );
    expect(s.stubCount).toBe(0);
  });

  it("still flags an explicit TODO: implement comment as a stub", () => {
    const s = runDeterministicScan(`// TODO: implement the real handler\nconst ok = true;`, "src/api.ts");
    expect(s.stubCount).toBe(1);
  });

  it("still flags mock data declarations in non-mock files", () => {
    const s = runDeterministicScan(`const mockUsers = [{ id: 1 }];`, "src/App.tsx");
    expect(s.stubCount).toBe(1);
  });

  it("does not flag mock declarations in test files (fixtures, not stubs)", () => {
    const s = runDeterministicScan(
      `const mockBlueprint = { title: "t" };\ndescribe("x", () => { it("works", () => { expect(mockBlueprint.title).toBe("t"); }); });`,
      "src/__tests__/orchestration.test.ts"
    );
    expect(s.stubCount).toBe(0);
  });
});
