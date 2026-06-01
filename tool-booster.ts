/**
 * AHE Evolution #9 — Tool Affordance Booster
 *
 * Detects bash commands that would be better served by dedicated harness
 * tools and either blocks them (with a suggestion) or injects guidance.
 * Makes R1-R8 tools more discoverable to the model.
 *
 * Prediction: Reducing bash misuse will cut 2-4 unnecessary bash calls
 * per task, especially on Python tasks where the model defaults to
 * "bash python" instead of "py".
 *
 * Metric: bash calls on Python tasks
 * Baseline: Task 4=6 bash calls, Task 9=11 bash calls (v4-pro)
 * Target: Task 4≤3 bash calls, Task 9≤5 bash calls
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Detection Rules ─────────────────────────────────────────────

interface ToolRule {
  /** Regex to match against the bash command */
  pattern: RegExp;
  /** The recommended alternative tool name */
  suggest: string;
  /** Example of the correct usage */
  example: string;
  /** Whether to block (true) or just warn (false) */
  block: boolean;
}

const RULES: ToolRule[] = [
  {
    // python3 -c "..." or python -c "..."
    pattern: /^(python3?|python3?\.exe)\s+(-c\s|--?)/m,
    suggest: "py",
    example: 'Use the py tool: py { file: "script.py" }',
    block: true,
  },
  {
    // python3 script.py or python script.py
    pattern: /^(python3?|python3?\.exe)\s+\S+\.py(\s|$)/m,
    suggest: "py",
    example: 'Use the py tool: py { file: "script.py" }',
    block: true,
  },
  {
    // python3 -m py_compile (syntax check)
    pattern: /^(python3?|python3?\.exe)\s+-m\s+py_compile\b/m,
    suggest: "bash_check or py",
    example: "The harness auto-checks syntax on write. Use py to run directly.",
    block: true,
  },
  {
    // cat single_file (reading a file the model should use read for)
    pattern: /^cat\s+(\S+\.py)\s*$/m,
    suggest: "read",
    example: 'Use the read tool: read { path: "file.py" }',
    block: false,
  },
  {
    // echo "content" > file.py (writing Python via bash)
    pattern: /^echo\s+("|')(.*)\1\s*>\s*(\S+\.py)\s*$/m,
    suggest: "write",
    example: 'Use the write tool: write { path: "file.py", content: "..." }',
    block: false,
  },
  {
    // python3 -m pip install
    pattern: /^(python3?|python3?\.exe)\s+-m\s+pip\b/m,
    suggest: "bash (pip3)",
    example: "Use 'pip3 install ...' or 'py -m pip install ...' directly",
    block: false,
  },
  {
    // which/where python — diagnostic that wastes a turn
    pattern: /^(which|where|command\s+-v)\s+python/m,
    suggest: "py",
    example: "The py tool auto-detects Python. No need to find it manually.",
    block: true,
  },
];

// ─── Helpers ─────────────────────────────────────────────────────

function matchRule(command: string): ToolRule | null {
  for (const rule of RULES) {
    if (rule.pattern.test(command)) return rule;
  }
  return null;
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const input = event.input as any;
    const command = (input?.command || "").trim();
    if (!command) return;

    const rule = matchRule(command);
    if (!rule) return;

    if (rule.block) {
      ctx.ui.notify?.(
        `tool-booster: blocked bash → suggest ${rule.suggest}`,
        "info"
      );

      // Inject a steer message so the model knows what to use instead
      try {
        pi.sendUserMessage(
          `[Tool Booster] Your bash command uses \`${command.slice(0, 80)}\`. ` +
            `${rule.example}. This is faster and more reliable.`,
          { deliverAs: "steer" }
        );
      } catch {
        // Non-critical if steer fails
      }

      return {
        block: true,
        reason: `Use the ${rule.suggest} tool instead. ${rule.example}`,
      };
    } else {
      // Warning only — let it through but notify
      ctx.ui.notify?.(
        `tool-booster: consider ${rule.suggest} instead of: ${command.slice(0, 80)}`,
        "info"
      );
    }
  });

  // ── Command ──
  pi.registerCommand("ahe:tools", {
    description: "Show available harness tools and when to use them",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget?.("ahe-tools", [
        "━━━ Harness Tools Quick Reference ━━━",
        "",
        "Python:",
        "  py { file }         Run .py files (auto-detects Python)",
        "  bash_check { cmd }  Validate bash without executing",
        "  check_imports { f }  Scan .py file for missing imports",
        "",
        "Context:",
        "  ahe_context_status   Check token usage %",
        "  ahe_view_harness     View system prompt / tools / components",
        "  ahe_analyze_sessions Analyze past sessions for patterns",
        "",
        "Benchmark & Decisions:",
        "  ahe_bench_run        Run benchmark tasks",
        "  ahe_log_decision     Record harness edit + prediction",
        "  ahe_verify_decision  Verify a prediction against results",
        "",
        "Avoid in bash:",
        "  python/python3 → use py tool",
        "  cat file.py → use read tool",
        "  echo > file.py → use write tool",
        "  which python → py auto-detects",
        "  python -m py_compile → harness does this automatically",
      ]);
      ctx.ui.notify?.("Harness tool reference displayed", "info");
    },
  });
}
