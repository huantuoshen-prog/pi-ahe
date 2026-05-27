/**
 * AHE Self-Improvement for Pi — Trajectory Distiller (Pillar 2)
 *
 * Distills millions of raw trajectory tokens into a layered,
 * drill-down evidence corpus that an evolving agent can consume.
 *
 * Core idea from arXiv:2604.25850:
 *   "experience observability distills millions of raw trajectory tokens
 *    into a layered, drill-down evidence corpus"
 *
 * What this module does:
 *   L1: Task-level summaries (success/fail + key metrics)
 *   L2: Failure pattern clustering (grouped failures + root cause hypotheses)
 *   L3: Improvement suggestions (actionable edits for specific harness components)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────

interface TaskSummary {
  sessionFile: string;
  timestamp: string;
  userPrompt: string;
  outcome: "success" | "failure" | "incomplete";
  turnsUsed: number;
  tokensConsumed: number;
  toolCalls: Array<{ name: string; count: number; errors: number }>;
  errors: string[];
  cost: { input: number; output: number; total: number };
}

interface FailureCluster {
  pattern: string;
  frequency: number;
  examples: string[];
  affectedTools: string[];
  rootCauseHypothesis: string;
  suggestedFix: {
    component: string;
    description: string;
    targetFile?: string;
  };
}

interface EvidenceReport {
  generatedAt: string;
  sessionsAnalyzed: number;
  overallStats: {
    totalTasks: number;
    successRate: number;
    avgTurns: number;
    avgTokens: number;
    totalCost: number;
  };
  taskSummaries: TaskSummary[];
  failureClusters: FailureCluster[];
  improvementSuggestions: string[];
}

// ─── Configuration ───────────────────────────────────────────────

const EVIDENCE_DIR = path.join(".pi", "harness", "evidence");
const REPORT_FILE = path.join(EVIDENCE_DIR, "latest-report.json");
const FAILURE_CLUSTERS_FILE = path.join(
  EVIDENCE_DIR,
  "failure-clusters.md"
);
const SUGGESTIONS_FILE = path.join(EVIDENCE_DIR, "improvement-suggestions.md");

// ─── Helpers ─────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Parse a pi session JSONL file and extract task-level summaries.
 * Each user message starts a task; each task ends at the next user message
 * or end of file.
 */
function analyzeSessionFile(
  sessionPath: string,
  sessionData: string
): TaskSummary[] {
  const lines = sessionData.trim().split("\n").filter(Boolean);
  const tasks: TaskSummary[] = [];
  let currentTask: Partial<TaskSummary> | null = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (entry.type === "message" && entry.message?.role === "user") {
        // Save previous task
        if (currentTask && currentTask.userPrompt) {
          tasks.push(finalizeTask(currentTask));
        }
        // Start new task
        const userText =
          entry.message.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join(" ") || "";
        currentTask = {
          sessionFile: path.basename(sessionPath),
          timestamp: new Date(entry.timestamp || Date.now()).toISOString(),
          userPrompt: userText.slice(0, 200),
          outcome: "incomplete",
          turnsUsed: 0,
          tokensConsumed: 0,
          toolCalls: [],
          errors: [],
          cost: { input: 0, output: 0, total: 0 },
        };
      }

      if (currentTask && entry.type === "message" && entry.message?.role === "assistant") {
        currentTask.turnsUsed = (currentTask.turnsUsed || 0) + 1;
        if (entry.message.usage) {
          currentTask.tokensConsumed =
            (currentTask.tokensConsumed || 0) +
            (entry.message.usage.inputTokens || 0) +
            (entry.message.usage.outputTokens || 0);
          if (entry.message.usage.cost) {
            currentTask.cost = {
              input: (currentTask.cost?.input || 0) + (entry.message.usage.cost.input || 0),
              output: (currentTask.cost?.output || 0) + (entry.message.usage.cost.output || 0),
              total: (currentTask.cost?.total || 0) + (entry.message.usage.cost.total || 0),
            };
          }
        }

        // Track tool calls
        if (entry.message.content) {
          for (const part of entry.message.content) {
            if (part.type === "tool_call") {
              const existing = currentTask.toolCalls?.find(
                (t) => t.name === part.name
              );
              if (existing) {
                existing.count++;
              } else {
                currentTask.toolCalls?.push({
                  name: part.name || "unknown",
                  count: 1,
                  errors: 0,
                });
              }
            }
          }
        }
      }

      // Track errors
      if (currentTask && entry.type === "error") {
        currentTask.errors?.push(
          entry.message || entry.error || "Unknown error"
        );
      }

      // Track tool errors
      if (
        currentTask &&
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.isError
      ) {
        // Find the matching tool and increment its error count
        for (const tc of currentTask.toolCalls || []) {
          if (entry.message.toolCallId) {
            tc.errors++;
            break;
          }
        }
      }

      // If we see a compaction entry, the task ended (was completed)
      if (currentTask && entry.type === "compaction") {
        if (currentTask.outcome === "incomplete") {
          currentTask.outcome = "success";
        }
      }
    } catch {
      // Skip malformed JSON lines
    }
  }

  // Finalize last task
  if (currentTask && currentTask.userPrompt) {
    tasks.push(finalizeTask(currentTask));
  }

  return tasks;
}

