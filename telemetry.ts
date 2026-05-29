/**
 * AHE Telemetry & Tracking — Enhanced with Efficiency Monitoring
 *
 * Tracks per-task metrics to answer: "Does this harness make me more efficient?"
 *
 * ⚠️ PRIVACY: Telemetry is OFF by default.
 *    Enable with /ahe:telemetry-on or ahe_telemetry_toggle tool.
 *    When disabled, no task data is collected — only the enabled/disabled flag is stored.
 *    All data stays local in .pi/harness/telemetry/store.json. Nothing is sent anywhere.
 *
 * Features (when enabled):
 *   - Task categorization (bash, edit, debug, read/write, other)
 *   - Per-task metrics: tool calls, tokens, errors, wall time
 *   - Rolling 7-day / 30-day averages
 *   - Before/after harness-edit comparison
 *   - Efficiency trend dashboard
 *   - Cross-session persistence via pi.appendEntry()
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Telemetry Enabled Flag ──────────────────────────────────────
// Default: OFF. The user must explicitly opt in.
// Stored in the telemetry store so it persists across sessions.
const TELEMETRY_STATE_KEY = "ahe-telemetry-enabled";

// ─── Types ───────────────────────────────────────────────────────

type TaskCategory = "bash" | "edit" | "debug" | "readwrite" | "other";

interface TaskRecord {
  timestamp: string;       // ISO timestamp
  category: TaskCategory;  // Auto-classified
  promptPreview: string;   // First 80 chars of user prompt
  toolCalls: number;       // How many tool calls this task used
  tokens: number;          // Token consumption
  errors: number;          // How many tool errors occurred
  wallTimeMs: number;      // Wall clock duration
  outcome: "success" | "failure" | "unknown";
  harnessVersion: string;  // Which harness version was active
  sessionId: string;       // Which session
}

interface EfficiencySnapshot {
  timestamp: string;
  harnessVersion: string;
  period: "7d" | "30d" | "all";
  totalTasks: number;
  avgToolCalls: number;
  avgTokens: number;
  avgErrors: number;
  successRate: number;
  byCategory: Record<TaskCategory, {
    tasks: number;
    avgCalls: number;
    avgTokens: number;
  }>;
}

interface TelemetryStore {
  // Cumulative stats
  totalSessions: number;
  totalToolCalls: number;
  totalTokens: number;
  totalErrors: number;

  // Task-level records (last 200)
  taskRecords: TaskRecord[];

  // Efficiency snapshots (taken after each benchmark or harness edit)
  efficiencySnapshots: EfficiencySnapshot[];

  // Benchmark history
  benchmarkRuns: Array<{
    id: string; timestamp: string; harnessVersion: string;
    tasksRun: number; tasksPassed: number;
    avgToolCalls: number; avgTokens: number;
  }>;

  // Decision chain
  decisions: Array<{
    id: string; timestamp: string;
    status: "pending" | "verified" | "falsified" | "inconclusive";
    component: string; edit: string; prediction: string;
    baseline: number; target: number; actual?: number;
  }>;

  // Session log (last 50)
  recentSessions: Array<{
    timestamp: string; taskCount: number;
    toolCalls: number; tokens: number;
  }>;

  // Harness edit timeline (when each improvement was applied)
  harnessEdits: Array<{
    timestamp: string; version: string; description: string;
  }>;
}

const CUSTOM_TYPE = "ahe-telemetry";
const MAX_TASK_RECORDS = 200;
const MAX_SESSIONS = 50;
const MAX_BENCHMARKS = 50;
const MAX_DECISIONS = 100;

function emptyStore(): TelemetryStore {
  return {
    totalSessions: 0, totalToolCalls: 0, totalTokens: 0, totalErrors: 0,
    taskRecords: [], efficiencySnapshots: [], benchmarkRuns: [],
    decisions: [], recentSessions: [], harnessEdits: [],
  };
}

// ─── Auto-categorization ─────────────────────────────────────────

function classifyTask(prompt: string): TaskCategory {
  const lower = prompt.toLowerCase();
  if (/bash|shell|command|terminal|git|npm|pip|docker|curl|wget/.test(lower)) return "bash";
  if (/edit|fix|change|modify|update|refactor|rewrite|optimize/.test(lower)) return "edit";
  if (/debug|bug|error|crash|broken|wrong|fail|fix.*error/.test(lower)) return "debug";
  if (/create|write|generate|scaffold|build.*file|make.*file/.test(lower)) return "readwrite";
  return "other";
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let store: TelemetryStore = emptyStore();
  let enabled = false;  // OFF by default — must opt in

  // Per-task tracking state
  let currentTaskStart: number = 0;
  let currentTaskCalls: number = 0;
  let currentTaskTokens: number = 0;
  let currentTaskErrors: number = 0;
  let currentTaskPrompt: string = "";
  let currentHarnessVersion: string = "seed";

  // ── Restore persisted state ──
  pi.on("session_start", async (_event, ctx) => {
    // Reset per-task state
    currentTaskStart = 0;
    currentTaskCalls = 0;
    currentTaskTokens = 0;
    currentTaskErrors = 0;
    currentTaskPrompt = "";

    // Restore telemetry store
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
        try { store = entry.data as TelemetryStore; } catch { store = emptyStore(); }
      }
    }

    // Restore enabled/disabled state
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === TELEMETRY_STATE_KEY) {
        enabled = entry.data?.enabled === true;
      }
    }

    // If this is the first session ever, record the seed harness
    if (store.harnessEdits.length === 0) {
      store.harnessEdits.push({
        timestamp: new Date().toISOString(),
        version: "seed",
        description: "Initial harness (baseline, no AHE improvements)",
      });
    }

    // Notification about telemetry state
    if (enabled) {
      ctx.ui.notify?.("AHE telemetry: ACTIVE — tracking task efficiency", "info");
    } else {
      ctx.ui.notify?.("AHE telemetry: OFF — use /ahe:telemetry-on to enable", "info");
    }

    // Take an efficiency snapshot on session start (only if enabled)
  });

  // ── Detect new user prompt (start of a task) ──
  pi.on("message_start", async (event, _ctx) => {
    if (!enabled) return;
    const msg = (event as any).message || (event as any);
    if (msg.role !== "user") return;

    // Finalize previous task if one was in progress
    if (currentTaskPrompt && currentTaskCalls > 0) {
      finalizeTask();
    }

    // Start new task
    currentTaskStart = Date.now();
    currentTaskCalls = 0;
    currentTaskTokens = 0;
    currentTaskErrors = 0;
    currentTaskPrompt = msg.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ") || "";
  });

  // ── Count tool calls per task ──
  pi.on("tool_call", async (_event, _ctx) => {
    if (!enabled) return;
    currentTaskCalls++;
    store.totalToolCalls++;
  });

  // ── Count tokens ──
  pi.on("message_end", async (event, _ctx) => {
    if (!enabled) return;
    const usage = (event as any).message?.usage;
    if (usage?.totalTokens) {
      currentTaskTokens += usage.totalTokens;
      store.totalTokens += usage.totalTokens;
    }
  });

  // ── Count tool errors ──
  pi.on("tool_result", async (event, _ctx) => {
    if (!enabled) return;
    if (event.isError) {
      currentTaskErrors++;
      store.totalErrors++;
    }
  });

  // ── Finalize task on session shutdown ──
  pi.on("session_shutdown", async (_event, ctx) => {
    if (enabled && currentTaskPrompt && currentTaskCalls > 0) {
      finalizeTask();
    }

    if (enabled) {
      store.totalSessions++;
      store.recentSessions.push({
      timestamp: new Date().toISOString(),
      taskCount: store.taskRecords.filter(
        r => r.sessionId === ctx.sessionManager?.getSessionId()
      ).length,
      toolCalls: currentTaskCalls,
      tokens: currentTaskTokens,
    });
    if (store.recentSessions.length > MAX_SESSIONS) {
      store.recentSessions = store.recentSessions.slice(-MAX_SESSIONS);
    }

    pi.appendEntry(CUSTOM_TYPE, store);

    // Always save enabled state
    pi.appendEntry(TELEMETRY_STATE_KEY, { enabled });

    saveToDisk(ctx.cwd);
  });

  // ── Toggle telemetry on/off ──
  function setEnabled(val: boolean, ctx: any) {
    enabled = val;
    const label = val ? "ON — now tracking task efficiency" : "OFF — no data collected";
    ctx.ui?.notify?.(`AHE telemetry: ${label}`, val ? "info" : "info");
    // Persist immediately
    pi.appendEntry(TELEMETRY_STATE_KEY, { enabled });
  }

  pi.registerTool({
    name: "ahe_telemetry_toggle",
    label: "AHE Toggle Telemetry",
    description:
      "Turn AHE efficiency tracking ON or OFF. OFF by default — you must explicitly opt in. All data stays local.",
    parameters: {
      type: "object",
      properties: {
        enable: {
          type: "boolean",
          description: "true = turn ON, false = turn OFF",
        },
      },
      required: ["enable"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      setEnabled(params.enable, ctx);
      return {
        content: [{
          type: "text",
          text: enabled
            ? "✅ Telemetry ENABLED. Task efficiency is now being tracked.\n\n" +
              "- Each task is auto-categorized (bash/edit/debug/readwrite)\n" +
              "- Metrics: tool calls, tokens, errors, time\n" +
              "- Data stored locally in .pi/harness/telemetry/\n" +
              "- View with /ahe:dashboard or ahe_telemetry tool\n" +
              "- Turn off anytime with ahe_telemetry_toggle(enable: false)"
            : "⏸️ Telemetry DISABLED. No task data is being collected.\n\n" +
              "- Existing data is preserved but no new data is recorded\n" +
              "- Re-enable anytime with ahe_telemetry_toggle(enable: true)\n" +
              "- All data stays local — nothing is ever sent anywhere",
        }],
        details: { enabled },
      };
    },
  });

  pi.registerCommand("ahe:telemetry-on", {
    description: "Enable AHE efficiency tracking",
    handler: async (_args, ctx) => { setEnabled(true, ctx); },
  });

  pi.registerCommand("ahe:telemetry-off", {
    description: "Disable AHE efficiency tracking",
    handler: async (_args, ctx) => { setEnabled(false, ctx); },
  });

  // ── Tool: view efficiency dashboard ──
  pi.registerTool({
    name: "ahe_telemetry",
    label: "AHE Telemetry & Efficiency",
    description:
      "View efficiency tracking data: per-task metrics, trends over time, before/after harness edit comparison.",
    parameters: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["summary", "efficiency", "trends", "benchmarks", "decisions", "all"],
          description: "Dashboard view to show",
        },
        days: {
          type: "number",
          description: "Days to include in trends view (default: 30)",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const view = params.view || "summary";
      const days = params.days || 30;
      const lines: string[] = [];

      lines.push("# AHE Efficiency Tracking");
      lines.push("");
      lines.push(enabled
        ? "**Status: 🟢 ENABLED** — tracking task efficiency | `/ahe:telemetry-off` to disable"
        : "**Status: ⏸️ DISABLED** — no data collected | `/ahe:telemetry-on` to enable");
      lines.push("");
      lines.push("> All data stays local in `.pi/harness/telemetry/store.json`. Nothing is sent anywhere.");
      lines.push("");

      // ── SUMMARY ──
      if (view === "summary" || view === "all") {
        const tasks = store.taskRecords;
        const recent7d = tasks.filter(t => Date.now() - new Date(t.timestamp).getTime() < 7 * 86400000);
        const recent30d = tasks.filter(t => Date.now() - new Date(t.timestamp).getTime() < 30 * 86400000);

        lines.push("## Overview");
        lines.push("");
        lines.push("| Metric | All Time | Last 30d | Last 7d |");
        lines.push("|--------|----------|----------|---------|");
        lines.push(`| Sessions | ${store.totalSessions} | — | — |`);
        lines.push(`| Tasks tracked | ${tasks.length} | ${recent30d.length} | ${recent7d.length} |`);
        lines.push(`| Total tool calls | ${store.totalToolCalls.toLocaleString()} | ${recent30d.reduce((s,t)=>s+t.toolCalls,0).toLocaleString()} | ${recent7d.reduce((s,t)=>s+t.toolCalls,0).toLocaleString()} |`);
        lines.push(`| Avg calls/task | ${avgTasks(tasks).toFixed(1)} | ${avgTasks(recent30d).toFixed(1)} | ${avgTasks(recent7d).toFixed(1)} |`);
        lines.push(`| Avg tokens/task | ${avgTokens(tasks)} | ${avgTokens(recent30d)} | ${avgTokens(recent7d)} |`);
        lines.push(`| Error rate | ${errorRate(tasks).toFixed(1)}% | ${errorRate(recent30d).toFixed(1)}% | ${errorRate(recent7d).toFixed(1)}% |`);
        lines.push("");

        // Category breakdown
        lines.push("## By Task Category (All Time)");
        lines.push("");
        lines.push("| Category | Tasks | Avg Calls | Avg Tokens | Error Rate |");
        lines.push("|----------|-------|-----------|------------|------------|");
        for (const cat of ["bash","edit","debug","readwrite","other"] as TaskCategory[]) {
          const ct = tasks.filter(t => t.category === cat);
          if (ct.length === 0) continue;
          lines.push(`| ${cat} | ${ct.length} | ${avgTasks(ct).toFixed(1)} | ${avgTokens(ct)} | ${errorRate(ct).toFixed(1)}% |`);
        }
        lines.push("");
      }

      // ── EFFICIENCY: Before/After Comparison ──
      if (view === "efficiency" || view === "all") {
        lines.push("## Efficiency: Before vs After Harness Edits");
        lines.push("");

        const edits = store.harnessEdits;
        if (edits.length <= 1) {
          lines.push("*Only seed harness recorded. Efficiency comparison will appear after harness edits are applied.*");
        } else {
          for (let i = 1; i < edits.length; i++) {
            const prev = edits[i - 1];
            const curr = edits[i];
            const before = store.taskRecords.filter(t =>
              new Date(t.timestamp) >= new Date(prev.timestamp) &&
              new Date(t.timestamp) < new Date(curr.timestamp)
            );
            const after = store.taskRecords.filter(t =>
              new Date(t.timestamp) >= new Date(curr.timestamp) &&
              (i + 1 < edits.length
                ? new Date(t.timestamp) < new Date(edits[i + 1].timestamp)
                : true)
            );

            lines.push(`### ${curr.description}`);
            lines.push("");
            lines.push(`| Metric | Before (${before.length} tasks) | After (${after.length} tasks) | Change |`);
            lines.push(`|--------|-------------------------------|------------------------------|--------|`);

            const bAvg = before.length > 0 ? avgTasks(before) : 0;
            const aAvg = after.length > 0 ? avgTasks(after) : 0;
            const delta = bAvg > 0 ? ((aAvg - bAvg) / bAvg * 100) : 0;

            const trend = aAvg < bAvg ? "📈 better" : aAvg > bAvg ? "📉 worse" : "➡️ same";
            lines.push(`| Avg calls/task | ${bAvg.toFixed(1)} | ${aAvg.toFixed(1)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% ${trend} |`);

            const bTok = before.length > 0 ? Math.round(before.reduce((s,t)=>s+t.tokens,0)/before.length) : 0;
            const aTok = after.length > 0 ? Math.round(after.reduce((s,t)=>s+t.tokens,0)/after.length) : 0;
            const tokDelta = bTok > 0 ? ((aTok - bTok) / bTok * 100) : 0;
            const tokTrend = aTok < bTok ? "📈 better" : aTok > bTok ? "📉 worse" : "➡️ same";
            lines.push(`| Avg tokens/task | ${bTok.toLocaleString()} | ${aTok.toLocaleString()} | ${tokDelta >= 0 ? "+" : ""}${tokDelta.toFixed(1)}% ${tokTrend} |`);

            const bErr = before.length > 0 ? errorRate(before) : 0;
            const aErr = after.length > 0 ? errorRate(after) : 0;
            const errTrend = aErr < bErr ? "📈 better" : aErr > bErr ? "📉 worse" : "➡️ same";
            lines.push(`| Error rate | ${bErr.toFixed(1)}% | ${aErr.toFixed(1)}% | ${(aErr - bErr) >= 0 ? "+" : ""}${(aErr - bErr).toFixed(1)}pp ${errTrend} |`);

            lines.push("");
          }
        }
      }

      // ── TRENDS ──
      if (view === "trends" || view === "all") {
        const cutoff = Date.now() - days * 86400000;
        const recent = store.taskRecords.filter(t => new Date(t.timestamp).getTime() >= cutoff);

        lines.push(`## ${days}-Day Trend`);
        lines.push("");

        if (recent.length < 5) {
          lines.push(`*Need at least 5 tasks in the last ${days} days. Currently: ${recent.length}.*`);
        } else {
          // Group by day
          const byDay: Record<string, TaskRecord[]> = {};
          for (const t of recent) {
            const day = t.timestamp.slice(0, 10);
            if (!byDay[day]) byDay[day] = [];
            byDay[day].push(t);
          }

          lines.push("| Date | Tasks | Avg Calls | Avg Tokens | Trend |");
          lines.push("|------|-------|-----------|------------|-------|");

          const days_list = Object.keys(byDay).sort();
          let prevAvg = 0;
          for (const day of days_list) {
            const tasks = byDay[day];
            const avg = avgTasks(tasks);
            const trendIcon = prevAvg === 0 ? "—" : avg < prevAvg ? "📈" : avg > prevAvg ? "📉" : "➡️";
            lines.push(`| ${day} | ${tasks.length} | ${avg.toFixed(1)} | ${Math.round(tasks.reduce((s,t)=>s+t.tokens,0)/tasks.length).toLocaleString()} | ${trendIcon} |`);
            prevAvg = avg;
          }

          // Overall trend line
          const firstHalf = recent.slice(0, Math.floor(recent.length / 2));
          const secondHalf = recent.slice(Math.floor(recent.length / 2));
          const fhAvg = avgTasks(firstHalf);
          const shAvg = avgTasks(secondHalf);
          const overallDelta = fhAvg > 0 ? ((shAvg - fhAvg) / fhAvg * 100) : 0;

          lines.push("");
          lines.push(`**Overall trend:** First half avg: ${fhAvg.toFixed(1)} calls → Second half avg: ${shAvg.toFixed(1)} calls (${overallDelta >= 0 ? "+" : ""}${overallDelta.toFixed(1)}%)`);
          lines.push(overallDelta < -5 ? "✅ Getting more efficient!" : overallDelta > 5 ? "⚠️ Getting less efficient — check recent harness edits." : "➡️ Stable.");
        }
        lines.push("");
      }

      // ── BENCHMARKS ──
      if (view === "benchmarks" || view === "all") {
        lines.push("## Benchmark Runs");
        lines.push("");
        if (store.benchmarkRuns.length === 0) {
          lines.push("*No benchmarks yet.*");
        } else {
          lines.push("| # | Version | Tasks | Pass | Calls/Task | Tokens/Task |");
          lines.push("|---|---------|-------|------|------------|-------------|");
          for (const r of store.benchmarkRuns.slice(-10).reverse()) {
            lines.push(`| ${r.id.slice(-6)} | ${r.harnessVersion} | ${r.tasksRun} | ${r.tasksPassed} | ${r.avgToolCalls.toFixed(1)} | ${Math.round(r.avgTokens).toLocaleString()} |`);
          }
        }
        lines.push("");
      }

      // ── DECISIONS ──
      if (view === "decisions" || view === "all") {
        lines.push("## Decision Chain");
        lines.push("");
        const verified = store.decisions.filter(d => d.status === "verified").length;
        const falsified = store.decisions.filter(d => d.status === "falsified").length;
        const pending = store.decisions.filter(d => d.status === "pending").length;
        lines.push(`**${verified} verified | ${falsified} falsified | ${pending} pending**`);
        lines.push("");
      }

      lines.push("---");
      lines.push(`*Tracking ${store.taskRecords.length} tasks across ${store.totalSessions} sessions. Data persists across /reload and restarts.*`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          tasks: store.taskRecords.length,
          sessions: store.totalSessions,
          harnessEdits: store.harnessEdits.length,
        },
      };
    },
  });

  // ── Command: /ahe:dashboard ──
  pi.registerCommand("ahe:dashboard", {
    description: "Efficiency dashboard with before/after comparison",
    handler: async (_args, ctx) => {
      const tasks = store.taskRecords;
      const recent = tasks.slice(-50);
      const avg = avgTasks(tasks);
      const recentAvg = recent.length > 0 ? avgTasks(recent) : 0;
      const trend = avg > 0 ? ((recentAvg - avg) / avg * 100) : 0;

      const verified = store.decisions.filter(d => d.status === "verified").length;
      const falsified = store.decisions.filter(d => d.status === "falsified").length;

      // Category breakdown (last 50 tasks)
      const catBreakdown: string[] = [];
      for (const cat of ["bash","edit","debug","readwrite","other"] as TaskCategory[]) {
        const ct = recent.filter(t => t.category === cat);
        if (ct.length > 0) catBreakdown.push(`${cat}: ${ct.length}`);
      }

      ctx.ui.setWidget?.("ahe-dashboard", [
        "━━━ AHE Efficiency Dashboard ━━━",
        "",
        enabled
          ? "🟢 Telemetry: ACTIVE — tracking efficiency"
          : "⏸️ Telemetry: OFF — /ahe:telemetry-on to enable",
        "",
        `📊 Tasks: ${tasks.length} total | ${recent.length} recent`,
        `🔧 Avg calls/task: ${avg.toFixed(1)} (recent: ${recentAvg.toFixed(1)}, ${trend >= 0 ? "+" : ""}${trend.toFixed(1)}%)`,
        `💰 Total tokens: ${store.totalTokens.toLocaleString()}`,
        `⚠️ Error rate: ${errorRate(tasks).toFixed(1)}%`,
        "",
        `📂 Recent categories: ${catBreakdown.join(" | ") || "none yet"}`,
        "",
        `📝 Decisions: ${verified} verified, ${falsified} falsified`,
        `🏗️ Harness edits: ${store.harnessEdits.length}`,
        "",
        store.harnessEdits.length > 1
          ? `✅ Efficiency tracking active — compare before/after with /ahe:dashboard`
          : `⏳ Run benchmarks or edit harness to see before/after comparison.`,
      ]);

      ctx.ui.notify?.(
        `AHE: ${tasks.length} tasks tracked | ${avg.toFixed(1)} calls/task avg`,
        "info"
      );
    },
  });

  // ── Command: record a harness edit ──
  pi.registerCommand("ahe:record-edit", {
    description: "Record that a harness improvement was applied (for before/after tracking)",
    handler: async (args, ctx) => {
      const desc = args || "Harness edit";
      store.harnessEdits.push({
        timestamp: new Date().toISOString(),
        version: `evolved-${store.harnessEdits.length}`,
        description: desc,
      });

      // Take an efficiency snapshot at this point
      takeSnapshot("all");

      ctx.ui.notify?.(
        `Recorded: "${desc}" as version ${store.harnessEdits[store.harnessEdits.length - 1].version}`,
        "info"
      );
    },
  });

  // ── Helpers ──────────────────────────────────────────────────

  function finalizeTask() {
    const task: TaskRecord = {
      timestamp: new Date().toISOString(),
      category: classifyTask(currentTaskPrompt),
      promptPreview: currentTaskPrompt.slice(0, 80),
      toolCalls: currentTaskCalls,
      tokens: currentTaskTokens,
      errors: currentTaskErrors,
      wallTimeMs: Date.now() - currentTaskStart,
      outcome: currentTaskErrors === 0 ? "success" : "failure",
      harnessVersion: currentHarnessVersion,
      sessionId: "",
    };

    store.taskRecords.push(task);
    if (store.taskRecords.length > MAX_TASK_RECORDS) {
      store.taskRecords = store.taskRecords.slice(-MAX_TASK_RECORDS);
    }
  }

  function takeSnapshot(period: "7d" | "30d" | "all") {
    const cutoff = period === "7d" ? 7 * 86400000 : period === "30d" ? 30 * 86400000 : 0;
    const tasks = cutoff > 0
      ? store.taskRecords.filter(t => Date.now() - new Date(t.timestamp).getTime() < cutoff)
      : store.taskRecords;

    const byCategory: Record<TaskCategory, { tasks: number; avgCalls: number; avgTokens: number }> = {
      bash: { tasks: 0, avgCalls: 0, avgTokens: 0 },
      edit: { tasks: 0, avgCalls: 0, avgTokens: 0 },
      debug: { tasks: 0, avgCalls: 0, avgTokens: 0 },
      readwrite: { tasks: 0, avgCalls: 0, avgTokens: 0 },
      other: { tasks: 0, avgCalls: 0, avgTokens: 0 },
    };

    for (const cat of Object.keys(byCategory) as TaskCategory[]) {
      const ct = tasks.filter(t => t.category === cat);
      byCategory[cat] = {
        tasks: ct.length,
        avgCalls: avgTasks(ct),
        avgTokens: ct.length > 0 ? Math.round(ct.reduce((s,t)=>s+t.tokens,0)/ct.length) : 0,
      };
    }

    store.efficiencySnapshots.push({
      timestamp: new Date().toISOString(),
      harnessVersion: currentHarnessVersion,
      period,
      totalTasks: tasks.length,
      avgToolCalls: avgTasks(tasks),
      avgTokens: tasks.length > 0 ? Math.round(tasks.reduce((s,t)=>s+t.tokens,0)/tasks.length) : 0,
      avgErrors: tasks.length > 0 ? tasks.reduce((s,t)=>s+t.errors,0)/tasks.length : 0,
      successRate: tasks.length > 0 ? tasks.filter(t => t.outcome === "success").length / tasks.length : 0,
      byCategory,
    });
    if (store.efficiencySnapshots.length > 50) {
      store.efficiencySnapshots = store.efficiencySnapshots.slice(-50);
    }
  }

  function saveToDisk(cwd: string) {
    try {
      const dir = path.join(cwd, ".pi", "harness", "telemetry");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify(store, null, 2), "utf-8");
    } catch {}
  }

  // ── Export helpers ───────────────────────────────────────────
  return {
    getStore: () => store,
    recordBenchmark: (run: TelemetryStore["benchmarkRuns"][0]) => {
      store.benchmarkRuns.push(run);
      if (store.benchmarkRuns.length > MAX_BENCHMARKS) store.benchmarkRuns = store.benchmarkRuns.slice(-MAX_BENCHMARKS);
    },
    recordDecision: (d: TelemetryStore["decisions"][0]) => {
      store.decisions.push(d);
      if (store.decisions.length > MAX_DECISIONS) store.decisions = store.decisions.slice(-MAX_DECISIONS);
    },
    recordHarnessEdit: (desc: string) => {
      currentHarnessVersion = `evolved-${store.harnessEdits.length}`;
      store.harnessEdits.push({
        timestamp: new Date().toISOString(),
        version: currentHarnessVersion,
        description: desc,
      });
      takeSnapshot("all");
    },
  };
}

// ─── Utility functions ───────────────────────────────────────────

function avgTasks(tasks: TaskRecord[]): number {
  return tasks.length > 0
    ? tasks.reduce((s, t) => s + t.toolCalls, 0) / tasks.length
    : 0;
}

function avgTokens(tasks: TaskRecord[]): string {
  return tasks.length > 0
    ? Math.round(tasks.reduce((s, t) => s + t.tokens, 0) / tasks.length).toLocaleString()
    : "—";
}

function errorRate(tasks: TaskRecord[]): number {
  return tasks.length > 0
    ? tasks.filter(t => t.outcome === "failure").length / tasks.length * 100
    : 0;
}
