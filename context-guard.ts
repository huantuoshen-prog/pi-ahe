/**
 * AHE Evolution #6 — Context Window Guard
 *
 * Monitors context token usage and prevents context exhaustion by:
 * 1. Auto-trimming verbose tool outputs when context > 75%
 * 2. Injecting a steer message when context > 85% (suggest compaction or wrap-up)
 * 3. Providing ahe_context_status tool so the LLM can self-monitor
 *
 * Prediction: Proactive trimming + early warning will reduce context-exhaustion
 * failures and lower average token consumption on long-running tasks.
 *
 * Metric: tokens per task on long tasks (refactor, multi-file edit)
 * Baseline R5: avg tokens per edit/debug/refactor task
 * Target: -10% tokens on long tasks, zero context-exhaustion failures
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Configuration ──────────────────────────────────────────────

const TRIM_THRESHOLD = 75; // % — auto-trim outputs when context above this
const WARN_THRESHOLD = 85; // % — inject steer message when context above this
const MAX_OUTPUT_CHARS = 600; // Trim long tool outputs to this when context is tight
const COOLDOWN_TURNS = 3; // Don't warn again for N turns after last warning

let lastWarnTurn = -Infinity;
let currentTurn = 0;

// ─── Helpers ─────────────────────────────────────────────────────

function trimOutput(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const head = text.slice(0, Math.floor(maxLen * 0.6));
  const tail = text.slice(-Math.floor(maxLen * 0.3));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n... [${omitted.toLocaleString()} chars trimmed by context-guard] ...\n\n${tail}`;
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, _ctx) => {
    currentTurn++;
  });

  // Check context usage before each LLM call
  pi.on("context", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens == null) return;

    const pct = usage.percent ?? 0;

    // Inject steer message when critically high
    if (pct >= WARN_THRESHOLD && currentTurn - lastWarnTurn >= COOLDOWN_TURNS) {
      lastWarnTurn = currentTurn;
      const steerMsg =
        `[Context Guard] Context is at ${pct.toFixed(0)}% (${usage.tokens.toLocaleString()}/${usage.contextWindow.toLocaleString()} tokens). ` +
        `Consider: (1) use /compact to free space, (2) wrap up the current task quickly, (3) avoid reading large files. ` +
        `Use ahe_context_status tool to recheck at any time.`;

      try {
        pi.sendUserMessage(steerMsg, { deliverAs: "steer" });
      } catch {
        // sendUserMessage may throw if not idling; that's fine, we'll warn next time
      }
    }
  });

  // Auto-trim verbose tool outputs when context is tight
  pi.on("tool_result", async (event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens == null) return;
    const pct = usage.percent ?? 0;
    if (pct < TRIM_THRESHOLD) return;

    // Only trim verbose tools: bash, read
    if (event.toolName !== "bash" && event.toolName !== "read") return;
    if (event.isError) return;

    const content = event.content || [];
    let trimmed = false;

    const newContent = content.map((c: any) => {
      if (c.type !== "text") return c;
      const text: string = c.text || "";
      if (text.length <= MAX_OUTPUT_CHARS) return c;
      trimmed = true;
      return { type: "text", text: trimOutput(text, MAX_OUTPUT_CHARS) };
    });

    if (trimmed) {
      ctx.ui.notify?.(
        `context-guard: trimmed output (${pct.toFixed(0)}% context used)`,
        "info"
      );
      return { content: newContent };
    }
  });

  // Tool: LLM can check its own context status
  pi.registerTool({
    name: "ahe_context_status",
    label: "AHE Context Status",
    description:
      "Check current context window usage. Returns token count, percentage used, and whether compaction is recommended.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const usage = ctx.getContextUsage();
      if (!usage || usage.tokens == null) {
        return {
          content: [
            {
              type: "text",
              text: "Context usage unknown (right after compaction or model not yet queried). Run one turn to get an estimate.",
            },
          ],
        };
      }

      const pct = usage.percent ?? 0;
      let recommendation = "";
      if (pct >= 90) {
        recommendation =
          " Critical! Use /compact immediately or finish the current task in the next 1-2 turns.";
      } else if (pct >= 75) {
        recommendation =
          " Consider compacting soon. Avoid reading large files. Write concise outputs.";
      } else if (pct >= 50) {
        recommendation = " Moderate usage. Still safe for multi-step tasks.";
      } else {
        recommendation = " Plenty of room for additional work.";
      }

      return {
        content: [
          {
            type: "text",
            text:
              `## Context Window Status\n\n` +
              `- **Tokens used:** ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()}\n` +
              `- **Percentage:** ${pct.toFixed(1)}%\n` +
              `- **Recommendation:** ${recommendation}`,
          },
        ],
        details: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: pct },
      };
    },
  });

  // ── Command ──
  pi.registerCommand("ahe:context", {
    description: "Show context window status",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      if (usage?.tokens != null) {
        ctx.ui.notify?.(
          `Context: ${(usage.percent ?? 0).toFixed(1)}% (${usage.tokens.toLocaleString()}/${usage.contextWindow.toLocaleString()} tokens)`,
          (usage.percent ?? 0) > 80 ? "warning" : "info"
        );
      } else {
        ctx.ui.notify?.("Context usage: unknown (no LLM query yet)", "info");
      }
    },
  });
}
