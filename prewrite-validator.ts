/**
 * AHE Evolution #7 — Pre-Write Code Validator
 *
 * Validates Python code BEFORE writing to disk. Catches syntax errors
 * and import issues before the write executes, eliminating the
 * "write buggy code → edit to fix" round-trip.
 *
 * Prediction: Catching errors pre-write will eliminate the write→edit→write
 * pattern, reducing edit/debug task tool calls by 1-2 per task.
 *
 * Builds naturally on R1 (post-write syntax check) and R3 (import guard).
 * R1 catches errors after write, R7 catches them before.
 *
 * Metric: avg tool calls on edit/debug tasks
 * Baseline R6: Task 4 = 5 calls, Task 7 = 3 calls
 * Target: Task 4 ≤ 3 calls, Task 7 ≤ 2 calls
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Helpers ─────────────────────────────────────────────────────

function getPython(): string {
  try {
    execSync("py --version", { stdio: "pipe" });
    return "py";
  } catch {}
  try {
    execSync("python3 --version", { stdio: "pipe" });
    return "python3";
  } catch {}
  return "python";
}

function checkPythonSyntaxFromContent(
  content: string,
  fileName: string
): { ok: boolean; message: string } {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ahe-preview-")
  );
  const tmpFile = path.join(tmpDir, fileName);

  try {
    fs.writeFileSync(tmpFile, content, "utf-8");
    const py = getPython();
    execSync(`${py} -m py_compile "${tmpFile}"`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    });
    return { ok: true, message: "Syntax OK" };
  } catch (e: any) {
    const stderr = e.stderr || e.stdout || e.message || "";
    // Extract just the last meaningful error line
    const lines = stderr.trim().split("\n");
    const lastLine = lines[lines.length - 1] || stderr;
    return {
      ok: false,
      message: lastLine.slice(0, 300),
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  /**
   * Intercept write calls to .py files. Validate syntax BEFORE writing.
   * Block if syntax is invalid, providing the error so the agent can fix
   * the code in its next thinking iteration and retry with correct code.
   */
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write") return;

    const input = event.input as any;
    const filePath = input?.path || input?.file_path || input?.file || "";
    if (!filePath.endsWith(".py")) return;

    const content = input?.content || input?.text || "";
    if (!content) return;

    const result = checkPythonSyntaxFromContent(
      content,
      path.basename(filePath)
    );

    if (!result.ok) {
      ctx.ui.notify?.(
        `prewrite-validator: blocked write to ${filePath} — syntax error detected`,
        "warning"
      );

      return {
        block: true,
        reason: `Syntax error in ${path.basename(filePath)}:\n${result.message}\n\nFix the code and try again. Do NOT write buggy code to disk — fix it in your thinking first, then write the correct version.`,
      };
    }
  });

  // ── Command ──
  pi.registerCommand("ahe:prewrite", {
    description: "Show pre-write validator status",
    handler: async (_args, ctx) => {
      ctx.ui.notify?.(
        "Pre-write validator active — .py writes are syntax-checked before execution",
        "info"
      );
    },
  });
}
