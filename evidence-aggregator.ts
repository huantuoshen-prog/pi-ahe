/**
 * AHE Evolution #10 — Cross-Session Evidence Accumulator
 *
 * Closes the AHE outer loop by accumulating evidence across sessions.
 * Each session produces a compact "session card" at shutdown. The
 * accumulator analyzes cards across sessions to:
 *
 * 1. Track efficiency trends (tool calls, tokens, errors over time)
 * 2. Auto-detect which harness edits moved the needle
 * 3. Flag regressions for investigation
 * 4. Generate a harness health report
 *
 * This is the final piece: Explore → Debug → Evolve → Verify → Learn → Repeat
 *
 * Prediction: Cross-session evidence will make the AHE loop self-sustaining
 * by automatically surfacing patterns that would otherwise require manual
 * analysis of session traces.
 *
 * Metric: time to detect a harness regression
 * Baseline: manual (reading session logs)
 * Target: automatic (tool output flags it immediately)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────

interface SessionCard {
  timestamp: string;
  sessionId: string;
  taskCount: number;
  toolCalls: number;
  tokensUsed: number;
  errors: number;
  harnessVersion: string;
  activeModules: string[];
}

interface CrossSessionReport {
  generatedAt: string;
  totalSessions: number;
  totalTasks: number;
  totalToolCalls: number;
  totalTokens: number;
  trends: {
    toolCalls: TrendPoint[];
    tokens: TrendPoint[];
    errors: TrendPoint[];
  };
  moduleImpact: ModuleImpact[];
  suggestions: string[];
}

interface TrendPoint {
  label: string;
  value: number;
  timestamp: string;
}

interface ModuleImpact {
  module: string;
  sessionsBefore: number;
  sessionsAfter: number;
  avgCallsBefore: number;
  avgCallsAfter: number;
  delta: number;
  verdict: "improvement" | "regression" | "neutral";
}

// ─── Configuration ──────────────────────────────────────────────

const EVIDENCE_DIR = path.join(".pi", "harness", "evidence");
const CARDS_DIR = path.join(EVIDENCE_DIR, "sessions");
const REPORT_FILE = path.join(EVIDENCE_DIR, "cross-session-report.json");

// ─── Persistence ──────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveCard(cwd: string, card: SessionCard): void {
  const dir = path.join(cwd, CARDS_DIR);
  ensureDir(dir);
  const file = path.join(dir, `session-${card.sessionId.slice(0, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(card, null, 2), "utf-8");
}

function loadCards(cwd: string): SessionCard[] {
  const dir = path.join(cwd, CARDS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean) as SessionCard[];
}

// ─── Analysis ─────────────────────────────────────────────────────

function analyzeCrossSession(cards: SessionCard[]): CrossSessionReport {
  cards.sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const totalToolCalls = cards.reduce((s, c) => s + c.toolCalls, 0);
  const totalTokens = cards.reduce((s, c) => s + c.tokensUsed, 0);
  const totalTasks = cards.reduce((s, c) => s + c.taskCount, 0);

  // Trend points (one per session)
  const toolCallTrend: TrendPoint[] = cards.map((c) => ({
    label: c.timestamp.slice(0, 16).replace("T", " "),
    value: c.taskCount > 0 ? c.toolCalls / c.taskCount : 0,
    timestamp: c.timestamp,
  }));

  const tokenTrend: TrendPoint[] = cards.map((c) => ({
    label: c.timestamp.slice(0, 16).replace("T", " "),
    value: c.taskCount > 0 ? Math.round(c.tokensUsed / c.taskCount) : 0,
    timestamp: c.timestamp,
  }));

  const errorTrend: TrendPoint[] = cards.map((c) => ({
    label: c.timestamp.slice(0, 16).replace("T", " "),
    value: c.errors,
    timestamp: c.timestamp,
  }));

  // Module impact analysis
  const moduleImpact = analyzeModuleImpact(cards);

  // Suggestions
  const suggestions = generateSuggestions(
    cards,
    toolCallTrend,
    moduleImpact
  );

  return {
    generatedAt: new Date().toISOString(),
    totalSessions: cards.length,
    totalTasks,
    totalToolCalls,
    totalTokens,
    trends: {
      toolCalls: toolCallTrend,
      tokens: tokenTrend,
      errors: errorTrend,
    },
    moduleImpact,
    suggestions,
  };
}

function analyzeModuleImpact(cards: SessionCard[]): ModuleImpact[] {
  const allModules = new Set<string>();
  for (const card of cards) {
    for (const mod of card.activeModules) {
      allModules.add(mod);
    }
  }

  const impacts: ModuleImpact[] = [];
  for (const mod of allModules) {
    const before = cards.filter((c) => !c.activeModules.includes(mod));
    const after = cards.filter((c) => c.activeModules.includes(mod));

    if (before.length === 0 || after.length === 0) {
      impacts.push({
        module: mod,
        sessionsBefore: before.length,
        sessionsAfter: after.length,
        avgCallsBefore: 0,
        avgCallsAfter: 0,
        delta: 0,
        verdict: "neutral",
      });
      continue;
    }

    const avgBefore =
      before.reduce((s, c) => s + (c.taskCount > 0 ? c.toolCalls / c.taskCount : 0), 0) /
      before.length;
    const avgAfter =
      after.reduce((s, c) => s + (c.taskCount > 0 ? c.toolCalls / c.taskCount : 0), 0) /
      after.length;
    const delta = avgAfter - avgBefore;

    let verdict: ModuleImpact["verdict"] = "neutral";
    if (delta < -0.5) verdict = "improvement";
    else if (delta > 0.5) verdict = "regression";

    impacts.push({
      module: mod,
      sessionsBefore: before.length,
      sessionsAfter: after.length,
      avgCallsBefore: avgBefore,
      avgCallsAfter: avgAfter,
      delta,
      verdict,
    });
  }

  return impacts.sort((a, b) => a.delta - b.delta); // Improvements first
}

function generateSuggestions(
  cards: SessionCard[],
  trend: TrendPoint[],
  impacts: ModuleImpact[]
): string[] {
  const suggestions: string[] = [];

  // Trend direction
  if (trend.length >= 3) {
    const first3 = trend.slice(0, 3);
    const last3 = trend.slice(-3);
    const firstAvg = first3.reduce((s, p) => s + p.value, 0) / first3.length;
    const lastAvg = last3.reduce((s, p) => s + p.value, 0) / last3.length;
    const delta = lastAvg - firstAvg;

    if (delta < -1) {
      suggestions.push(`Efficiency improving: avg tool calls per task down by ${Math.abs(delta).toFixed(1)} (${((Math.abs(delta) / Math.max(firstAvg, 0.1)) * 100).toFixed(0)}% better). Keep current harness.`);
    } else if (delta > 1) {
      suggestions.push(`Efficiency declining: avg tool calls per task up by ${delta.toFixed(1)}. Review recent harness edits — one may be causing regression.`);
    } else {
      suggestions.push("Efficiency stable. No significant trend detected.");
    }
  }

  // Module winners/losers
  const winners = impacts.filter((i) => i.verdict === "improvement");
  const losers = impacts.filter((i) => i.verdict === "regression");

  for (const w of winners) {
    suggestions.push(
      `Module "${w.module}" shows improvement: ${w.avgCallsBefore.toFixed(1)} → ${w.avgCallsAfter.toFixed(1)} calls/task (${((Math.abs(w.delta) / Math.max(w.avgCallsBefore, 0.1)) * 100).toFixed(0)}% better across ${w.sessionsAfter} sessions).`
    );
  }

  for (const l of losers) {
    suggestions.push(
      `Module "${l.module}" shows regression: ${l.avgCallsBefore.toFixed(1)} → ${l.avgCallsAfter.toFixed(1)} calls/task. Consider reverting or tuning.`
    );
  }

  if (cards.length < 3) {
    suggestions.push(
      `Only ${cards.length} sessions recorded. Collect at least 5-10 sessions for reliable cross-session analysis.`
    );
  }

  return suggestions;
}

// ─── Formatting ───────────────────────────────────────────────────

function formatReport(report: CrossSessionReport): string {
  const lines: string[] = [
    "# Cross-Session Harness Health Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Sessions: ${report.totalSessions} | Tasks: ${report.totalTasks} | ` +
      `Tool Calls: ${report.totalToolCalls.toLocaleString()} | Tokens: ${report.totalTokens.toLocaleString()}`,
    "",
    "## Trends",
    "",
    "| Metric | First 3 | Last 3 | Trend |",
    "|--------|---------|--------|-------|",
  ];

  const tcTrend = report.trends.toolCalls;
  const tokTrend = report.trends.tokens;
  const errTrend = report.trends.errors;

  if (tcTrend.length >= 3) {
    const tcFirst = (tcTrend.slice(0, 3).reduce((s, p) => s + p.value, 0) / 3).toFixed(1);
    const tcLast = (tcTrend.slice(-3).reduce((s, p) => s + p.value, 0) / 3).toFixed(1);
    const tcIcon = parseFloat(tcLast) < parseFloat(tcFirst) ? "📈" : "📉";
    lines.push(`| Tool calls/task | ${tcFirst} | ${tcLast} | ${tcIcon} |`);
  }

  if (tokTrend.length >= 3) {
    const tokFirst = Math.round(tokTrend.slice(0, 3).reduce((s, p) => s + p.value, 0) / 3).toLocaleString();
    const tokLast = Math.round(tokTrend.slice(-3).reduce((s, p) => s + p.value, 0) / 3).toLocaleString();
    const tokIcon = parseInt(tokLast.replace(/,/g, "")) < parseInt(tokFirst.replace(/,/g, "")) ? "📈" : "📉";
    lines.push(`| Tokens/task | ${tokFirst} | ${tokLast} | ${tokIcon} |`);
  }

  lines.push("");

  // Module impact
  if (report.moduleImpact.length > 0) {
    lines.push("## Module Impact");
    lines.push("");
    lines.push("| Module | Before | After | Delta | Sessions | Verdict |");
    lines.push("|--------|--------|-------|-------|----------|---------|");
    for (const m of report.moduleImpact) {
      const icon = m.verdict === "improvement" ? "✅" : m.verdict === "regression" ? "❌" : "➡️";
      lines.push(
        `| ${m.module} | ${m.avgCallsBefore.toFixed(1)} | ${m.avgCallsAfter.toFixed(1)} | ${m.delta >= 0 ? "+" : ""}${m.delta.toFixed(1)} | ${m.sessionsAfter} | ${icon} ${m.verdict} |`
      );
    }
    lines.push("");
  }

  // Suggestions
  if (report.suggestions.length > 0) {
    lines.push("## Suggestions");
    lines.push("");
    for (const s of report.suggestions) {
      lines.push(`- ${s}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Per-session metrics
  let sessionToolCalls = 0;
  let sessionTokens = 0;
  let sessionErrors = 0;
  let taskCount = 0;
  let sessionId = "";

  pi.on("session_start", async (_event, ctx) => {
    sessionToolCalls = 0;
    sessionTokens = 0;
    sessionErrors = 0;
    taskCount = 0;
    sessionId = (ctx as any).sessionManager?.getSessionId?.() || "";
  });

  pi.on("tool_call", async (_event, _ctx) => {
    sessionToolCalls++;
  });

  pi.on("message_end", async (event, _ctx) => {
    const usage = (event as any).message?.usage;
    if (usage?.totalTokens) {
      sessionTokens += usage.totalTokens;
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (event.isError) sessionErrors++;
  });

  pi.on("message_start", async (event, _ctx) => {
    const msg = (event as any).message || (event as any);
    if (msg.role === "user") taskCount++;
  });

  // Save session card on shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    if (taskCount === 0) return;

    const card: SessionCard = {
      timestamp: new Date().toISOString(),
      sessionId,
      taskCount,
      toolCalls: sessionToolCalls,
      tokensUsed: sessionTokens,
      errors: sessionErrors,
      harnessVersion: "R9",
      activeModules: [
        "R1-python-middleware",
        "R2-bash-preflight",
        "R3-import-guard",
        "R4-verification-guard",
        "R5-efficient-coding",
        "R6-context-guard",
        "R7-prewrite-validator",
        "R8-task-router",
        "R9-tool-booster",
      ],
    };

    saveCard(ctx.cwd, card);
  });

  // Tool: cross-session analysis
  pi.registerTool({
    name: "ahe_cross_session",
    label: "AHE Cross-Session Analysis",
    description:
      "Analyze efficiency trends across all sessions. Shows which harness modules improved or regressed performance, with actionable suggestions.",
    parameters: {
      type: "object",
      properties: {
        sessions: {
          type: "number",
          description: "Number of recent sessions to include (default: all)",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let cards = loadCards(ctx.cwd);
      if (params.sessions && params.sessions > 0) {
        cards = cards.slice(-params.sessions);
      }

      if (cards.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No session cards found. Run a few tasks first — evidence accumulates automatically after each session.",
            },
          ],
        };
      }

      const report = analyzeCrossSession(cards);
      const markdown = formatReport(report);

      // Save report
      const reportPath = path.join(ctx.cwd, REPORT_FILE);
      ensureDir(path.dirname(reportPath));
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

      return {
        content: [{ type: "text", text: markdown }],
        details: {
          totalSessions: report.totalSessions,
          totalTasks: report.totalTasks,
          suggestions: report.suggestions.length,
        },
      };
    },
  });

  // ── Command ──
  pi.registerCommand("ahe:evidence", {
    description: "Show cross-session evidence and trends",
    handler: async (_args, ctx) => {
      const cards = loadCards(ctx.cwd);
      if (cards.length === 0) {
        ctx.ui.notify?.(
          "No session cards yet. Evidence accumulates automatically.",
          "info"
        );
        return;
      }

      const report = analyzeCrossSession(cards);
      ctx.ui.notify?.(
        `${report.totalSessions} sessions | ${report.totalTasks} tasks | ` +
          `${report.suggestions.length} suggestions | ` +
          `📁 ${REPORT_FILE}`,
        "info"
      );

      if (report.suggestions.length > 0) {
        ctx.ui.setWidget?.(
          "ahe-evidence",
          report.suggestions.slice(0, 10)
        );
      }
    },
  });
}
