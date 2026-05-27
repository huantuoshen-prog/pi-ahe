/**
 * AHE Telemetry & Tracking Module
 *
 * Persists all AHE data across pi sessions via pi.appendEntry():
 *   - Harness snapshots (component hashes)
 *   - Benchmark runs (before/after per task)
 *   - Decision contracts (edit + prediction + verification)
 *   - Session summaries (tokens, tools, errors)
 *
 * Survives pi restarts and /reload — restored via session_start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Telemetry Store ─────────────────────────────────────────────

interface TelemetryStore {
  // Cumulative stats
  totalSessions: number;
  totalTasks: number;
  totalToolCalls: number;
  totalTokens: number;
  totalErrors: number;

  // Benchmark history
  benchmarkRuns: Array<{
    id: string;
    timestamp: string;
    harnessVersion: string;
    tasksRun: number;
    tasksPassed: number;
    avgToolCalls: number;
    avgTokens: number;
  }>;

  // Decision chain
  decisions: Array<{
    id: string;
    timestamp: string;
    status: "pending" | "verified" | "falsified" | "inconclusive";
    component: string;
    edit: string;
    prediction: string;
    baseline: number;
    target: number;
    actual?: number;
  }>;

  // Session log (last 50)
  recentSessions: Array<{
    timestamp: string;
    taskCount: number;
    toolCalls: number;
    tokens: number;
  }>;
}

const CUSTOM_TYPE = "ahe-telemetry";

function emptyStore(): TelemetryStore {
  return {
    totalSessions: 0,
    totalTasks: 0,
    totalToolCalls: 0,
    totalTokens: 0,
    totalErrors: 0,
    benchmarkRuns: [],
    decisions: [],
    recentSessions: [],
  };
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let store: TelemetryStore = emptyStore();
  let currentSessionToolCalls = 0;
  let currentSessionTokens = 0;
  let currentSessionTasks = 0;

  // ── Restore persisted state on reload ──
  pi.on("session_start", async (_event, ctx) => {
    currentSessionToolCalls = 0;
    currentSessionTokens = 0;
    currentSessionTasks = 0;

    // Restore telemetry from previous sessions
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
        try {
          store = entry.data as TelemetryStore;
        } catch {
          store = emptyStore();
        }
      }
    }

    ctx.ui.notify?.(
      `AHE telemetry: ${store.totalSessions} sessions, ${store.totalToolCalls} tool calls tracked`,
      "info"
    );
  });

  // ── Count tool calls ──
  pi.on("tool_call", async (_event, _ctx) => {
    currentSessionToolCalls++;
  });

  // ── Count token usage ──
  pi.on("model_response", async (event, _ctx) => {
    // Approximate from usage if available
    const usage = (event as any).usage;
    if (usage?.totalTokens) {
      currentSessionTokens += usage.totalTokens;
    }
  });

  // ── Save session stats on shutdown ──
  pi.on("session_shutdown", async (_event, ctx) => {
    store.totalSessions++;
    store.totalToolCalls += currentSessionToolCalls;
    store.totalTokens += currentSessionTokens;

    store.recentSessions.push({
      timestamp: new Date().toISOString(),
      taskCount: currentSessionTasks,
      toolCalls: currentSessionToolCalls,
      tokens: currentSessionTokens,
    });

    // Keep only last 50 sessions
    if (store.recentSessions.length > 50) {
      store.recentSessions = store.recentSessions.slice(-50);
    }

    // Persist
    pi.appendEntry(CUSTOM_TYPE, store);

    // Also write to disk as backup
    try {
      const aheDir = path.join(ctx.cwd, ".pi", "harness", "telemetry");
      fs.mkdirSync(aheDir, { recursive: true });
      fs.writeFileSync(
        path.join(aheDir, "store.json"),
        JSON.stringify(store, null, 2),
        "utf-8"
      );
    } catch {}
  });

  // ── Tool: view telemetry dashboard ──
  pi.registerTool({
    name: "ahe_telemetry",
    label: "AHE Telemetry",
    description:
      "View cumulative AHE tracking data: sessions, tool calls, token usage, benchmark history, and decision chain.",
    parameters: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["summary", "benchmarks", "decisions", "all"],
          description: "Which view to show",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const view = params.view || "summary";
      const lines: string[] = [];

      lines.push("# AHE Telemetry Dashboard");
      lines.push("");

      if (view === "summary" || view === "all") {
        lines.push("## Cumulative Stats");
        lines.push("");
        lines.push(`| Metric | Value |`);
        lines.push(`|--------|-------|`);
        lines.push(`| Total sessions | ${store.totalSessions} |`);
        lines.push(`| Total tool calls | ${store.totalToolCalls.toLocaleString()} |`);
        lines.push(`| Total tokens | ${store.totalTokens.toLocaleString()} |`);
        lines.push(`| Total errors | ${store.totalErrors} |`);
        lines.push(`| Current session calls | ${currentSessionToolCalls} |`);
        lines.push("");

        if (store.recentSessions.length > 0) {
          lines.push("## Recent Sessions");
          lines.push("");
          lines.push("| # | Time | Tasks | Calls | Tokens |");
          lines.push("|---|------|-------|-------|--------|");
          const recent = store.recentSessions.slice(-10).reverse();
          for (let i = 0; i < recent.length; i++) {
            const s = recent[i];
            lines.push(
              `| ${i + 1} | ${s.timestamp.slice(11, 19)} | ${s.taskCount} | ${s.toolCalls} | ${s.tokens.toLocaleString()} |`
            );
          }
          lines.push("");
        }
      }

      if (view === "benchmarks" || view === "all") {
        lines.push("## Benchmark History");
        lines.push("");
        if (store.benchmarkRuns.length === 0) {
          lines.push("*No benchmark runs yet. Use ahe_bench_run to start.*");
        } else {
          lines.push("| # | Version | Tasks | Passed | Avg Calls | Avg Tokens |");
          lines.push("|---|---------|-------|--------|-----------|------------|");
          for (const run of store.benchmarkRuns.slice(-10).reverse()) {
            const rate = run.tasksRun > 0 ? (run.tasksPassed / run.tasksRun * 100).toFixed(0) : "0";
            lines.push(
              `| ${run.id.slice(-8)} | ${run.harnessVersion} | ${run.tasksRun} | ${run.tasksPassed} (${rate}%) | ${run.avgToolCalls.toFixed(1)} | ${Math.round(run.avgTokens).toLocaleString()} |`
            );
          }
        }
        lines.push("");
      }

      if (view === "decisions" || view === "all") {
        lines.push("## Decision Chain");
        lines.push("");
        if (store.decisions.length === 0) {
          lines.push("*No decisions logged yet. Use ahe_log_decision to start.*");
        } else {
          const pending = store.decisions.filter((d) => d.status === "pending").length;
          const verified = store.decisions.filter((d) => d.status === "verified").length;
          const falsified = store.decisions.filter((d) => d.status === "falsified").length;
          lines.push(`**Status:** ${verified} verified | ${falsified} falsified | ${pending} pending`);
          lines.push("");
          lines.push("| Status | Component | Edit | Prediction | Result |");
          lines.push("|--------|-----------|------|------------|--------|");
          for (const d of store.decisions.slice(-15).reverse()) {
            const icon = d.status === "verified" ? "✅" : d.status === "falsified" ? "❌" : d.status === "pending" ? "⏳" : "❓";
            const result = d.actual !== undefined
              ? `${d.baseline}→${d.actual} (target: ${d.target})`
              : `pending (target: ${d.target})`;
            lines.push(
              `| ${icon} | ${d.component} | ${d.edit.slice(0, 40)} | ${d.prediction.slice(0, 40)} | ${result} |`
            );
          }
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          sessions: store.totalSessions,
          toolCalls: store.totalToolCalls,
          decisions: store.decisions.length,
          benchmarks: store.benchmarkRuns.length,
        },
      };
    },
  });

  // ── Command: /ahe:dashboard ──
  pi.registerCommand("ahe:dashboard", {
    description: "Show AHE telemetry dashboard",
    handler: async (_args, ctx) => {
      const verified = store.decisions.filter((d) => d.status === "verified").length;
      const total = store.decisions.length;

      ctx.ui.setWidget?.("ahe-telemetry", [
        "━━━ AHE Tracking Active ━━━",
        "",
        `Sessions: ${store.totalSessions}`,
        `Tool calls: ${store.totalToolCalls.toLocaleString()}`,
        `Tokens: ${store.totalTokens.toLocaleString()}`,
        `Benchmarks: ${store.benchmarkRuns.length} runs`,
        `Decisions: ${verified}/${total} verified`,
        "",
        `Current session: ${currentSessionToolCalls} calls`,
        "",
        "Data persists across /reload and restarts.",
      ]);

      ctx.ui.notify?.(
        `AHE tracking: ${store.totalSessions} sessions, ${store.totalToolCalls.toLocaleString()} calls`,
        "info"
      );
    },
  });

  // ── Export helpers for other AHE modules ──
  return {
    getStore: () => store,
    recordBenchmark: (run: TelemetryStore["benchmarkRuns"][0]) => {
      store.benchmarkRuns.push(run);
      if (store.benchmarkRuns.length > 50) {
        store.benchmarkRuns = store.benchmarkRuns.slice(-50);
      }
    },
    recordDecision: (d: TelemetryStore["decisions"][0]) => {
      store.decisions.push(d);
      if (store.decisions.length > 100) {
        store.decisions = store.decisions.slice(-100);
      }
    },
    recordTask: () => {
      currentSessionTasks++;
    },
    recordError: () => {
      store.totalErrors++;
    },
  };
}
