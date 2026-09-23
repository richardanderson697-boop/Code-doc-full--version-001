// Pure builders for the GitHub Actions workflow + audit script the
// integration tab offers for download. Kept free of React so they can be
// unit-tested directly.

export interface GithubCiConfig {
  repoOwner: string;
  repoName: string;
  branchName: string;
  secretName: string;
  targetFile: string;
  outputFolder: string;
  failUnderScore: number;
  postPrComment: boolean;
}

export function buildWorkflowYaml(cfg: GithubCiConfig): string {
  const { repoOwner, repoName, branchName, secretName, targetFile, outputFolder, failUnderScore, postPrComment } = cfg;
  void repoOwner; void repoName; void branchName; void secretName; void targetFile; void outputFolder; void failUnderScore; void postPrComment;
    return `name: Cold-Read Code Auditor Check

on:
  push:
    branches: [ "${branchName}" ]
  pull_request:
    branches: [ "${branchName}" ]

permissions:
  contents: write
  pull-requests: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 18

      - name: Run Cold-Read Unbiased Audit Check
        env:
          ${secretName}: \${{ secrets.${secretName} }}
          TARGET_FILE: "${targetFile}"
          AUDIT_OUT_DIR: "${outputFolder}"
          FAIL_UNDER_SCORE: "${failUnderScore}"
          ${postPrComment ? `GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}` : ""}
        run: node scripts/vibe_cold_audit.js

      - name: Commit & Push Audit Documentation
        if: github.event_name == 'push' && success()
        run: |
          git config --global user.name "github-actions[bot]"
          git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add ${outputFolder}/
          git commit -m "docs: auto-generated unbiased cold audit report" || echo "No changes to commit"
          git push`;
}