function finalizeTask(task: Partial<TaskSummary>): TaskSummary {
  return {
    sessionFile: task.sessionFile || "unknown",
    timestamp: task.timestamp || new Date().toISOString(),
    userPrompt: task.userPrompt || "",
    outcome: task.outcome || "incomplete",
    turnsUsed: task.turnsUsed || 0,
    tokensConsumed: task.tokensConsumed || 0,
    toolCalls: task.toolCalls || [],
    errors: task.errors || [],
    cost: task.cost || { input: 0, output: 0, total: 0 },
  };
}

/**
 * Cluster failures by analyzing common error patterns and tool failures.
 */
function clusterFailures(tasks: TaskSummary[]): FailureCluster[] {
  const failures = tasks.filter((t) => t.outcome === "failure");
  if (failures.length === 0) return [];

  const clusters: FailureCluster[] = [];

  // Cluster 1: Bash command errors
  const bashFailures = failures.filter((t) =>
    t.errors.some((e) => e.includes("bash") || e.includes("command"))
  );
  if (bashFailures.length > 0) {
    clusters.push({
      pattern: "Bash command execution failures",
      frequency: bashFailures.length,
      examples: bashFailures.slice(0, 3).map((t) => t.userPrompt),
      affectedTools: ["bash"],
      rootCauseHypothesis:
        "Bash commands may be failing due to (a) missing environment setup, " +
        "(b) incorrect working directory, (c) timeout too short, or (d) missing dependencies.",
      suggestedFix: {
        component: "bash tool / middleware",
        description:
          "Add pre-execution environment check or increase timeout defaults. " +
          "Consider adding a 'setup' skill that ensures common dependencies are available.",
        targetFile: ".pi/extensions/ahe/",
      },
    });
  }

  // Cluster 2: Read tool failures
  const readFailures = failures.filter((t) =>
    t.errors.some((e) => e.includes("read") || e.includes("file not found"))
  );
  if (readFailures.length > 0) {
    clusters.push({
      pattern: "File read failures (file not found / permission denied)",
      frequency: readFailures.length,
      examples: readFailures.slice(0, 3).map((t) => t.userPrompt),
      affectedTools: ["read"],
      rootCauseHypothesis:
        "Agent is attempting to read files that don't exist, likely due to " +
        "incorrect path assumptions or stale file listings.",
      suggestedFix: {
        component: "system prompt / skills",
        description:
          "Add guideline: before reading a file, verify existence with bash ls/stat. " +
          "Consider adding a file-discovery skill.",
      },
    });
  }

  // Cluster 3: High token consumption (near context limit)
  const tokenFailures = failures.filter(
    (t) => t.tokensConsumed > 100000
  );
  if (tokenFailures.length > 0) {
    clusters.push({
      pattern: "High token consumption leading to context exhaustion",
      frequency: tokenFailures.length,
      examples: tokenFailures.slice(0, 3).map((t) => t.userPrompt),
      affectedTools: ["read", "bash"],
      rootCauseHypothesis:
        "Long sessions exhaust context window. Compaction may be too late " +
        "or producing poor summaries.",
      suggestedFix: {
        component: "compaction settings",
        description:
          "Lower compaction.keepRecentTokens or compaction.reserveTokens. " +
          "Improve compaction prompt to produce better summaries.",
        targetFile: ".pi/settings.json",
      },
    });
  }

  // Cluster 4: Repeated tool calls (agent stuck in loop)
  const loopFailures = failures.filter((t) => {
    const totalToolCalls = t.toolCalls.reduce((sum, tc) => sum + tc.count, 0);
    return totalToolCalls > 50 && t.turnsUsed > 20;
  });
  if (loopFailures.length > 0) {
    clusters.push({
      pattern: "Agent stuck in repetitive tool-call loops",
      frequency: loopFailures.length,
      examples: loopFailures.slice(0, 3).map((t) => t.userPrompt),
      affectedTools: ["bash", "read", "edit"],
      rootCauseHypothesis:
        "Agent is not making progress and repeating the same actions. " +
        "System prompt may lack clear stopping criteria or error recovery guidance.",
      suggestedFix: {
        component: "system prompt",
        description:
          "Add explicit guidelines: if 3 consecutive tool calls produce the same result, " +
          "stop and ask the user for guidance. Add a progress-check middleware.",
      },
    });
  }

  return clusters;
}

