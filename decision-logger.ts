/**
 * AHE Self-Improvement for Pi — Decision Logger (Pillar 3)
 *
 * Pairs every harness edit with a self-declared prediction,
 * later verified against the next round's task-level outcomes.
 *
 * Core idea from arXiv:2604.25850:
 *   "decision observability pairs every edit with a self-declared prediction,
 *    later verified against the next round's task-level outcomes.
 *    Together, these pillars turn every edit into a falsifiable contract."
 *
 * What this module does:
 *   1. Records every harness edit with a prediction contract
 *   2. Tracks verification status (pending → verified / falsified)
 *   3. Maintains a decision chain showing which edits actually helped
 *   4. Provides tools for the Agent to log and verify predictions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────

interface PredictionContract {
  id: string;
  timestamp: string;
  component: string; // e.g., "bash_tool", "system_prompt", "compaction"
  editDescription: string; // What was changed
  prediction: string; // What we expect to happen
  verification: {
    metric: string; // e.g., "pass@1 on Terminal-Bench-2", "bash error rate"
    baseline: number; // Before value
    target: number; // Expected after value
    actual?: number; // Measured after value
    verifiedAt?: string;
  };
  status: "pending" | "verified" | "falsified" | "inconclusive";
  affectedFiles: string[];
  sessionIds: string[]; // Sessions that tested this prediction
  notes?: string;
}

interface DecisionLog {
  contracts: PredictionContract[];
  summary: {
    total: number;
    verified: number;
    falsified: number;
    pending: number;
    inconclusive: number;
    netPositiveChanges: number;
    successRate: number;
  };
}

// ─── Configuration ───────────────────────────────────────────────

const DECISIONS_DIR = path.join(".pi", "harness", "decisions");
const DECISION_LOG_FILE = path.join(DECISIONS_DIR, "decision-log.json");
const DECISION_CHAIN_FILE = path.join(DECISIONS_DIR, "decision-chain.md");

// ─── Helpers ─────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function generateId(): string {
  return `ahe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadDecisionLog(cwd: string): DecisionLog {
  const logFile = path.join(cwd, DECISION_LOG_FILE);
  if (fs.existsSync(logFile)) {
    try {
      return JSON.parse(fs.readFileSync(logFile, "utf-8"));
    } catch {
      // Corrupted, start fresh
    }
  }
  return {
    contracts: [],
    summary: {
      total: 0,
      verified: 0,
      falsified: 0,
      pending: 0,
      inconclusive: 0,
      netPositiveChanges: 0,
      successRate: 0,
    },
  };
}

function saveDecisionLog(cwd: string, log: DecisionLog): void {
  ensureDir(path.join(cwd, DECISIONS_DIR));
  fs.writeFileSync(
    path.join(cwd, DECISION_LOG_FILE),
    JSON.stringify(log, null, 2),
    "utf-8"
  );

  // Also write human-readable markdown chain
  generateDecisionChain(cwd, log);
}

function generateDecisionChain(cwd: string, log: DecisionLog): void {
  const lines: string[] = [];
  lines.push("# AHE Decision Chain");
  lines.push("");
  lines.push(
    `> Every edit is a falsifiable contract. Status summary: ${log.summary.verified} verified, ${log.summary.falsified} falsified, ${log.summary.pending} pending.`
  );
  lines.push("");
  lines.push("## Timeline");
  lines.push("");

  // Sort by timestamp, newest first
  const sorted = [...log.contracts].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  for (const contract of sorted) {
    const icon =
      contract.status === "verified"
        ? "✅"
        : contract.status === "falsified"
          ? "❌"
          : contract.status === "inconclusive"
            ? "❓"
            : "⏳";

    lines.push(`### ${icon} ${contract.component}: ${contract.editDescription}`);
    lines.push("");
    lines.push(`- **ID:** \`${contract.id}\``);
    lines.push(`- **Date:** ${contract.timestamp}`);
    lines.push(`- **Status:** ${contract.status}`);
    lines.push(`- **Prediction:** ${contract.prediction}`);
    lines.push(
      `- **Metric:** ${contract.verification.metric} (baseline: ${contract.verification.baseline}, target: ${contract.verification.target})`
    );

    if (contract.verification.actual !== undefined) {
      const delta = contract.verification.actual - contract.verification.baseline;
      const deltaStr = delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
      lines.push(
        `- **Actual:** ${contract.verification.actual} (Δ: ${deltaStr})`
      );
    }

    if (contract.affectedFiles.length > 0) {
      lines.push(
        `- **Files:** ${contract.affectedFiles.map((f) => `\`${f}\``).join(", ")}`
      );
    }

    if (contract.notes) {
      lines.push(`- **Notes:** ${contract.notes}`);
    }

    lines.push("");
  }

  if (sorted.length === 0) {
    lines.push("*No decisions recorded yet. Use `/ahe:decide` or `ahe_log_decision` tool to start.*");
  }

  fs.writeFileSync(
    path.join(cwd, DECISION_CHAIN_FILE),
    lines.join("\n"),
    "utf-8"
  );
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Lifecycle: ensure decisions workspace ──
  pi.on("session_start", async (_event, _ctx) => {
    // No special init needed; tools create the dir on demand
  });

  // ── Intercept harness edits to auto-log predictions ──
  // When the Agent edits extension/skill/prompt files via the edit tool,
  // we detect harness-relevant edits and prompt for a prediction.

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input = event.input as any;
    const filePath = input?.path || input?.file_path || input?.file || "";

    // Detect if this is a harness edit (modifying extensions, skills, prompts)
    const isHarnessEdit =
      filePath.includes(".pi/extensions/") ||
      filePath.includes(".pi/skills/") ||
      filePath.includes(".pi/prompts/") ||
      filePath.includes(".pi/settings.json") ||
      filePath.includes(".pi/harness/") ||
      filePath === "AGENTS.md" ||
      filePath === "CLAUDE.md";

    if (!isHarnessEdit) return;

    // Don't block the tool, but log the edit for later prediction
    // The Agent should call ahe_log_decision explicitly after editing
  });

  // ── Tool: log a decision ──
  pi.registerTool({
    name: "ahe_log_decision",
    label: "AHE Log Decision",
    description:
      "Record a harness edit decision with a testable prediction. Every edit becomes a falsifiable contract that will be verified against future task outcomes.",
    parameters: {
      type: "object",
      properties: {
        component: {
          type: "string",
          description:
            "Which harness component was edited (e.g., 'bash_tool', 'system_prompt', 'compaction', 'skill:pdf')",
        },
        editDescription: {
          type: "string",
          description:
            "Concise description of what was changed (e.g., 'Increased bash timeout from 120s to 300s')",
        },
        prediction: {
          type: "string",
          description:
            "What you predict will happen as a result (e.g., 'Long-running commands like pip install will no longer fail due to timeout')",
        },
        metric: {
          type: "string",
          description:
            "The measurable metric to verify against (e.g., 'bash error rate', 'pass@1 on project tasks', 'tokens per task')",
        },
        baseline: {
          type: "number",
          description: "The baseline value before this edit",
        },
        target: {
          type: "number",
          description: "The expected value after this edit",
        },
        affectedFiles: {
          type: "array",
          items: { type: "string" },
          description: "List of files modified by this edit",
        },
        notes: {
          type: "string",
          description: "Additional context or rationale",
        },
      },
      required: [
        "component",
        "editDescription",
        "prediction",
        "metric",
        "baseline",
        "target",
      ],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      ensureDir(path.join(cwd, DECISIONS_DIR));

      const contract: PredictionContract = {
        id: generateId(),
        timestamp: getTimestamp(),
        component: params.component,
        editDescription: params.editDescription,
        prediction: params.prediction,
        verification: {
          metric: params.metric,
          baseline: params.baseline,
          target: params.target,
        },
        status: "pending",
        affectedFiles: params.affectedFiles || [],
        sessionIds: [],
        notes: params.notes || undefined,
      };

      const log = loadDecisionLog(cwd);
      log.contracts.push(contract);
      updateSummary(log);
      saveDecisionLog(cwd, log);

      return {
        content: [
          {
            type: "text",
            text:
              `## 📝 Decision Logged\n\n` +
              `- **ID:** \`${contract.id}\`\n` +
              `- **Component:** ${contract.component}\n` +
              `- **Edit:** ${contract.editDescription}\n` +
              `- **Prediction:** ${contract.prediction}\n` +
              `- **Metric:** ${contract.verification.metric}\n` +
              `- **Baseline → Target:** ${contract.verification.baseline} → ${contract.verification.target}\n` +
              `- **Status:** ⏳ pending\n\n` +
              `After running tasks to test this change, use \`ahe_verify_decision\` to validate.\n` +
              `📋 View all decisions: \`.pi/harness/decisions/decision-chain.md\``,
          },
        ],
        details: { contractId: contract.id },
      };
    },
  });

  // ── Tool: verify a decision ──
  pi.registerTool({
    name: "ahe_verify_decision",
    label: "AHE Verify Decision",
    description:
      "Verify a previously logged prediction against actual task outcomes. Marks the decision as verified or falsified.",
    parameters: {
      type: "object",
      properties: {
        decisionId: {
          type: "string",
          description:
            "The ID of the decision to verify (use 'latest' for most recent pending decision)",
        },
        actualValue: {
          type: "number",
          description: "The actual measured value of the metric",
        },
        conclusion: {
          type: "string",
          enum: ["verified", "falsified", "inconclusive"],
          description:
            "Whether the prediction was confirmed, disproven, or inconclusive",
        },
        sessionId: {
          type: "string",
          description: "Optional: session ID where this was tested",
        },
      },
      required: ["actualValue", "conclusion"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const log = loadDecisionLog(cwd);

      let contract: PredictionContract | undefined;
      if (params.decisionId === "latest" || !params.decisionId) {
        // Find most recent pending decision
        const pending = log.contracts
          .filter((c) => c.status === "pending")
          .sort(
            (a, b) =>
              new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );
        contract = pending[0];
      } else {
        contract = log.contracts.find((c) => c.id === params.decisionId);
      }

      if (!contract) {
        return {
          content: [
            {
              type: "text",
              text: "No pending decision found to verify. Log a decision first with ahe_log_decision.",
            },
          ],
        };
      }

      // Update contract
      contract.status = params.conclusion;
      contract.verification.actual = params.actualValue;
      contract.verification.verifiedAt = getTimestamp();
      if (params.sessionId) {
        contract.sessionIds.push(params.sessionId);
      }

      updateSummary(log);
      saveDecisionLog(cwd, log);

      const delta =
        params.actualValue - contract.verification.baseline;
      const deltaStr = delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
      const icon =
        params.conclusion === "verified"
          ? "✅"
          : params.conclusion === "falsified"
            ? "❌"
            : "❓";

      return {
        content: [
          {
            type: "text",
            text:
              `## ${icon} Decision ${params.conclusion.toUpperCase()}\n\n` +
              `- **ID:** \`${contract.id}\`\n` +
              `- **Component:** ${contract.component}\n` +
              `- **Edit:** ${contract.editDescription}\n` +
              `- **Prediction:** ${contract.prediction}\n` +
              `- **Baseline:** ${contract.verification.baseline} → **Target:** ${contract.verification.target} → **Actual:** ${params.actualValue} (Δ: ${deltaStr})\n\n` +
              (params.conclusion === "verified"
                ? `✅ Prediction confirmed! This edit improved the harness.`
                : params.conclusion === "falsified"
                  ? `❌ Prediction was wrong. This edit did not help (or made things worse). Consider reverting.`
                  : `❓ Results inconclusive. More testing needed or metric is too noisy.`),
          },
        ],
        details: {
          contractId: contract.id,
          delta,
          status: params.conclusion,
        },
      };
    },
  });

  // ── Tool: view decision chain ──
  pi.registerTool({
    name: "ahe_view_decisions",
    label: "AHE View Decisions",
    description:
      "View the current decision chain: all harness edits, their predictions, and verification status.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all", "pending", "verified", "falsified", "recent"],
          description: "Filter decisions by status",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const log = loadDecisionLog(cwd);

      let contracts = log.contracts;
      if (params.filter === "pending")
        contracts = contracts.filter((c) => c.status === "pending");
      else if (params.filter === "verified")
        contracts = contracts.filter((c) => c.status === "verified");
      else if (params.filter === "falsified")
        contracts = contracts.filter((c) => c.status === "falsified");
      else if (params.filter === "recent") contracts = contracts.slice(-10);

      if (contracts.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `No decisions found${params.filter ? ` (filter: ${params.filter})` : ""}.\n\n` +
                `Use \`ahe_log_decision\` to start logging harness edit decisions.`,
            },
          ],
        };
      }

      const lines: string[] = [];
      lines.push(`# Decision Chain (${contracts.length} decisions)`);
      lines.push("");
      lines.push(
        `| Status | Component | Edit | Prediction | Baseline → Target → Actual |`
      );
      lines.push(
        `|--------|-----------|------|------------|-----------------------------|`
      );

      for (const c of contracts.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )) {
        const icon =
          c.status === "verified"
            ? "✅"
            : c.status === "falsified"
              ? "❌"
              : c.status === "inconclusive"
                ? "❓"
                : "⏳";
        const actual =
          c.verification.actual !== undefined
            ? ` → ${c.verification.actual}`
            : "";
        lines.push(
          `| ${icon} | ${c.component} | ${c.editDescription.slice(0, 50)} | ${c.prediction.slice(0, 50)} | ${c.verification.baseline} → ${c.verification.target}${actual} |`
        );
      }

      lines.push("");
      lines.push(
        `**Summary:** ${log.summary.total} total | ` +
          `${log.summary.verified} verified | ${log.summary.falsified} falsified | ` +
          `${log.summary.pending} pending | ${log.summary.inconclusive} inconclusive`
      );
      lines.push(
        `**Net positive changes:** ${log.summary.netPositiveChanges} | ` +
          `**Verification rate:** ${(log.summary.successRate * 100).toFixed(1)}%`
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: log.summary,
      };
    },
  });

  // ── Commands ──
  pi.registerCommand("ahe:decide", {
    description:
      "Log a harness edit decision (usage: /ahe:decide <component> <edit> <prediction>)",
    handler: async (args, ctx) => {
      ctx.ui.notify(
        "Use the ahe_log_decision tool via the Agent to log decisions with full metadata.",
        "info"
      );
      ctx.ui.notify(
        `Tip: ask the Agent: "Log a decision for ${args || 'the last edit'}"`,
        "info"
      );
    },
  });

  pi.registerCommand("ahe:verify", {
    description:
      "Verify previous predictions against actual outcomes",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const log = loadDecisionLog(cwd);
      const pending = log.contracts.filter((c) => c.status === "pending");

      if (pending.length === 0) {
        ctx.ui.notify("No pending decisions to verify.", "info");
        return;
      }

      ctx.ui.notify(
        `${pending.length} pending decisions. Run ahe_analyze_sessions first, then verify with ahe_verify_decision.`,
        "info"
      );

      // Show pending decisions
      const lines = pending.map(
        (c) =>
          `⏳ [${c.id.slice(-8)}] ${c.component}: ${c.editDescription.slice(0, 60)}`
      );
      ctx.ui.setWidget("ahe-pending", lines.slice(0, 10));
    },
  });

  pi.registerCommand("ahe:report", {
    description: "Show complete AHE harness health report",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const log = loadDecisionLog(cwd);

      // Also try to read evidence
      const evidenceFile = path.join(
        cwd,
        ".pi/harness/evidence/latest-report.json"
      );
      let evidenceStr = "No evidence report yet. Run ahe_analyze_sessions first.";
      if (fs.existsSync(evidenceFile)) {
        try {
          const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf-8"));
          evidenceStr =
            `${evidence.overallStats.totalTasks} tasks | ` +
            `${(evidence.overallStats.successRate * 100).toFixed(1)}% success | ` +
            `${evidence.failureClusters.length} failure patterns | ` +
            `${evidence.improvementSuggestions.length} suggestions`;
        } catch {
          // ignore
        }
      }

      const report = [
        "━━━ AHE Harness Health Report ━━━",
        "",
        `📊 Evidence: ${evidenceStr}`,
        `📝 Decisions: ${log.summary.total} total, ${log.summary.verified} verified, ${log.summary.falsified} falsified`,
        `🎯 Net positive changes: ${log.summary.netPositiveChanges}`,
        "",
        "📁 Reports:",
        "  .pi/harness/evidence/latest-report.json",
        "  .pi/harness/evidence/failure-clusters.md",
        "  .pi/harness/evidence/improvement-suggestions.md",
        "  .pi/harness/decisions/decision-chain.md",
        "  .pi/harness/system-prompt.md",
        "  .pi/harness/tools.json",
        "  .pi/harness/components.json",
        "",
        "🔄 Run a full AHE cycle:",
        '  1. Agent calls ahe_analyze_sessions',
        '  2. Agent reads evidence reports',
        '  3. Agent proposes and executes harness edits',
        '  4. Agent calls ahe_log_decision for each edit',
        "  5. Test the changes on real tasks",
        "  6. Agent calls ahe_verify_decision to validate",
      ];

      ctx.ui.setWidget("ahe-report", report);
      ctx.ui.notify("AHE report displayed in widget area", "info");
    },
  });

  pi.registerCommand("ahe:evolve", {
    description:
      "Run one complete AHE evolution cycle (analyze → decide → verify)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("🚀 Starting AHE evolution cycle...", "info");
      ctx.ui.notify(
        "Step 1: Agent should call ahe_analyze_sessions to identify issues",
        "info"
      );
      ctx.ui.notify(
        "Step 2: Agent reads evidence and proposes harness edits",
        "info"
      );
      ctx.ui.notify(
        "Step 3: Agent executes edits and calls ahe_log_decision",
        "info"
      );
      ctx.ui.notify(
        "Step 4: Test changes, then call ahe_verify_decision",
        "info"
      );

      // Queue a message to the Agent to start the cycle
      pi.sendUserMessage(
        "Run a full AHE evolution cycle: (1) call ahe_analyze_sessions to analyze recent sessions, " +
          "(2) read the evidence reports in .pi/harness/evidence/, " +
          "(3) propose specific harness edits based on the evidence, " +
          "(4) execute those edits and log each with ahe_log_decision including a testable prediction, " +
          "(5) tell me what tests to run to verify the predictions.",
        { deliverAs: "steer" }
      );
    },
  });
}

// ─── Summary Updater ─────────────────────────────────────────────

function updateSummary(log: DecisionLog): void {
  const contracts = log.contracts;
  log.summary.total = contracts.length;
  log.summary.verified = contracts.filter((c) => c.status === "verified").length;
  log.summary.falsified = contracts.filter((c) => c.status === "falsified").length;
  log.summary.pending = contracts.filter((c) => c.status === "pending").length;
  log.summary.inconclusive = contracts.filter(
    (c) => c.status === "inconclusive"
  ).length;

  // Net positive: verified count minus falsified count
  log.summary.netPositiveChanges =
    log.summary.verified - log.summary.falsified;

  // Verification success rate: verified / (verified + falsified)
  const tested = log.summary.verified + log.summary.falsified;
  log.summary.successRate = tested > 0 ? log.summary.verified / tested : 0;
}
