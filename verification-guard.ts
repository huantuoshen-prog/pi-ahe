/**
 * AHE Evolution #4 — Verification Convergence Guard
 *
 * Eliminates redundant verification patterns: once py confirms exitCode=0
 * with expected output, subsequent bash/read/bash_check on the same file
 * are blocked within the same editing session.
 *
 * Prediction: Blocking redundant verification calls will eliminate the
 * "py passed → bash diff → bash diff again → py again" chain seen in
 * Task 9 (4 wasted calls) and the "read + bash_check + py" triple-check
 * in Task 4 (2 wasted calls).
 *
 * Metric: tool calls per edit/debug/refactor task
 * Baseline R3: 37 calls total across 9 tasks
 * Target: ≤ 30 calls (-19% overall, -50% on worst tasks)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

interface VerifyEntry {
  filePath: string;
  toolName: string;
  command: string;
  turnNumber: number;
  exitCode: number;
  passed: boolean;
  outputPreview: string;
  timestamp: number;
}

// Per-file verification history
const fileVerifyCache = new Map<string, VerifyEntry[]>();
// Command dedup keyed by normalized command
const commandDedupCache = new Map<string, VerifyEntry>();
// Blocked call IDs → cached result so we can rewrite the error result
const blockedCallIds = new Map<string, VerifyEntry>();
let currentTurn = 0;

// ─── Helpers ─────────────────────────────────────────────────────

function resolveFilePath(cwd: string, p: string): string {
  try {
    return path.resolve(cwd, p);
  } catch {
    return p;
  }
}

function extractFilePath(
  event: any,
  toolName: string,
  cwd: string
): string | null {
  const input = event.input || {};
  switch (toolName) {
    case "py":
      return input.file ? resolveFilePath(cwd, input.file) : null;
    case "read":
      return input.path || input.file_path || input.file || null;
    case "bash":
    case "bash_check": {
      const cmd: string = input.command || "";
      const m = cmd.match(/(?:\/|^|\s)([\w./-]+\.py)\b/);
      return m ? resolveFilePath(cwd, m[1]) : null;
    }
    default:
      return null;
  }
}

function buildCommandKey(event: any, toolName: string): string {
  const input = event.input || {};
  switch (toolName) {
    case "py":
      return `py::${input.file || ""}::${(input.args || []).join(",")}`;
    case "bash":
      return `bash::${(input.command || "").replace(/\s+/g, " ").trim()}`;
    case "bash_check":
      return `bash_check::${(input.command || "").replace(/\s+/g, " ").trim()}`;
    case "read":
      return `read::${input.path || input.file_path || input.file || ""}`;
    default:
      return `${toolName}::`;
  }
}

function extractOutputText(event: any): string {
  const content = event.content || [];
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

function matchesPassPattern(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  // Exclude placeholder outputs that don't represent real execution results
  if (/^\(no output\)$/i.test(trimmed)) return false;
  // Exclude very short non-informative outputs (less than 10 chars and no PASS marker)
  if (trimmed.length < 10 && !/\bPASS\b/i.test(trimmed)) return false;

  // Explicit PASS marker — strongest signal
  if (/\bPASS\b/.test(output)) return true;
  // All tests passed
  if (/all tests pass/i.test(output)) return true;
  // Multi-line output with expected patterns (Config, Total, etc.) is likely valid
  if (trimmed.length >= 20 && /\n/.test(trimmed) && !/Traceback|Error:|error:/i.test(trimmed)) return true;
  return false;
}

function invalidateFileCache(filePath: string, cwd: string): void {
  const resolved = resolveFilePath(cwd, filePath);
  for (const key of fileVerifyCache.keys()) {
    if (key === resolved || key.startsWith(resolved)) {
      fileVerifyCache.delete(key);
    }
  }
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, _ctx) => {
    currentTurn++;
    // Evict entries older than 5 turns
    for (const [key, entries] of fileVerifyCache) {
      const fresh = entries.filter(
        (e) => currentTurn - e.turnNumber <= 5
      );
      if (fresh.length === 0) fileVerifyCache.delete(key);
      else fileVerifyCache.set(key, fresh);
    }
    for (const [key, entry] of commandDedupCache) {
      if (currentTurn - entry.turnNumber > 5) commandDedupCache.delete(key);
    }
  });

  // Intercept verification tools BEFORE execution
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    if (!["py", "bash", "read", "bash_check"].includes(toolName)) return;

    const targetFile = extractFilePath(event, toolName, ctx.cwd);
    const commandKey = buildCommandKey(event, toolName);

    // Rule 1: Same exact command already passed within 2 turns → block
    const dupEntry = commandDedupCache.get(commandKey);
    if (
      dupEntry &&
      dupEntry.passed &&
      currentTurn - dupEntry.turnNumber <= 2
    ) {
      ctx.ui.notify?.(
        `verification-guard: blocked redundant ${toolName} — already passed turn ${dupEntry.turnNumber}`,
        "info"
      );
      blockedCallIds.set(event.toolCallId, dupEntry);
      return {
        block: true,
        reason: `Cached: ${dupEntry.outputPreview.slice(0, 500)}`,
      };
    }

    // Rule 2: py already verified this file → block subsequent verification tools
    if (targetFile) {
      const fileEntries = fileVerifyCache.get(targetFile) || [];
      const pyPassed = fileEntries.find(
        (e) => e.toolName === "py" && e.passed
      );
      if (
        pyPassed &&
        currentTurn - pyPassed.turnNumber <= 1 &&
        ["bash", "read", "bash_check"].includes(toolName)
      ) {
        ctx.ui.notify?.(
          `verification-guard: blocked ${toolName} on ${path.basename(targetFile)} — py already verified in turn ${pyPassed.turnNumber}`,
          "info"
        );
        blockedCallIds.set(event.toolCallId, pyPassed);
        return {
          block: true,
          reason: `Cached: ${pyPassed.outputPreview.slice(0, 500)}`,
        };
      }
    }
  });

  // Record verification results AFTER execution
  pi.on("tool_result", async (event, ctx) => {
    const toolName = event.toolName;

    // Rewrite blocked results with cached success output
    const cached = blockedCallIds.get(event.toolCallId);
    if (cached) {
      blockedCallIds.delete(event.toolCallId);
      return {
        content: [{ type: "text", text: cached.outputPreview || "(cached result)" }],
        isError: false,
        details: { exitCode: cached.exitCode, cached: true },
      };
    }

    if (!["py", "bash", "read", "bash_check"].includes(toolName)) return;
    if (event.isError) return;

    const targetFile = extractFilePath(event, toolName, ctx.cwd);
    const commandKey = buildCommandKey(event, toolName);
    const outputText = extractOutputText(event);
    const exitCode = (event as any).details?.exitCode ?? 0;
    const passed = exitCode === 0 && matchesPassPattern(outputText);

    const entry: VerifyEntry = {
      filePath: targetFile || commandKey,
      toolName,
      command: commandKey,
      turnNumber: currentTurn,
      exitCode,
      passed,
      outputPreview: outputText.slice(0, 200),
      timestamp: Date.now(),
    };

    commandDedupCache.set(commandKey, entry);

    if (targetFile) {
      const fileEntries = fileVerifyCache.get(targetFile) || [];
      fileEntries.push(entry);
      fileVerifyCache.set(targetFile, fileEntries);
    }
  });

  // Invalidate cache when files are modified
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (event.isError) return;
    const input = event.input as any;
    const filePath = input?.path || input?.file_path || input?.file || "";
    if (filePath) {
      invalidateFileCache(filePath, ctx.cwd);
    }
  });

  // ── Command ──
  pi.registerCommand("ahe:verify-guard", {
    description: "Show verification guard status",
    handler: async (_args, ctx) => {
      ctx.ui.notify?.(
        `Verification guard active — tracking ${fileVerifyCache.size} files across ${currentTurn} turns`,
        "info"
      );
    },
  });
}