/**
 * Generate improvement suggestions from failure analysis.
 */
function generateSuggestions(
  tasks: TaskSummary[],
  clusters: FailureCluster[]
): string[] {
  const suggestions: string[] = [];

  // Suggestion from success rate
  const total = tasks.length;
  const succeeded = tasks.filter((t) => t.outcome === "success").length;
  const rate = total > 0 ? (succeeded / total) * 100 : 0;

  if (rate < 70) {
    suggestions.push(
      `⚠️ Overall success rate is low (${rate.toFixed(1)}%). Consider the following improvements.`
    );
  } else if (rate >= 90) {
    suggestions.push(
      `✅ Success rate is healthy (${rate.toFixed(1)}%). Focus on fine-tuning rather than major changes.`
    );
  }

  // Tool-specific suggestions
  const bashErrors = tasks.filter((t) =>
    t.errors.some((e) => e.includes("bash") || e.includes("command"))
  ).length;
  if (bashErrors > total * 0.3) {
    suggestions.push(
      `🔧 Bash tool errors affect ${((bashErrors / total) * 100).toFixed(0)}% of tasks. ` +
        `Consider: (1) adding env setup middleware, (2) increasing timeout, (3) pre-checking command availability.`
    );
  }

  // Token usage suggestion
  const avgTokens =
    tasks.reduce((sum, t) => sum + t.tokensConsumed, 0) / (total || 1);
  if (avgTokens > 50000) {
    suggestions.push(
      `💰 Average token consumption is high (${Math.round(avgTokens).toLocaleString()} per task). ` +
        `Consider: (1) earlier compaction triggers, (2) shorter tool outputs, (3) more selective file reading.`
    );
  }

  // Cluster-based suggestions
  for (const cluster of clusters) {
    suggestions.push(
      `🔍 [${cluster.pattern}] affects ${cluster.frequency} task(s). ` +
        `Suggested: ${cluster.suggestedFix.description}`
    );
  }

  return suggestions;
}

// ─── Report Generation ───────────────────────────────────────────

