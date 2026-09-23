// GitHub Actions integration tab: config panel, generated workflow/script
// showcase, and the simulated PR preview. Fully self-contained.
import { useState } from "react";
import { motion } from "motion/react";
import { Check, Copy, Download, FileCode, FileText, GitBranch, Github, Loader2, Send, Settings, Terminal } from "lucide-react";
import { buildWorkflowYaml, buildAuditScript, GithubCiConfig } from "./githubCiTemplates";
import { AuditResult } from "./types";

interface GithubIntegrationTabProps {
  // Latest cold-read result, used by the simulated PR preview to pick its
  // pass/fail styling. `gaps` predates the current AuditResult shape and is
  // kept optional so the preview logic is unchanged.
  result?: (AuditResult & { gaps?: unknown[] }) | null;
}

export default function GithubIntegrationTab({ result = null }: GithubIntegrationTabProps) {
  const [repoOwner, setRepoOwner] = useState("my-organization");
  const [repoName, setRepoName] = useState("vibe-app");
  const [branchName, setBranchName] = useState("main");
  const [secretName, setSecretName] = useState("GEMINI_API_KEY");
  const [targetFile, setTargetFile] = useState("src/App.tsx");
  const [outputFolder, setOutputFolder] = useState("docs/audits");
  const [failUnderScore, setFailUnderScore] = useState(60);
  const [postPrComment, setPostPrComment] = useState(true);

  // Actions code tab
  const [activeGithubFile, setActiveGithubFile] = useState<"workflow" | "script">("workflow");
  const [testRunStatus, setTestRunStatus] = useState<"idle" | "running" | "success">("idle");
  const [copiedGithubFile, setCopiedGithubFile] = useState(false);

  const ciConfig: GithubCiConfig = {
    repoOwner,
    repoName,
    branchName,
    secretName,
    targetFile,
    outputFolder,
    failUnderScore,
    postPrComment,
  };
  const getWorkflowYaml = () => buildWorkflowYaml(ciConfig);
  const getAuditScript = () => buildAuditScript(ciConfig);

  const handleCopyGithubFile = () => {
    const text = activeGithubFile === "workflow" ? getWorkflowYaml() : getAuditScript();
    navigator.clipboard.writeText(text);
    setCopiedGithubFile(true);
    setTimeout(() => setCopiedGithubFile(false), 2000);
  };

  const handleDownloadGithubFile = () => {
    const text = activeGithubFile === "workflow" ? getWorkflowYaml() : getAuditScript();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = activeGithubFile === "workflow" ? "vibe_cold_audit.yml" : "vibe_cold_audit.js";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const runSimulatedActionTest = () => {
    setTestRunStatus("running");
    setTimeout(() => {
      setTestRunStatus("success");
    }, 1800);
  };

  return (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-5"
          >
            {/* Explainer card */}
            <div className="bg-gradient-to-br from-indigo-950/30 via-slate-950/40 to-slate-950/20 border border-indigo-500/15 rounded-2xl p-4 space-y-3 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-8 opacity-5">
                <Github className="w-32 h-32" />
              </div>
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/25 text-indigo-400">
                  <Github className="w-4 h-4" />
                </div>
                <h4 className="text-xs uppercase font-bold text-slate-200 tracking-wider font-mono">
                  Automated GitHub PR Auditor
                </h4>
              </div>
              <p className="text-xs text-slate-300 font-sans leading-relaxed max-w-lg">
                Enable automated cold-read audits on your GitHub repositories! Let non-technical directors, project managers, and product owners review <strong>exact app completeness</strong> on every Pull Request or commit—separating visual shell from unwritten logical code blocks automatically.
              </p>
            </div>

            {/* Config & Code split panels */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              
              {/* Left Column: Config Panel */}
              <div className="bg-slate-950/35 border border-slate-800 rounded-xl p-4 space-y-3.5">
                <div className="flex items-center gap-2 border-b border-slate-800 pb-2 mb-1">
                  <Settings className="w-4 h-4 text-indigo-400" />
                  <h5 className="text-[10px] uppercase font-bold tracking-wider text-slate-300 font-mono">
                    Pipeline Parameters
                  </h5>
                </div>

                <div className="space-y-3 text-xs">
                  <div>
                    <label className="block text-slate-400 font-medium mb-1 select-none">GitHub Repo Owner / Org</label>
                    <input
                      type="text"
                      value={repoOwner}
                      onChange={(e) => setRepoOwner(e.target.value)}
                      placeholder="e.g. acme-corp"
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-200 focus:outline-hidden focus:border-indigo-500/50"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 font-medium mb-1 select-none">Repo Name</label>
                    <input
                      type="text"
                      value={repoName}
                      onChange={(e) => setRepoName(e.target.value)}
                      placeholder="e.g. core-dashboard"
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-200 focus:outline-hidden focus:border-indigo-500/50"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-slate-400 font-medium mb-1 select-none">Trigger Branch</label>
                      <input
                        type="text"
                        value={branchName}
                        onChange={(e) => setBranchName(e.target.value)}
                        placeholder="e.g. main"
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-200 focus:outline-hidden focus:border-indigo-500/50"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 font-medium mb-1 select-none">Gemini Secret Name</label>
                      <input
                        type="text"
                        value={secretName}
                        onChange={(e) => setSecretName(e.target.value)}
                        placeholder="e.g. GEMINI_API_KEY"
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-200 focus:outline-hidden focus:border-indigo-500/50"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 font-medium mb-1 select-none">File to Audit</label>
                    <input
                      type="text"
                      value={targetFile}
                      onChange={(e) => setTargetFile(e.target.value)}
                      placeholder="e.g. src/App.tsx"
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-200 focus:outline-hidden focus:border-indigo-500/50"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 font-medium mb-1 select-none">Audit Output Folder</label>
                    <input
                      type="text"
                      value={outputFolder}
                      onChange={(e) => setOutputFolder(e.target.value)}
                      placeholder="e.g. docs/audits"
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-200 focus:outline-hidden focus:border-indigo-500/50"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="text-slate-400 font-medium select-none">Fail Build Score Threshold</label>
                      <span className="text-rose-400 font-mono font-bold">{failUnderScore}%</span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="100"
                      step="5"
                      value={failUnderScore}
                      onChange={(e) => setFailUnderScore(parseInt(e.target.value, 10))}
                      className="w-full accent-rose-500 cursor-pointer"
                    />
                    <p className="text-[9px] text-slate-500 mt-0.5 leading-relaxed">
                      Blocks pull requests automatically if evaluated completeness falls below this score.
                    </p>
                  </div>

                  <label className="flex items-center gap-2 bg-slate-900/50 p-2.5 rounded-lg border border-slate-800/80 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={postPrComment}
                      onChange={(e) => setPostPrComment(e.target.checked)}
                      className="w-4 h-4 accent-indigo-500 rounded text-indigo-500"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-slate-300 font-medium block">Post PR comments</span>
                      <span className="text-[9px] text-slate-500 block leading-tight">Writes results as markdown comments on the pull request timeline.</span>
                    </div>
                  </label>
                </div>
              </div>

              {/* Right Column: Dynamic Code Showcase */}
              <div className="bg-slate-950/35 border border-slate-800 rounded-xl p-4 flex flex-col min-h-0">
                {/* Selector */}
                <div className="flex bg-slate-900/50 p-1 rounded-lg border border-slate-800 mb-3 select-none gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setActiveGithubFile("workflow")}
                    className={`flex-1 py-1.5 px-2.5 rounded text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 cursor-pointer ${
                      activeGithubFile === "workflow"
                        ? "bg-slate-800 text-indigo-400 font-semibold"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>workflow.yml</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveGithubFile("script")}
                    className={`flex-1 py-1.5 px-2.5 rounded text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 cursor-pointer ${
                      activeGithubFile === "script"
                        ? "bg-slate-800 text-indigo-400 font-semibold"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <FileCode className="w-3.5 h-3.5" />
                    <span>auditor.js</span>
                  </button>
                </div>

                {/* Path indicator */}
                <div className="px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-t-lg flex items-center justify-between text-[10px] font-mono select-none shrink-0">
                  <span className="text-slate-400">
                    {activeGithubFile === "workflow" ? ".github/workflows/vibe_cold_audit.yml" : "scripts/vibe_cold_audit.js"}
                  </span>
                  
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleCopyGithubFile}
                      className="text-slate-400 hover:text-indigo-400 transition"
                      title="Copy content"
                      aria-label="Copy file content to clipboard"
                    >
                      {copiedGithubFile ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400 animate-bounce" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadGithubFile}
                      className="text-slate-400 hover:text-indigo-400 transition"
                      title="Download File"
                      aria-label="Download generated file"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Code display */}
                <div className="bg-slate-950 p-3.5 rounded-b-lg border-x border-b border-slate-800 font-mono text-[10px] text-slate-300 leading-relaxed overflow-y-auto max-h-80 select-text h-full">
                  <pre className="whitespace-pre">
                    {activeGithubFile === "workflow" ? getWorkflowYaml() : getAuditScript()}
                  </pre>
                </div>
              </div>

            </div>

            {/* Quick Steps Card */}
            <div className="bg-slate-950/30 border border-slate-800/80 rounded-xl p-4 space-y-3">
              <h5 className="text-[10px] uppercase font-bold tracking-wider text-slate-300 font-mono">
                🚀 Step-by-Step GitHub Setup Guide
              </h5>
              
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3.5 text-xs text-slate-400 leading-relaxed">
                <div className="bg-slate-900/40 p-3 rounded-lg border border-slate-800/60 space-y-1">
                  <div className="text-indigo-400 font-bold font-mono text-[10px] uppercase">Step 1</div>
                  <p className="text-slate-300 font-semibold text-[11px]">Save script</p>
                  <p className="text-[11px] text-slate-400">Create a file in your repository at <code className="bg-slate-950 px-1 py-0.2 rounded border border-slate-800 font-mono text-[9px] text-slate-300">scripts/vibe_cold_audit.js</code> and copy the javascript code inside.</p>
                </div>

                <div className="bg-slate-900/40 p-3 rounded-lg border border-slate-800/60 space-y-1">
                  <div className="text-indigo-400 font-bold font-mono text-[10px] uppercase">Step 2</div>
                  <p className="text-slate-300 font-semibold text-[11px]">Save workflow</p>
                  <p className="text-[11px] text-slate-400">Create a file in your repository at <code className="bg-slate-950 px-1 py-0.2 rounded border border-slate-800 font-mono text-[9px] text-slate-300">.github/workflows/vibe_cold_audit.yml</code> and copy the workflow yaml inside.</p>
                </div>

                <div className="bg-slate-900/40 p-3 rounded-lg border border-slate-800/60 space-y-1">
                  <div className="text-indigo-400 font-bold font-mono text-[10px] uppercase">Step 3</div>
                  <p className="text-slate-300 font-semibold text-[11px]">Store Secret key</p>
                  <p className="text-[11px] text-slate-400">In your GitHub repository, go to Settings &gt; Secrets and variables &gt; Actions, and add a secret <code className="bg-slate-950 px-1 py-0.2 rounded border border-slate-800 font-mono text-[9px] text-slate-300">GEMINI_API_KEY</code> containing your Gemini Key.</p>
                </div>

                <div className="bg-slate-900/40 p-3 rounded-lg border border-slate-800/60 space-y-1">
                  <div className="text-indigo-400 font-bold font-mono text-[10px] uppercase">Step 4</div>
                  <p className="text-slate-300 font-semibold text-[11px]">Permissions</p>
                  <p className="text-[11px] text-slate-400">Under Repo Settings &gt; Actions &gt; General &gt; Workflow permissions, make sure "Read and write permissions" is checked, so the action can post comments and push documentation!</p>
                </div>
              </div>
            </div>

            {/* Simulated Live PR Preview */}
            <div className="bg-slate-950/20 border border-slate-800 rounded-xl overflow-hidden">
              <div className="bg-slate-950 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-semibold text-slate-200">
                    GitHub Pull Request Review Interface Mockup
                  </span>
                </div>
                <div className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[9px] font-bold font-mono uppercase tracking-wider select-none">
                  Stakeholder Review view
                </div>
              </div>

              {/* Simulated GitHub PR Header */}
              <div className="p-4 bg-slate-900/40 border-b border-slate-800/60">
                <div className="flex items-start justify-between flex-wrap gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-1.5 flex-wrap">
                      <span>feat: Introduce calculated payment forecast core engine</span>
                      <span className="text-slate-500 font-normal">#42</span>
                    </h3>
                    <div className="flex items-center gap-2 text-xs text-slate-400 mt-1 flex-wrap">
                      <span className="bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full text-[10px] font-bold select-none">Open</span>
                      <span><strong>developer-alice</strong> wants to merge 3 commits into</span>
                      <code className="bg-slate-900 px-1 py-0.2 rounded font-mono text-[10px] text-slate-300">{branchName}</code>
                      <span>from</span>
                      <code className="bg-slate-900 px-1 py-0.2 rounded font-mono text-[10px] text-slate-300">feat-forecast-logic</code>
                    </div>
                  </div>
                </div>

                {/* PR Actions Status Check simulation */}
                <div className="mt-4 p-3 bg-slate-950/50 border border-slate-800 rounded-lg flex items-start gap-3 text-xs">
                  <div className="mt-0.5 select-none shrink-0">
                    {result ? (
                      (result.gaps && result.gaps.length > 0) || result.truncated ? (
                        <div className="w-5 h-5 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center font-bold">×</div>
                      ) : (
                        <div className="w-5 h-5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">✓</div>
                      )
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center font-bold">×</div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className="font-semibold text-slate-200">
                        {result ? (
                          (result.gaps && result.gaps.length > 0) || result.truncated
                            ? "All checks failed — Placeholders and gaps flagged"
                            : "All checks passed — Core business logic validated!"
                        ) : (
                          "Check failed — Placeholders and gaps flagged"
                        )}
                      </span>
                      <span className="text-[10px] text-slate-500">vibe-cold-read-auditor</span>
                    </div>
                    <div className="text-[11px] text-slate-400 flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-slate-500">● pr-audit-check (failed)</span>
                      <span>—</span>
                      <span className="text-slate-400">
                        Estimated Completeness: <strong className="text-rose-400">{result ? "55%" : "50%"}</strong> (Threshold required: {failUnderScore}%)
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Simulated Bot Comment inside PR */}
              <div className="p-4 bg-slate-900/10 space-y-4">
                <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950">
                  {/* Bot comment header */}
                  <div className="bg-slate-900/80 px-4 py-2 border-b border-slate-800/80 flex items-center justify-between text-xs select-none">
                    <div className="flex items-center gap-2">
                      <div className="p-1 rounded bg-indigo-500/10 text-indigo-400">
                        <Github className="w-3.5 h-3.5" />
                      </div>
                      <span className="font-semibold text-slate-200">vibe-cold-read-auditor</span>
                      <span className="bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded text-[9px] font-semibold">bot</span>
                      <span className="text-slate-500">commented 4 minutes ago</span>
                    </div>
                    <div className="text-slate-500 hover:text-slate-300 cursor-pointer">•••</div>
                  </div>

                  {/* Bot comment markdown content */}
                  <div className="p-4 text-xs font-sans text-slate-300 space-y-4 select-text">
                    <div className="space-y-1.5">
                      <h4 className="text-sm font-bold text-slate-100 flex items-center gap-2 border-b border-slate-800 pb-1.5">
                        🤖 Cold-Read Code Auditor Evaluation
                      </h4>
                      <p className="text-[11px] text-slate-400 leading-relaxed italic">
                        This is an impartial, zero-memory, unbiased cold audit run automatically on push/PR via GitHub Actions pipeline checking code files for objective completeness.
                      </p>
                    </div>

                    {/* Progress score */}
                    <div className="bg-slate-900 p-3 rounded-xl border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-slate-300 uppercase tracking-wider font-mono">ESTIMATED COMPLETENESS SCORE</span>
                        <span className="font-bold font-mono text-rose-400 text-sm">55%</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-slate-950 overflow-hidden border border-slate-850">
                        <div className="h-full bg-rose-500 rounded-full" style={{ width: "55%" }} />
                      </div>
                      <p className="text-[10px] text-slate-400 leading-relaxed mt-1">
                        🔒 <strong>Score breakdown:</strong> Boilerplate and Shell elements are evaluated at 45/50% completeness. However, Core Business Logic, Mathematical Models, and Algorithms are evaluated at only 10/50% completeness. Multiple core formula sub-functions are mock-stubbed or empty placeholders (e.g. <code className="bg-slate-950 font-mono text-slate-300 p-0.5 rounded text-[9px]">calculateCompoundRate</code>).
                      </p>
                    </div>

                    {/* Active Inventory */}
                    <div className="space-y-1">
                      <h5 className="font-bold text-slate-200 text-xs">🛠️ FULLY FUNCTIONAL ACTIVE FEATURES</h5>
                      <ul className="list-disc pl-4 space-y-1 text-slate-400">
                        <li><strong>Layout Components (Shell UI)</strong>: Side panel dashboard grid, layout containers, responsive styling, tab selectors.</li>
                        <li><strong>CRUD state handlers (Shell UI)</strong>: Add, delete and clear item toggles.</li>
                        <li><strong>Local Persistence (Shell UI)</strong>: Saved state triggers on localStorage.</li>
                      </ul>
                    </div>

                    {/* Missing Logic Gaps */}
                    <div className="space-y-1">
                      <h5 className="font-bold text-rose-400 text-xs">⚠️ PLACEHOLDERS, GAPS, & MISSING LOGIC</h5>
                      <ul className="list-disc pl-4 space-y-1 text-slate-400">
                        <li><strong className="text-slate-300">Lines 185-189:</strong> Comments like <code className="text-slate-300 font-mono text-[10px] bg-slate-900 px-1 py-0.2 rounded">// TODO: integrate actual forecast calculation algorithm</code> with a hardcoded constant output.</li>
                        <li><strong className="text-slate-300">Line 214:</strong> Empty exception handling block which swallows errors silently without state reporting.</li>
                      </ul>
                    </div>

                    {/* Reactive anatomy */}
                    <div className="space-y-1">
                      <h5 className="font-bold text-slate-200 text-xs">🧩 REACTIVE ANATOMY & ACTIVE MAPPING</h5>
                      <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900/60 text-[11px] font-mono">
                        <div className="grid grid-cols-3 bg-slate-900 p-1.5 border-b border-slate-800 text-[9px] uppercase tracking-wider text-slate-400 font-bold font-sans">
                          <div>Hook Name</div>
                          <div>Role</div>
                          <div>Verification</div>
                        </div>
                        <div className="grid grid-cols-3 p-1.5 border-b border-slate-800/60">
                          <div className="text-emerald-400">useState(items)</div>
                          <div className="text-slate-300">Basic CRUD list state</div>
                          <div className="text-emerald-400 font-bold font-sans uppercase text-[9px]">Verified ✓</div>
                        </div>
                        <div className="grid grid-cols-3 p-1.5">
                          <div className="text-emerald-400">calculateInterest()</div>
                          <div className="text-slate-300">Implements interest math</div>
                          <div className="text-rose-400 font-bold font-sans uppercase text-[9px]">MOCK (UI ONLY) ✗</div>
                        </div>
                      </div>
                    </div>

                  </div>
                </div>
              </div>

              {/* CI runner simulate CLI terminal */}
              <div className="p-4 border-t border-slate-850 bg-slate-950">
                <div className="flex items-center justify-between mb-3.5">
                  <div>
                    <h6 className="text-[10px] uppercase font-bold tracking-wider text-slate-400 flex items-center gap-1.5 font-mono">
                      <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                      Active CI Terminal Simulator
                    </h6>
                    <p className="text-[9px] text-slate-500 font-sans mt-0.5">
                      Verify how the action behaves inside GitHub runners based on your configuration parameters.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={runSimulatedActionTest}
                    disabled={testRunStatus === "running"}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white flex items-center gap-1.5 hover:shadow-md transition duration-150 cursor-pointer disabled:opacity-50"
                  >
                    {testRunStatus === "running" ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Running Job...</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-3.5 h-3.5" />
                        <span>Simulate Action Check</span>
                      </>
                    )}
                  </button>
                </div>

                {testRunStatus !== "idle" && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    className="p-3 bg-slate-950 border border-slate-800 rounded-lg font-mono text-[10px] text-slate-300 space-y-1 select-text overflow-hidden"
                  >
                    <div>$ git fetch origin && git checkout main</div>
                    <div>From github.com/{repoOwner}/{repoName}</div>
                    <div> * branch            main       -&gt; FETCH_HEAD</div>
                    <div>Already on 'main'</div>
                    <div>$ node --version</div>
                    <div className="text-slate-500">v18.12.0</div>
                    <div>$ node scripts/vibe_cold_audit.js</div>
                    <div className="text-indigo-400 animate-pulse">🔍 Contacting Cold Auditor engine for '{targetFile}'...</div>
                    
                    {testRunStatus === "running" && (
                      <div className="text-slate-500 italic">Streaming Gemini evaluation...</div>
                    )}

                    {testRunStatus === "success" && (
                      <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="space-y-1 pt-1.5 border-t border-slate-800/40 mt-1.5"
                      >
                        <div className="text-emerald-400">✅ Audit generated successfully!</div>
                        <div>📈 Evaluated Code Completeness: 55% (Required threshold: {failUnderScore}%)</div>
                        <div>💾 Audit report persisted to: {outputFolder}/cold_audit_App_tsx_178491030.md</div>
                        {postPrComment && <div className="text-indigo-300">💬 Successfully attached review comment to Pull Request #42 on GitHub!</div>}
                        
                        {55 < failUnderScore ? (
                          <div className="text-rose-400 font-semibold mt-2 border-t border-rose-950/20 pt-1.5">
                            ❌ BUILD CRITICAL FAULT: App completeness is evaluated at 55%, which is below the acceptable threshold of {failUnderScore}%. Placeholders and unwritten functional logic must be completed before merging.
                            <br />
                            Error: Process completed with exit code 1.
                          </div>
                        ) : (
                          <div className="text-emerald-400 font-semibold mt-2 border-t border-emerald-950/20 pt-1.5">
                            🚀 Verification complete. Code passes strict completeness threshold of {failUnderScore}%! Build check passes.
                          </div>
                        )}
                      </motion.div>
                    )}
                  </motion.div>
                )}
              </div>
            </div>

          </motion.div>
  );
}
