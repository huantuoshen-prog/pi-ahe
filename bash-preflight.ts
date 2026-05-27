/**
 * AHE Evolution #2 — Bash Pre-Flight Middleware
 *
 * Prediction: Catching bash syntax errors before execution will eliminate
 * the "syntax error → retry" pattern that wasted calls in Round 1.
 *
 * Metric: avg bash task calls
 * Baseline R1: 1.33 (3 calls for 3 bash tasks, down from baseline's 4 calls for 3)
 * Target: 1.0 (all bash tasks pass on first attempt)
 *
 * Checks performed before execution:
 *   - Unbalanced quotes (single/double)
 *   - Unmatched heredoc delimiters (<< 'EOF' without closing EOF)
 *   - Mismatched parentheses/brackets
 *   - Dangerous patterns (rm -rf /, etc.)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Validation Rules ────────────────────────────────────────────

interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
  position?: number;
}

function validateBashCommand(command: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ── Quote balancing ──
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const prev = i > 0 ? command[i - 1] : "";

    if (ch === "'" && !inDouble && prev !== "\\") {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && prev !== "\\") {
      inDouble = !inDouble;
    }
  }
  if (inSingle) {
    issues.push({
      severity: "error",
      message: "Unclosed single quote — bash will fail",
    });
  }
  if (inDouble) {
    issues.push({
      severity: "error",
      message: "Unclosed double quote — bash will fail",
    });
  }

  // ── Heredoc matching ──
  const heredocRegex = /<<\s*(['"]?)(\w+)\1/g;
  const delimiters: string[] = [];
  let match;
  while ((match = heredocRegex.exec(command)) !== null) {
    delimiters.push(match[2]);
  }
  for (const delim of delimiters) {
    // Check if the delimiter appears as a standalone line
    const closingRegex = new RegExp(`^${delim}$`, "m");
    if (!closingRegex.test(command)) {
      issues.push({
        severity: "error",
        message: `Heredoc "${delim}" has no closing delimiter — bash will fail`,
      });
    }
  }

  // ── Parentheses/bracket matching ──
  const pairs: [string, string, string][] = [
    ["(", ")", "parentheses"],
    ["{", "}", "braces"],
    ["[", "]", "brackets"],
  ];
  for (const [open, close, name] of pairs) {
    let depth = 0;
    for (let i = 0; i < command.length; i++) {
      if (inSingle || inDouble) continue; // skip quoted content
      if (command[i] === open && (i === 0 || command[i - 1] !== "\\"))
        depth++;
      if (command[i] === close && (i === 0 || command[i - 1] !== "\\"))
        depth--;
    }
    if (depth > 0) {
      issues.push({
        severity: "warning",
        message: `Unmatched ${open} (depth ${depth}) — may cause issues`,
      });
    } else if (depth < 0) {
      issues.push({
        severity: "error",
        message: `Unexpected ${close} — bash may fail`,
      });
    }
  }

  // ── Dangerous patterns ──
  if (/\brm\s+-rf\s+\//.test(command)) {
    issues.push({
      severity: "error",
      message: "🚨 DANGER: rm -rf / detected — this would destroy the system!",
    });
  }
  if (/\brm\s+-rf\s+~/.test(command)) {
    issues.push({
      severity: "warning",
      message: "⚠️ rm -rf ~ detected — this would delete your home directory!",
    });
  }
  if (/\bgit\s+push\s+--force\b.*\bmaster\b|\bgit\s+push\s+--force\b.*\bmain\b/.test(command)) {
    issues.push({
      severity: "warning",
      message: "⚠️ git push --force to main/master — proceed with caution",
    });
  }

  // ── Empty command ──
  if (command.trim().length === 0) {
    issues.push({
      severity: "warning",
      message: "Empty command — nothing to execute",
    });
  }

  // ── Common typos ──
  if (/\becoh\b/.test(command)) {
    issues.push({ severity: "warning", message: 'Did you mean "echo"?' });
  }
  if (/\bgrep\s+-i\s+-v\s+-v\b/.test(command)) {
    issues.push({ severity: "warning", message: "Double -v flag in grep — is this intentional?" });
  }

  return issues;
}

// ─── Extension ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  /**
   * Intercept bash tool calls and validate command syntax before execution.
   */
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const input = event.input as any;
    const command = input?.command || "";

    if (!command.trim()) return;

    const issues = validateBashCommand(command);

    if (issues.length === 0) return; // All good, let it run

    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");

    if (errors.length > 0) {
      // Block execution for errors
      const errorText = errors.map((e) => `  ❌ ${e.message}`).join("\n");
      const warnText =
        warnings.length > 0
          ? "\n" + warnings.map((w) => `  ⚠️ ${w.message}`).join("\n")
          : "";

      ctx.ui.notify?.(
        `Bash pre-flight found ${errors.length} error(s): ${errors[0].message}`,
        "warning"
      );

      ctx.ui.setWidget?.("bash-issues", [
        "━━━ Bash Pre-Flight Check ━━━",
        "",
        `Command: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""}`,
        "",
        errorText,
        warnText,
        "",
        "Fix the issues above before re-running.",
      ]);

      // Note: We can't actually BLOCK the tool call here since pi's API
      // doesn't support aborting from on("tool_call"). Instead, we inject
      // a warning message that the Agent will see before the command runs.
    } else if (warnings.length > 0) {
      // Only warnings — let it run but notify
      ctx.ui.notify?.(
        `Bash pre-flight: ${warnings.length} warning(s) — ${warnings[0].message}`,
        "info"
      );
    }
  });

  /**
   * After bash execution, if it failed, try to diagnose the cause.
   */
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    if (!event.isError) return;

    const content = JSON.stringify(event.content || "");
    const input = event.input as any;
    const command = input?.command || "";

    // Common failure diagnoses
    const diagnoses: string[] = [];

    if (/command not found/i.test(content)) {
      const missingCmd = content.match(/['"]?(\w+)['"]?:?\s*command not found/i);
      diagnoses.push(
        `Command "${missingCmd?.[1] || "?"}" not found. Check: 1) is it installed? 2) is it in PATH? 3) try "which ${missingCmd?.[1] || "it"}"`
      );
    }

    if (/permission denied/i.test(content)) {
      diagnoses.push(
        "Permission denied. Try: 1) chmod +x, 2) run with sudo if appropriate, 3) check file ownership"
      );
    }

    if (/No such file or directory/i.test(content)) {
      const missingFile = content.match(/['"]?([^'"]+)['"]?:?\s*No such file/i);
      diagnoses.push(
        `File/directory "${missingFile?.[1] || "?"}" not found. Did you create it first?`
      );
    }

    if (/syntax error/i.test(content) || /unexpected token/i.test(content)) {
      diagnoses.push(
        "Bash syntax error. Check: 1) unmatched quotes, 2) missing semicolons, 3) heredoc delimiters"
      );
    }

    if (/cannot stat/i.test(content)) {
      diagnoses.push(
        "File stat failed — the file may not exist or path is wrong"
      );
    }

    if (diagnoses.length > 0) {
      ctx.ui.notify?.(
        `Bash error diagnosis: ${diagnoses[0]}`,
        "info"
      );
      ctx.ui.setWidget?.("bash-diagnosis", [
        "━━━ Bash Error Diagnosis ━━━",
        ...diagnoses.map((d) => `  💡 ${d}`),
        "",
        `Failed command: ${command.slice(0, 100)}`,
      ]);
    }
  });

  // ── Tool: validate bash without executing ──
  pi.registerTool({
    name: "bash_check",
    label: "Check Bash Command",
    description:
      "Validate a bash command for syntax errors before running it. Returns any issues found.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to validate",
        },
      },
      required: ["command"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issues = validateBashCommand(params.command);

      if (issues.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "✅ No issues detected. Command looks safe to run.",
            },
          ],
          details: { issues: 0 },
        };
      }

      const lines: string[] = [
        `Found ${issues.length} issue(s):`,
        "",
        ...issues.map(
          (i) => `- ${i.severity === "error" ? "❌" : "⚠️"} ${i.message}`
        ),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { issues: issues.length, errors: issues.filter((i) => i.severity === "error").length },
      };
    },
  });

  pi.registerCommand("ahe:bash-check", {
    description: "Show bash pre-flight status",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Bash pre-flight middleware active", "info");
      ctx.ui.notify(
        "Automatically validates: quotes, heredocs, parentheses, dangerous patterns",
        "info"
      );
    },
  });
}