function generateMarkdownReport(report: EvidenceReport): string {
  const lines: string[] = [];
  lines.push("# AHE Evidence Report");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Sessions analyzed: ${report.sessionsAnalyzed}`);
  lines.push("");
  lines.push("## Overall Statistics");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total tasks | ${report.overallStats.totalTasks} |`);
  lines.push(
    `| Success rate | ${(report.overallStats.successRate * 100).toFixed(1)}% |`
  );
  lines.push(
    `| Avg turns | ${report.overallStats.avgTurns.toFixed(1)} |`
  );
  lines.push(
    `| Avg tokens | ${Math.round(report.overallStats.avgTokens).toLocaleString()} |`
  );
  lines.push(
    `| Total cost | $${report.overallStats.totalCost.toFixed(4)} |`
  );
  lines.push("");

  if (report.failureClusters.length > 0) {
    lines.push("## Failure Clusters");
    lines.push("");
    for (const cluster of report.failureClusters) {
      lines.push(`### ${cluster.pattern} (${cluster.frequency} occurrences)`);
      lines.push("");
      lines.push(`**Affected tools:** ${cluster.affectedTools.join(", ")}`);
      lines.push("");
      lines.push(`**Root cause hypothesis:** ${cluster.rootCauseHypothesis}`);
      lines.push("");
      lines.push(`**Suggested fix:** ${cluster.suggestedFix.description}`);
      if (cluster.suggestedFix.targetFile) {
        lines.push(`- Target: \`${cluster.suggestedFix.targetFile}\``);
      }
      lines.push("");
      lines.push("**Example tasks:**");
      for (const ex of cluster.examples) {
        lines.push(`- "${ex}"`);
      }
      lines.push("");
    }
  }

  if (report.improvementSuggestions.length > 0) {
    lines.push("## Improvement Suggestions");
    lines.push("");
    for (const s of report.improvementSuggestions) {
      lines.push(`- ${s}`);
    }
    lines.push("");
  }

  // Task summary table (last 20 tasks)
  lines.push("## Recent Task Summaries");
  lines.push("");
  lines.push(
    "| # | Outcome | Turns | Tokens | Cost | Prompt |"
  );
  lines.push(
    "|---|---------|-------|--------|------|--------|"
  );
  const recent = report.taskSummaries.slice(-20);
  for (let i = 0; i < recent.length; i++) {
    const t = recent[i];
    const icon = t.outcome === "success" ? "✅" : t.outcome === "failure" ? "❌" : "⏳";
    lines.push(
      `| ${report.taskSummaries.length - recent.length + i + 1} | ${icon} ${t.outcome} | ${t.turnsUsed} | ${Math.round(t.tokensConsumed).toLocaleString()} | $${t.cost.total.toFixed(4)} | ${t.userPrompt.slice(0, 60)}... |`
    );
  }

  return lines.join("\n");
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Track per-session metrics in memory ──
  let currentTaskStartTokens = 0;
  let currentTaskToolCalls: Map<string, { count: number; errors: number }> =
    new Map();
  let currentTaskErrors: string[] = [];

  pi.on("agent_start", async (_event, _ctx) => {
    currentTaskStartTokens = 0;
    currentTaskToolCalls = new Map();
    currentTaskErrors = [];
  });

  pi.on("tool_call", async (event, _ctx) => {
    const existing = currentTaskToolCalls.get(event.toolName);
    if (existing) {
      existing.count++;
    } else {
      currentTaskToolCalls.set(event.toolName, { count: 1, errors: 0 });
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (event.isError) {
      const existing = currentTaskToolCalls.get(event.toolName);
      if (existing) {
        existing.errors++;
      }
      currentTaskErrors.push(
        `Tool error [${event.toolName}]: ${JSON.stringify(event.content).slice(0, 100)}`
      );
    }
  });

  pi.on("agent_end", async (event, _ctx) => {
    // Log task summary for later analysis
    const tasks: TaskSummary[] = [];
    const userMessages = event.messages?.filter(
      (m: any) => m.role === "user"
    ) || [];

    const lastUserMsg =
      userMessages.length > 0
        ? userMessages[userMessages.length - 1]
        : null;
    const userPrompt =
      lastUserMsg?.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join(" ") || "";

    const task: TaskSummary = {
      sessionFile: "current",
      timestamp: new Date().toISOString(),
      userPrompt: userPrompt.slice(0, 200),
      outcome: currentTaskErrors.length === 0 ? "success" : "failure",
      turnsUsed: event.messages?.filter((m: any) => m.role === "assistant")
        .length || 0,
      tokensConsumed:
        event.messages?.reduce(
          (sum: number, m: any) =>
            sum + (m.usage?.inputTokens || 0) + (m.usage?.outputTokens || 0),
          0
        ) || 0,
      toolCalls: Array.from(currentTaskToolCalls.entries()).map(
        ([name, stats]) => ({
          name,
          count: stats.count,
          errors: stats.errors,
        })
      ),
      errors: currentTaskErrors,
      cost: event.messages?.reduce(
        (acc: any, m: any) => {
          if (m.usage?.cost) {
            acc.input += m.usage.cost.input || 0;
            acc.output += m.usage.cost.output || 0;
            acc.total += m.usage.cost.total || 0;
          }
          return acc;
        },
        { input: 0, output: 0, total: 0 }
      ) || { input: 0, output: 0, total: 0 },
    };

    // Append to evidence log
    const cwd = _ctx.cwd;
    ensureDir(path.join(cwd, EVIDENCE_DIR));
    const logFile = path.join(cwd, EVIDENCE_DIR, "task-log.jsonl");
    fs.appendFileSync(logFile, JSON.stringify(task) + "\n", "utf-8");
  });

  // ── Tool: analyze sessions ──
  pi.registerTool({
    name: "ahe_analyze_sessions",
    label: "AHE Analyze Sessions",
    description:
      "Analyze recent session trajectories to identify failure patterns and generate improvement suggestions. Returns structured evidence report.",
    parameters: {
      type: "object",
      properties: {
        sessionCount: {
          type: "number",
          description: "Number of most recent sessions to analyze (default: 5)",
        },
        focusArea: {
          type: "string",
          enum: ["all", "failures", "tokens", "tools"],
          description: "What to focus the analysis on",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const count = params.sessionCount || 5;
      const focus = params.focusArea || "all";

      ensureDir(path.join(cwd, EVIDENCE_DIR));

      // Collect recent sessions
      const sessionsDir = path.join(
        process.env.HOME || "~",
        ".pi/agent/sessions",
        cwd.replace(/[/\\:]/g, "_")
      );
      let sessionFiles: string[] = [];
      if (fs.existsSync(sessionsDir)) {
        sessionFiles = fs
          .readdirSync(sessionsDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => path.join(sessionsDir, f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
          .slice(0, count);
      }

      // Also include task log
      const taskLogFile = path.join(cwd, EVIDENCE_DIR, "task-log.jsonl");
      let allTasks: TaskSummary[] = [];

      // Read task log
      if (fs.existsSync(taskLogFile)) {
        const content = fs.readFileSync(taskLogFile, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            allTasks.push(JSON.parse(line));
          } catch {
            // skip
          }
        }
      }

      // Read session files
      for (const sessionFile of sessionFiles) {
        try {
          const content = fs.readFileSync(sessionFile, "utf-8");
          const tasks = analyzeSessionFile(sessionFile, content);
          allTasks.push(...tasks);
        } catch {
          // skip unreadable sessions
        }
      }

      if (allTasks.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No session data found. Run a few tasks first, then analyze.",
            },
          ],
        };
      }

      // Compute stats
      const succeeded = allTasks.filter((t) => t.outcome === "success").length;
      const totalTokens = allTasks.reduce(
        (sum, t) => sum + t.tokensConsumed,
        0
      );
      const totalCost = allTasks.reduce(
        (sum, t) => sum + t.cost.total,
        0
      );

      const clusters = clusterFailures(allTasks);
      const suggestions = generateSuggestions(allTasks, clusters);

      const report: EvidenceReport = {
        generatedAt: getTimestamp(),
        sessionsAnalyzed: sessionFiles.length + (fs.existsSync(taskLogFile) ? 1 : 0),
        overallStats: {
          totalTasks: allTasks.length,
          successRate: allTasks.length > 0 ? succeeded / allTasks.length : 0,
          avgTurns:
            allTasks.reduce((sum, t) => sum + t.turnsUsed, 0) /
            (allTasks.length || 1),
          avgTokens: allTasks.length > 0 ? totalTokens / allTasks.length : 0,
          totalCost,
        },
        taskSummaries: allTasks,
        failureClusters: clusters,
        improvementSuggestions: suggestions,
      };

      // Write reports
      fs.writeFileSync(
        path.join(cwd, REPORT_FILE),
        JSON.stringify(report, null, 2),
        "utf-8"
      );

      const mdReport = generateMarkdownReport(report);
      fs.writeFileSync(
        path.join(cwd, FAILURE_CLUSTERS_FILE),
        mdReport,
        "utf-8"
      );

      // Write suggestions separately for easier Agent consumption
      const suggestionsMd =
        "# Improvement Suggestions\n\n" +
        suggestions.map((s) => `- ${s}`).join("\n") +
        "\n\n## How to apply\n\n" +
        "1. Read the full evidence report at `.pi/harness/evidence/latest-report.json`\n" +
        "2. For each suggestion, use `/ahe:decide` to record your edit with a prediction\n" +
        "3. Edit the relevant harness files (extensions, skills, prompts, settings)\n" +
        "4. Re-run the tasks to verify improvements\n" +
        "5. Use `/ahe:verify` to check if your predictions were correct\n";
      fs.writeFileSync(
        path.join(cwd, SUGGESTIONS_FILE),
        suggestionsMd,
        "utf-8"
      );

      // Return focused view
      const focusedText = (() => {
        switch (focus) {
          case "failures":
            return mdReport.split("## Failure Clusters")[1]?.split("## ")[0] || "No failure clusters found.";
          case "tokens":
            return `## Token Analysis\n\nAvg tokens/task: ${Math.round(report.overallStats.avgTokens).toLocaleString()}\nTotal cost: $${report.overallStats.totalCost.toFixed(4)}`;
          case "tools":
            return `## Tool Usage\n\n` +
              Object.entries(
                allTasks
                  .flatMap((t) => t.toolCalls)
                  .reduce(
                    (acc, tc) => {
                      acc[tc.name] = (acc[tc.name] || 0) + tc.count;
                      return acc;
                    },
                    {} as Record<string, number>
                  )
              )
                .sort(([, a], [, b]) => b - a)
                .map(([name, count]) => `- ${name}: ${count} calls`)
                .join("\n");
          default:
            return mdReport;
        }
      })();

      return {
        content: [
          {
            type: "text",
            text:
              `## AHE Evidence Report\n\n` +
              `Sessions: ${report.sessionsAnalyzed} | Tasks: ${report.overallStats.totalTasks} | ` +
              `Success: ${(report.overallStats.successRate * 100).toFixed(1)}% | ` +
              `Tokens: ${Math.round(report.overallStats.avgTokens).toLocaleString()}/task | ` +
              `Cost: $${report.overallStats.totalCost.toFixed(4)}\n\n` +
              focusedText +
              `\n\n📁 Full report: \`.pi/harness/evidence/latest-report.json\`` +
              `\n📋 Suggestions: \`.pi/harness/evidence/improvement-suggestions.md\``,
          },
        ],
        details: { totalTasks: allTasks.length, clusters: clusters.length },
      };
    },
  });

  // ── Command: /ahe:analyze ──
  pi.registerCommand("ahe:analyze", {
    description: "Analyze recent sessions and generate evidence report",
    handler: async (args, ctx) => {
      ctx.ui.notify("Analyzing sessions...", "info");

      // The LLM should call ahe_analyze_sessions tool instead, but
      // we can also provide a quick summary here for human use.
      const cwd = ctx.cwd;
      const reportFile = path.join(cwd, REPORT_FILE);
      const suggestionsFile = path.join(cwd, SUGGESTIONS_FILE);

      if (fs.existsSync(reportFile)) {
        const report: EvidenceReport = JSON.parse(
          fs.readFileSync(reportFile, "utf-8")
        );
        ctx.ui.notify(
          `Last analysis: ${report.overallStats.totalTasks} tasks, ` +
            `${(report.overallStats.successRate * 100).toFixed(1)}% success, ` +
            `${report.failureClusters.length} failure patterns`,
          "info"
        );

        if (fs.existsSync(suggestionsFile)) {
          const suggestions = fs.readFileSync(suggestionsFile, "utf-8");
          ctx.ui.setWidget(
            "ahe-evidence",
            suggestions.split("\n").slice(0, 20)
          );
        }
      } else {
        ctx.ui.notify(
          "No evidence report yet. Ask the agent to call ahe_analyze_sessions first.",
          "warning"
        );
      }
    },
  });
}
