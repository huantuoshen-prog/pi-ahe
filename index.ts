/**
 * AHE Self-Improvement for pi — Main Entry Point
 *
 * Combines all three observability pillars from arXiv:2604.25850
 * into a unified self-improvement extension for pi.
 *
 * Pillar 1 (Component Observatory): Snapshot harness to files
 * Pillar 2 (Trajectory Distiller): Analyze sessions → evidence reports
 * Pillar 3 (Decision Logger): Every edit is a falsifiable prediction
 *
 * Auto-discovered by pi from: .pi/extensions/ahe/index.ts
 * Load with: /reload
 *
 * Based on: Lin et al., "Agentic Harness Engineering", arXiv:2604.25850
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTelemetry from "./telemetry";

// ── Sub-module registrations ──
// Each module registers its own tools, events, and commands.

import registerComponentObservatory from "./component-observatory";
import registerTrajectoryDistiller from "./trajectory-distiller";
import registerDecisionLogger from "./decision-logger";
import registerBenchmarkRunner from "./benchmark-runner";
import registerPythonMiddleware from "./python-middleware";
import registerBashPreflight from "./bash-preflight";
import registerImportGuard from "./import-guard";
import registerVerificationGuard from "./verification-guard";
import registerContextGuard from "./context-guard";
import registerPrewriteValidator from "./prewrite-validator";
import * as fs from "node:fs";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  // ── Telemetry (cross-module tracking) ──
  const telemetry = registerTelemetry(pi) as any;

  // ── Pillar 1: Component Observability ──
  registerComponentObservatory(pi);

  // ── Pillar 2: Experience / Trajectory Distiller ──
  registerTrajectoryDistiller(pi);

  // ── Pillar 3: Decision Logger ──
  registerDecisionLogger(pi);

  // ── Benchmark Runner (Verify phase) ──
  registerBenchmarkRunner(pi);

  // ── Evolved harness improvements ──
  // R1: Auto-syntax-check + dedicated py tool
  registerPythonMiddleware(pi);
  // R2: Bash command validation + error diagnosis
  registerBashPreflight(pi);
  // R3: Python import detection (missing module alerts)
  registerImportGuard(pi);
  // R4: Verification convergence — eliminate redundant re-verification
  registerVerificationGuard(pi);
  // R5: Efficient coding prompts — plan-first, verify-once injection
  registerPromptInjection(pi);
  // R6: Context window guard — auto-trim + proactive compaction warning
  registerContextGuard(pi);
  // R7: Pre-write validator — catch Python syntax errors before writing to disk
  registerPrewriteValidator(pi);

  // ── Cross-module telemetry hook ──
  // Count tool calls across all sessions for long-term tracking
  pi.on("tool_call", async (_event, _ctx) => {
    if (telemetry?.recordToolCall) telemetry.recordToolCall();
  });

  // ── Status command ──
  pi.registerCommand("ahe", {
    description: "Show AHE self-improvement system status",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget?.("ahe-status", [
        "━━━ AHE Self-Improvement System ━━━",
        "",
        "Based on: Agentic Harness Engineering (arXiv:2604.25850)",
        "",
        "Active Modules:",
        "  Pillar 1: Component Observatory   ✅",
        "  Pillar 2: Trajectory Distiller     ✅",
        "  Pillar 3: Decision Logger          ✅",
        "  Benchmark Runner                   ✅",
        "  Telemetry & Tracking               ✅",
        "",
        "Harness Improvements:",
        "  R1: Python auto-syntax-check + py  ✅",
        "  R2: Bash pre-flight validation     ✅",
        "  R3: Import guard (missing module)  ✅",
        "  R4: Verification convergence guard  ✅",
        "  R5: Efficient coding prompts        ✅",
        "  R6: Context window guard            ✅",
        "  R7: Pre-write code validator         ✅",
        "",
        "Commands:",
        "  /ahe                Show this status",
        "  /ahe:snapshot       Snapshot harness to .pi/harness/",
        "  /ahe:analyze        Analyze sessions → evidence",
        "  /ahe:decide          Log a harness edit decision",
        "  /ahe:verify          Verify pending predictions",
        "  /ahe:report          Full AHE health report",
        "  /ahe:bench           Run benchmark suite",
        "  /ahe:dashboard       Efficiency dashboard",
        "  /ahe:context         Show context window usage",
        "  /ahe:telemetry-on    Enable tracking (opt-in)",
        "  /ahe:telemetry-off   Disable tracking",
        "  /ahe:record-edit     Mark harness improvement",
        "",
        "Reports: .pi/harness/benchmarks/results/",
        "  AHE-Benchmark-Report.docx (full report)",
      ]);

      ctx.ui.notify?.("AHE loaded — 12 modules, 7 harness improvements active", "info");
    },
  });
}

// ── R5: Prompt Injection ─────────────────────────────────────────

function registerPromptInjection(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, _ctx) => {
    try {
      const promptPath = path.join(__dirname, "prompts", "efficient-coding.md");
      const efficientCodingGuide = fs.readFileSync(promptPath, "utf-8");
      if (event.systemPrompt) {
        event.systemPrompt = event.systemPrompt + "\n\n" + efficientCodingGuide;
      }
    } catch {
      // Silently skip if prompt file not found
    }
  });
}
