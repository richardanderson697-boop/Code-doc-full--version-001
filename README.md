# ⚡ Code Doc — AI Vibe Studio & Reactive Code Auditor

**Code Doc** is an AI-driven, interactive React and TypeScript development workspace. It allows developers to generate web app prototypes from natural language prompts, incrementally evolve existing components, inspect code AST anatomy in real time, run automated cold audits, and debug syntax or state logic line-by-line.

---

## 🚀 Key Features

* **✨ Vibe Code Generation & Evolution:**
  * **Incremental Evolution Mode:** Evolve and append features directly onto existing code files without starting over.
  * **Fresh Build Mode:** Generate brand-new standalone components from scratch.
  * **Real-time SSE Streaming:** Live streaming of generated code and architectural blueprints.

* **🧬 Reactive AST & Code Anatomy Inspector:**
  * Real-time parsing of components, state hooks (`useState`, `useEffect`, `useRef`), imports, custom helper functions, and JSX structures via AST parsing.
  * Clickable AST elements to highlight and trace specific code lines in the editor.

* **🐞 AI Vibe Debugger:**
  * Interactive error diagnostic tools with line-by-line code inspection.
  * In-workspace code healing for automated syntax fix recommendations.

* **🔍 Cold Code Auditor:**
  * Perform un-biased secondary audits to evaluate app feature completeness, state flow, edge cases, and missing UI elements.
  * Supports auditing external pasted code and loaded multi-file codebase archives (`.zip`).

* **🛡️ Deterministic PreFlight Scan:**
  * Every audit runs [PreFlight](https://preflight.midatlantic.ai)'s static analysis probes first: line-anchored security and quality findings with no model judgment involved.
  * Findings are shown in their own panel with evidence, remediation, and CWE/OWASP mapping, and are handed to the AI pass as verified ground truth instead of asking the model to be accurate on its own.
  * The scan is local and offline, so audits still return findings when the AI service is unavailable.

* **📜 Doc Registry & Workspace State:**
  * Automatic local database persistence for generated project history.
  * Markdown architectural blueprint exporter.
  * One-click clipboard code sharing.

---

## 🛠️ Tech Stack

* **Frontend:** React 19, TypeScript, Tailwind CSS, Lucide React (Icons)
* **Backend:** Express 4, Vite middleware in dev, esbuild bundle in production
* **AI:** Google Gemini via `@google/genai`
* **Static analysis:** Vendored PreFlight probe engine (`acorn` AST parsing)
* **Parser:** Custom AST React Anatomy Parser (`utils/anatomyParser.ts`)
* **Streaming Protocol:** Server-Sent Events (SSE) via `fetch` streaming
* **Tests:** Vitest

---

## 🚦 Getting Started

```bash
bun install          # or npm install
cp .env.example .env # then set GEMINI_API_KEY
bun run dev          # http://localhost:3000
```

| Script          | What it does                                  |
| --------------- | --------------------------------------------- |
| `dev`           | Dev server with Vite middleware                |
| `build`         | Production client bundle + server bundle       |
| `start`         | Run the built server                           |
| `lint`          | `tsc --noEmit`                                 |
| `test`          | Vitest suite                                   |
| `verify`        | lint, test, and build in sequence              |

### Environment

| Variable           | Required | Purpose                                                        |
| ------------------ | -------- | -------------------------------------------------------------- |
| `GEMINI_API_KEY`   | yes      | Gemini API calls. AI Studio injects this automatically.         |
| `PORT`             | no       | Injected by Cloud Run and most hosts. Defaults to 3000.         |
| `APP_ACCESS_TOKEN` | no       | When set, every `/api` route requires `Authorization: Bearer`.  |

> **Self-hosting note:** the workspace and project history are a single
> shared server-side store, so the app expects one trusted user. If you
> deploy it on a public URL, set `APP_ACCESS_TOKEN`.

---

## 📂 Project Structure

```text
├── server.ts                     # Bootstrap: middleware, route mounts, static serving
├── server/
│   ├── gemini.ts                 # Gemini client + primary→fallback model helpers
│   ├── db.ts                     # Project history ledger (projects.json)
│   ├── workspace.ts              # Path containment + workspace file scanner
│   ├── deterministic-scan.ts     # Regex evidence scan
│   ├── preflight-scan.ts         # PreFlight engine adapter
│   ├── logger.ts                 # Env-aware server logger
│   ├── preflight/vendor/         # Vendored PreFlight scan engine (see VENDORED.md)
│   └── routes/
│       ├── projects.ts           # Project history CRUD
│       ├── ai.ts                 # Heal, audit, SSE generate
│       ├── cold-audit.ts         # Structured cold-read auditor
│       ├── workspace.ts          # ZIP intake, file CRUD, AI file generation
│       └── intelligence.ts       # Whole-workspace analyzer
├── shared/
│   └── preflight-types.ts        # Scan result types shared by server and UI
├── src/
│   ├── components/
│   │   ├── AIDebugger.tsx        # Line-by-line AI debugging panel
│   │   ├── AnatomyInspector.tsx  # Interactive AST component visualizer
│   │   ├── CodeAuditor.tsx       # Audit coordinator: state, ZIP intake, modes
│   │   ├── CodeVisualizer.tsx    # Code editor pane with line highlighting
│   │   ├── HistorySidebar.tsx    # Saved project registry drawer
│   │   ├── PurposeVisualizer.tsx # Architectural blueprint renderer
│   │   ├── WelcomeView.tsx       # Initial prompt and codebase loader
│   │   └── auditor/
│   │       ├── ColdReadResults.tsx        # Evidence checklist + report export
│   │       ├── IntelligenceReport.tsx     # Ledger, rubric, application map
│   │       ├── PreFlightFindingsPanel.tsx # Deterministic findings
│   │       ├── GithubIntegrationTab.tsx   # CI pipeline builder
│   │       ├── githubCiTemplates.ts       # Pure workflow/script builders
│   │       └── types.ts                   # Shared audit result types
│   ├── utils/
│   │   ├── anatomyParser.ts      # React AST / structural code analyzer
│   │   └── logger.ts             # Env-aware client logger
│   ├── types.ts                  # VibeProject & domain data models
│   ├── App.tsx                   # Main workspace & streaming coordinator
│   └── main.tsx                  # React DOM root entrypoint
├── test/                         # Vitest suite
├── package.json
└── README.md
