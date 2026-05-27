/**
 * AHE Evolution #1 — Python Auto-Verify Middleware
 *
 * Prediction: Adding auto-syntax-check after Python file edits will
 * reduce tool calls by catching syntax errors before the agent runs the file.
 *
 * Metric: avg tool calls per Python task
 * Baseline: 4.25 (avg of tasks 4, 5, 7, 8 = (3+4+4+6)/4)
 * Target: ≤ 3.0
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

// Python command to use (auto-detect)
function getPython(): string {
  try { execSync("py --version", { stdio: "pipe" }); return "py"; } catch {}
  try { execSync("python3 --version", { stdio: "pipe" }); return "python3"; } catch {}
  return "python";
}

export default function (pi: ExtensionAPI) {
  /**
   * After every write/edit to a .py file, auto-check syntax
   * and surface errors immediately, avoiding a separate bash+py call.
   */
  pi.on("tool_result", async (event, ctx) => {
    // Only fire after write/edit tools
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (event.isError) return;

    const input = event.input as any;
    const filePath = input?.path || "";

    // Only for Python files
    if (!filePath.endsWith(".py")) return;

    try {
      const py = getPython();
      const result = execSync(`${py} -m py_compile "${filePath}"`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
      });

      // Syntax OK — notify silently
      ctx.ui.notify?.(`🐍 ${filePath}: syntax OK`, "info");
    } catch (e: any) {
      const stderr = e.stderr || e.stdout || e.message || "";

      // Extract the error line for display
      const lines = stderr.trim().split("\n");
      const errorMsg = lines[lines.length - 1] || stderr;

      ctx.ui.notify?.(`⚠️ ${filePath}: ${errorMsg.slice(0, 120)}`, "warning");
      ctx.ui.setWidget?.("python-errors", [
        `❌ Syntax error in ${filePath}:`,
        `   ${errorMsg}`,
        "",
        "Fix before running: python will not execute this file.",
      ]);
    }
  });

  // Register a lightweight python_run tool (avoids bash for simple Python execution)
  pi.registerTool({
    name: "py",
    label: "Run Python",
    description:
      "Run a Python script and return its output. Faster than bash+py for Python-specific tasks. Use this instead of bash for running .py files.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Python file to run (relative path)",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Optional command-line arguments",
        },
      },
      required: ["file"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const py = getPython();
      const filePath = params.file;
      const extraArgs = (params.args || []).join(" ");

      try {
        const stdout = execSync(`${py} "${filePath}" ${extraArgs}`, {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 30000,
          stdio: "pipe",
          maxBuffer: 1024 * 1024, // 1MB
        });

        return {
          content: [
            {
              type: "text",
              text: stdout || "(no output)",
            },
          ],
          details: { exitCode: 0 },
        };
      } catch (e: any) {
        const stderr = e.stderr || e.stdout || "";
        const stdout = e.stdout || "";

        return {
          content: [
            {
              type: "text",
              text:
                (stdout ? stdout + "\n" : "") +
                (stderr ? "Error:\n" + stderr.slice(0, 2000) : `Process exited with code ${e.status || 1}`),
            },
          ],
          details: {
            exitCode: e.status || 1,
            isError: true,
          },
        };
      }
    },
  });

  pi.registerCommand("ahe:py", {
    description: "Show Python middleware status",
    handler: async (_args, ctx) => {
      const py = getPython();
      ctx.ui.notify(`Python middleware active (using "${py}")`, "info");
      ctx.ui.notify(
        "Auto-syntax-check enabled: every .py file edit is checked for syntax errors.",
        "info"
      );
    },
  });
}
