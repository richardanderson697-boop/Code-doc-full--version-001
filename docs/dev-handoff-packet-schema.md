# Developer Handoff Packet — schema v1

The **developer handoff packet** is the shared Markdown format both GradeVibes
(consumer) and FinalRead (investor) emit when an audit finding gets a
*suggested* fix. It is the first concrete artifact of the investor-Q&A
developer handoff: portable, review-only, and shaped so a developer can act on
it without ever seeing the product UI.

## Design rules

1. **Suggested, never applied.** The packet is a proposal for human review. The
   products that emit it must not modify user code on the packet's behalf.
2. **Portable Markdown default.** One `.md` file, no product-specific chrome,
   renders anywhere (GitHub, editors, email).
3. **No effort estimates in v1.** No hours, story points, t-shirt sizes, or
   "easy/hard/trivial" language — in the model prompt, the renderer, and the
   packet itself.
4. **Runtime disclaimer required.** The suggestion comes from static analysis
   plus an AI model; nothing in the packet was executed or verified at runtime.
5. **"Not exhaustive" notice required.** One packet covers one finding. It is
   not a certification of the codebase, and automated output always needs
   human review before shipping.

## Sections (in order)

1. **Header** — packet title, emitting product (`GradeVibes` or `FinalRead`),
   generation timestamp (ISO 8601), and a REVIEW ONLY status banner.
2. **Finding** — the finding's title, exactly as the scanner reported it.
3. **Source finding** — the original record: message, severity, type
   (probe/category), and the scanner's own recommendation when one exists.
   This is the ground truth the suggestion was built from.
4. **Plain-English issue** — 1–3 sentences a non-engineer could understand:
   what is wrong and what could go wrong if it is ignored. No jargon without
   explanation.
5. **Evidence** — the `file:line` anchor plus the relevant code snippet that
   demonstrates the problem.
6. **Suggested remediation** — a unified diff, or clearly labeled
   BEFORE/AFTER code blocks, showing the smallest change that addresses the
   finding. Whole-file rewrites are out of scope; if the finding looks like a
   false positive or cannot be fixed in code, this section says so instead of
   inventing a diff.
7. **How to verify the fix** — ordered, concrete steps a developer can run
   (commands, tests, manual checks) to confirm the remediation works.
8. **Runtime disclaimer** — states the suggestion was generated from static
   analysis output, was not executed or tested, and production behavior may
   differ.
9. **Scope notice** — "not exhaustive": one finding only, no codebase
   certification, automated suggestion, human review required before any
   change ships. Ends with the explicit v1 line: *No effort estimates are
   included in v1 packets by design.*

## Reference implementation

- Schema definition + renderer: `shared/dev-handoff-packet.ts`
  (`renderDevHandoffPacket`)
- Consumer route: `POST /api/suggest-fix` in `server/routes/ai.ts`
  (credit-gated; never charges for empty/unparseable model responses)
- Consumer UI: `src/components/auditor/SuggestFixPanel.tsx`, wired into
  `PreFlightFindingsPanel` (per-finding "Suggest fix", review panel,
  "Export handoff packet (.md)" download)
- Tests: `test/suggest-fix.test.ts`

## FinalRead notes

FinalRead will emit the same packet format with `product: "FinalRead"`,
extending the **Source finding** section with the original investor question
when the packet originates from investor Q&A. The v1 rules above (no effort
estimates, review-only, runtime disclaimer, not-exhaustive notice) apply to
both products unchanged.