export function buildAuditScript(cfg: GithubCiConfig): string {
  const { repoOwner, repoName, branchName, secretName, targetFile, outputFolder, failUnderScore, postPrComment } = cfg;
  void repoOwner; void repoName; void branchName; void secretName; void targetFile; void outputFolder; void failUnderScore; void postPrComment;
    return `const fs = require('fs');
const path = require('path');
const https = require('https');

// Read environment variables
const API_KEY = process.env.${secretName};
const TARGET_FILE = process.env.TARGET_FILE || '${targetFile}';
const OUT_DIR = process.env.AUDIT_OUT_DIR || '${outputFolder}';
const MIN_SCORE = parseInt(process.env.FAIL_UNDER_SCORE || '${failUnderScore}', 10);

if (!API_KEY) {
  console.error("❌ Error: ${secretName} is not defined in GitHub repository secrets.");
  process.exit(1);
}

if (!fs.existsSync(TARGET_FILE)) {
  console.error(\`❌ Error: Target file '\${TARGET_FILE}' does not exist.\`);
  process.exit(1);
}

const codeContent = fs.readFileSync(TARGET_FILE, 'utf8');
const numberedCode = codeContent.split('\\n').map((line, i) => \`\${i + 1}\\t\${line}\`).join('\\n');

const systemPrompt = \`You are a cold-read code auditor. You have NOT seen any request, prompt, or conversation that produced this code.
Perform a 100% cold-read, unbiased, and objective code audit on this React/TypeScript codebase. Cite exact line numbers.

CRITICAL WARNING AGAINST MATHEMATICAL GLORIFICATION & HALLUCINATION:
You MUST NEVER assume or claim high-level scientific, algorithmic, audio synthesis, or mathematical sophistication unless you see actual detailed equations or complex multi-node/custom logic coded explicitly in the file.
- Do NOT describe simple handlers, mock elements, or basic helper utilities as "sophisticated algorithms", "complex filters", or "highly advanced systems."
- If you see a Web Audio API implementation, look at the actual code blocks: if it is standard White Noise (e.g. via Math.random()), simple BiquadFilterNode configurations, basic setInterval volume tick adjustments, or simple single/dual oscillator beeps, you MUST describe them exactly as such: "simple, naive white-noise generation and basic volume ticking."
- NEVER invent or romanticize technical details. Do not claim there are "pink or brown noise buffers", "LFO sine-wave modulators at 0.12Hz", "exponential decay impulse curves", or "orchestrated major chord harmonies" unless you see the actual mathematical logic, LFO nodes, custom decay buffers, or multi-node chords explicitly defined in the source code.
- If the code is basic, call it "basic", "naive", or "rudimentary". Truth, accuracy, and extreme objectivity are absolute.

CRITICAL PRINCIPLE: SEPARATE BOILERPLATE SHELL FROM FUNCTIONAL BUSINESS LOGIC
You must never grade code completeness on a curve just because the UI renders, styles are pretty, and basic CRUD/localstorage functions do not crash. You must critically separate:
1. **The Shell / Boilerplate (Max 50% of the app's completeness)**: Visual layout, CSS styling, responsive HTML elements, simple state handlers (add/remove list items), modal wrappers, and localStorage getters/setters.
2. **The Core Business Logic & Core Algorithms (Remaining 50% of the app's completeness)**: The actual functional backbone of the application. This includes mathematical modeling (e.g. interest forecasting, payment calculations), alert schedulers/daemons, complex control branches, and actual data-processing algorithms.
If the core algorithms or mathematical models are stubbed out, mocked with hardcoded static variables, or completely missing, the codebase is at MOST 50% complete. Be absolutely brutal, honest, and objective about this.

Structure your audit strictly into these clear headers:
# 📊 AUDIT: CODEBASE COMPLETENESS & OBJECTIVE HEALTH CHECK
Calculate a strict "Estimated Completeness Score" from 0% to 100% using the above formula:
- **UI Shell & Boilerplate**: Worth up to 50% max.
- **Core Business Logic, Mathematical Models & Algorithms**: Worth up to 50%.
Explain the score in detail. Call out if the core math or backend simulation logic is missing or mocked.

# 🛠️ FULLY FUNCTIONAL ACTIVE FEATURES
(List the parts of the code that are fully coded, interactive, and completely implemented. Label them as "Boilerplate/Shell UI" or "Core Business Logic".)

# ⚠️ PLACEHOLDERS, GAPS, & MISSING LOGIC
(List every empty function, commented-out section, hardcoded mock placeholder, or missing mathematical modeling. Provide line numbers and explain exactly what logic needs to go there to make it fully functional rather than just a shell.)

# 🧩 REACTIVE ANATOMY & ACTIVE MAPPING
- **States & Hooks**: Describe each active useState/useEffect and its exact real-world function.

Respond ONLY in standard markdown format. No code fences around the entire markdown output, just output plain markdown.\`;

const payload = JSON.stringify({
  contents: [{ parts: [{ text: \`Perform a strict cold-read audit on the following file:\\n\\n\${numberedCode}\` }] }],
  systemInstruction: { parts: [{ text: systemPrompt }] },
  generationConfig: {
    temperature: 0.1,
  }
});

const options = {
  hostname: 'generativelanguage.googleapis.com',
  port: 443,
  path: \`/v1beta/models/gemini-2.5-flash:generateContent?key=\${API_KEY}\`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

console.log(\`🔍 Contacting Cold Auditor engine for '\${TARGET_FILE}'...\`);

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', async () => {
    try {
      const parsed = JSON.parse(data);
      if (res.statusCode !== 200) {
        console.error("❌ API Error:", parsed.error || parsed);
        process.exit(1);
      }
      
      const markdownText = parsed.candidates[0].content.parts[0].text;
      
      // Parse out the estimated score from the markdown for build checking
      const scoreMatch = markdownText.match(/Estimated Completeness Score:\\s*(\\d+)%/i) 
                      || markdownText.match(/Score:\\s*(\\d+)%/i)
                      || markdownText.match(/(\\d+)%\\s*completeness/i);
      
      const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null;
      console.log(\`\\n✅ Audit generated successfully!\`);
      if (score !== null) {
        console.log(\`📈 Evaluated Code Completeness: \${score}% (Required threshold: \${MIN_SCORE}%)\`);
      }
      
      // Write to output folder
      if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
      }
      
      const sanitizedName = path.basename(TARGET_FILE).replace(/[^a-zA-Z0-9]/g, '_');
      const outPath = path.join(OUT_DIR, \`cold_audit_\${sanitizedName}_\${Date.now()}.md\`);
      fs.writeFileSync(outPath, markdownText, 'utf8');
      console.log(\`💾 Audit report persisted to: \${outPath}\`);
      
      // Print report output to Action step summary
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdownText);
      }
      
      ${postPrComment ? `
      // Try posting pull request comment if event context exists
      const githubToken = process.env.GITHUB_TOKEN;
      const ghEventPath = process.env.GITHUB_EVENT_PATH;
      if (githubToken && ghEventPath) {
        try {
          const event = JSON.parse(fs.readFileSync(ghEventPath, 'utf8'));
          if (event.pull_request) {
            const commentsUrl = event.pull_request.comments_url;
            if (commentsUrl) {
              const urlObj = new URL(commentsUrl);
              const commentBody = JSON.stringify({
                body: \`🤖 **Cold-Read Code Auditor Report**\\n\\n\${markdownText}\`
              });
              
              const commentOptions = {
                hostname: urlObj.hostname,
                port: 443,
                path: urlObj.pathname,
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': 'VibeColdAuditor-Action',
                  'Authorization': \`Bearer \${githubToken}\`,
                  'Content-Length': Buffer.byteLength(commentBody)
                }
              };
              
              console.log("💬 Posting audit report comment to Pull Request...");
              const commentReq = https.request(commentOptions, (commentRes) => {
                let rData = '';
                commentRes.on('data', c => rData += c);
                commentRes.on('end', () => {
                  if (commentRes.statusCode === 201) {
                    console.log("💬 Comment posted successfully on GitHub Pull Request!");
                  } else {
                    console.warn("⚠️ Failed to post comment:", rData);
                  }
                });
              });
              commentReq.write(commentBody);
              commentReq.end();
            }
          }
        } catch (commentErr) {
          console.error("⚠️ Failed to attach comment to PR:", commentErr.message);
        }
      }
      ` : ""}
      
      // If score is too low, fail the check
      if (score !== null && score < MIN_SCORE) {
        console.error(\`\\n❌ BUILD CRITICAL FAULT: App completeness is evaluated at \dots%, which is below the acceptable threshold of \dots%.\`);
        process.exit(1);
      }
      
      console.log("\\n🚀 Verification complete. Code passes strict completeness threshold!");
      process.exit(0);
    } catch (e) {
      console.error("❌ Failed to parse response from Gemini:", e);
      process.exit(1);
    }
  });
});

req.on('error', (e) => {
  console.error(\`❌ Connection failure: \${e.message}\`);
  process.exit(1);
});

req.write(payload);
req.end();`;
}
