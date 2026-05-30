/**
 * AHE Self-Improvement for Pi — Benchmark Runner
 *
 * Runs a reproducible benchmark suite to measure whether harness edits
 * are improvements or regressions. Implements the "Verify" phase of the
 * AHE outer loop with quantitative before/after comparison.
 *
 * Design:
 *   1. Define a suite of coding tasks with expected outcomes
 *   2. Run tasks with current harness → establish baseline
 *   3. After harness edits, re-run → measure delta
 *   4. Compare: pass rate, token cost, tool errors, wall-clock time
 *   5. Produce a verdict: ✅ improvement / ❌ regression / ❓ inconclusive
 *
 * Each task is a self-contained coding challenge that pi's agent should
 * be able to complete. Tasks are graded by checking expected outputs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────

interface BenchmarkTask {
  id: string;
  name: string;
  description: string;
  category: "bash" | "edit" | "read+write" | "debug" | "refactor";
  difficulty: "easy" | "medium" | "hard";
  /** The prompt to send to the agent */
  prompt: string;
  /** How to verify success: a bash command that returns 0 on success */
  verifyCommand: string;
  /** Optional: setup commands to run before the task */
  setupCommands?: string[];
  /** Optional: cleanup commands to run after */
  teardownCommands?: string[];
  /** Expected output snippets that should appear in the result */
  expectedOutputs?: string[];
  /** Timeout in milliseconds */
  timeoutMs: number;
}

interface TaskResult {
  taskId: string;
  harnessVersion: string; // "baseline" or "evolved-{n}"
  outcome: "pass" | "fail" | "timeout" | "error";
  tokensConsumed: number;
  toolCalls: number;
  toolErrors: number;
  wallClockMs: number;
  agentTurns: number;
  errorMessage?: string;
  verificationOutput?: string;
}

interface BenchmarkRun {
  id: string;
  timestamp: string;
  harnessVersion: string;
  harnessSnapshotPath?: string;
  tasks: TaskResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    timeout: number;
    error: number;
    passRate: number;
    avgTokens: number;
    avgToolCalls: number;
    avgToolErrors: number;
    avgTimeMs: number;
    totalCost: { input: number; output: number; total: number };
  };
}

interface BenchmarkComparison {
  baselineRun: BenchmarkRun;
  evolvedRun: BenchmarkRun;
  verdict: "improvement" | "regression" | "mixed" | "no-change";
  deltas: {
    passRateDelta: number;
    avgTokensDelta: number;
    avgTimeDelta: number;
    avgToolErrorsDelta: number;
  };
  perTask: Array<{
    taskId: string;
    baselineResult: TaskResult;
    evolvedResult: TaskResult;
    delta: string;
  }>;
}

// ─── Built-in Benchmark Suite ────────────────────────────────────

const BUILTIN_TASKS: BenchmarkTask[] = [
  // ── Bash tasks ──
  {
    id: "bash-file-analysis",
    name: "Bash file analysis",
    category: "bash",
    difficulty: "easy",
    prompt:
      "Use bash to: 1) create a directory called 'bench-tmp', " +
      "2) write 10 files named file_0.txt through file_9.txt, each containing 'hello {n}', " +
      "3) count how many files contain the word 'hello', " +
      "4) find the largest file by size, " +
      "5) write all findings to bench-tmp/report.txt.",
    verifyCommand:
      "test -f bench-tmp/report.txt && grep -q '10' bench-tmp/report.txt && " +
      "grep -q 'largest' bench-tmp/report.txt && echo PASS || echo FAIL",
    setupCommands: ["rm -rf bench-tmp 2>/dev/null; mkdir -p bench-tmp"],
    teardownCommands: ["rm -rf bench-tmp"],
    expectedOutputs: ["PASS"],
    timeoutMs: 120000,
  },
  {
    id: "bash-git-workflow",
    name: "Git workflow via bash",
    category: "bash",
    difficulty: "medium",
    prompt:
      "Use bash to: 1) create a directory 'bench-git-test', " +
      "2) init a git repo inside it, " +
      "3) create and commit 3 files (a.txt, b.txt, c.txt) each with different content, " +
      "4) create a branch 'feature', " +
      "5) on the feature branch, add a line to b.txt and commit, " +
      "6) switch back to main and merge feature, " +
      "7) write 'git log --oneline' output to bench-git-test/log.txt.",
    verifyCommand:
      "test -f bench-git-test/log.txt && " +
      "grep -q 'feature' bench-git-test/log.txt 2>/dev/null || " +
      "(cd bench-git-test && git log --oneline | head -1) && echo PASS || echo FAIL",
    setupCommands: ["rm -rf bench-git-test 2>/dev/null"],
    teardownCommands: ["rm -rf bench-git-test"],
    expectedOutputs: ["PASS"],
    timeoutMs: 180000,
  },
  {
    id: "bash-data-processing",
    name: "CSV data processing",
    category: "bash",
    difficulty: "medium",
    prompt:
      "Use bash to create bench-csv/data.csv with this content:\n" +
      "name,score,grade\nAlice,85,B\nBob,92,A\nCharlie,78,C\nDiana,95,A\nEve,88,B\n" +
      "Then use bash (awk/sed/sort/cut) to:\n" +
      "1) count total students, 2) average score, 3) list A-grade students, " +
      "4) sort by score descending. Write results to bench-csv/analysis.txt.",
    verifyCommand:
      "test -f bench-csv/analysis.txt && " +
      "grep -q '5' bench-csv/analysis.txt && " +
      "grep -q '87' bench-csv/analysis.txt && " +
      "echo PASS || echo FAIL",
    setupCommands: ["rm -rf bench-csv 2>/dev/null; mkdir -p bench-csv"],
    teardownCommands: ["rm -rf bench-csv"],
    expectedOutputs: ["PASS"],
    timeoutMs: 120000,
  },

  // ── Edit/Write tasks ──
  {
    id: "edit-fix-syntax",
    name: "Fix syntax errors in code",
    category: "edit",
    difficulty: "easy",
    prompt:
      "Create bench-edit/broken.py with the following buggy code, then fix ALL syntax errors:\n\n" +
      "```python\ndef calculate_stats(numbers)\n" +
      "    total = sum(numbers\n" +
      '    avg = total / len(numbers)\n' +
      '    print(f"Total: {total}, Average: {avg}")\n' +
      "    return {\n" +
      "        'total': total,\n" +
      "        'average': avg\n" +
      "    }\n" +
      "```\n" +
      "After fixing, run 'python bench-edit/broken.py' to verify it works.",
    verifyCommand:
      "python3 bench-edit/broken.py 2>&1 || python bench-edit/broken.py 2>&1",
    setupCommands: ["rm -rf bench-edit 2>/dev/null; mkdir -p bench-edit"],
    teardownCommands: ["rm -rf bench-edit"],
    expectedOutputs: ["Total:", "Average:"],
    timeoutMs: 60000,
  },
  {
    id: "edit-add-function",
    name: "Add a function to existing code",
    category: "edit",
    difficulty: "medium",
    prompt:
      "Create bench-lib/math_utils.py with:\n\n" +
      "```python\ndef add(a, b):\n    return a + b\n\ndef multiply(a, b):\n    return a * b\n```\n\n" +
      "Then ADD these functions (keep existing ones):\n" +
      "- subtract(a, b): return a - b\n" +
      "- divide(a, b): return a / b (handle division by zero)\n" +
      "- power(a, b): return a ** b\n" +
      "Also create bench-lib/test_math.py that imports all 5 functions and tests them.",
    verifyCommand:
      "python3 bench-lib/test_math.py 2>&1 || python bench-lib/test_math.py 2>&1",
    setupCommands: ["rm -rf bench-lib 2>/dev/null; mkdir -p bench-lib"],
    teardownCommands: ["rm -rf bench-lib"],
    expectedOutputs: [],
    timeoutMs: 90000,
  },

  // ── Read + Write tasks (multi-file) ──
  {
    id: "readwrite-project-scaffold",
    name: "Scaffold a multi-file project",
    category: "read+write",
    difficulty: "medium",
    prompt:
      "Create a small web project in bench-web/ with these files:\n" +
      "1. index.html - basic HTML5 page with a heading, paragraph, and script tag\n" +
      "2. style.css - styles: body centered, max-width 800px, dark background #1a1a2e, light text #eee\n" +
      "3. script.js - console.log('loaded'), then a function that counts clicks on the heading\n" +
      "4. README.md - project name 'Bench Web', description, how to open\n" +
      "After creating all files, list them with 'ls -la bench-web/'",
    verifyCommand:
      "test -f bench-web/index.html && test -f bench-web/style.css && " +
      "test -f bench-web/script.js && test -f bench-web/README.md && echo PASS || echo FAIL",
    setupCommands: ["rm -rf bench-web 2>/dev/null; mkdir -p bench-web"],
    teardownCommands: ["rm -rf bench-web"],
    expectedOutputs: ["PASS"],
    timeoutMs: 120000,
  },

  // ── Debug tasks ──
  {
    id: "debug-logic-error",
    name: "Find and fix a logic bug",
    category: "debug",
    difficulty: "medium",
    prompt:
      "Create bench-debug/buggy_sort.py with this intentionally broken bubble sort:\n\n" +
      "```python\ndef bubble_sort(arr):\n" +
      "    n = len(arr)\n" +
      "    for i in range(n):\n" +
      "        for j in range(i):  # BUG: should be range(n-1-i) or similar\n" +
      "            if arr[j] > arr[j+1]:\n" +
      "                arr[j], arr[j+1] = arr[j+1], arr[j]\n" +
      "    return arr\n\n" +
      "test = [64, 34, 25, 12, 22, 11, 90]\n" +
      "result = bubble_sort(test)\n" +
      'print("Sorted:", result)\n' +
      'print("PASS" if result == sorted(test) else "FAIL: not sorted correctly")\n' +
      "```\n\n" +
      "Run it, observe the FAIL, then FIX the bug so it prints PASS.",
    verifyCommand:
      "python3 bench-debug/buggy_sort.py 2>&1 || python bench-debug/buggy_sort.py 2>&1",
    setupCommands: ["rm -rf bench-debug 2>/dev/null; mkdir -p bench-debug"],
    teardownCommands: ["rm -rf bench-debug"],
    expectedOutputs: ["PASS"],
    timeoutMs: 90000,
  },
  {
    id: "debug-import-error",
    name: "Fix import/dependency error",
    category: "debug",
    difficulty: "easy",
    prompt:
      "Create bench-import/main.py:\n\n" +
      "```python\n" +
      "from utils.helper import format_name\n\n" +
      'name = format_name("john", "doe")\n' +
      'print(f"Formatted: {name}")\n' +
      'print("PASS" if name == "John Doe" else "FAIL")\n' +
      "```\n\n" +
      "Also create the missing module at bench-import/utils/helper.py with the format_name function " +
      "that capitalizes first letters and joins with space. Make it work so it prints PASS.",
    verifyCommand:
      "cd bench-import && (python3 main.py 2>&1 || python main.py 2>&1)",
    setupCommands: [
      "rm -rf bench-import 2>/dev/null; mkdir -p bench-import/utils",
      "touch bench-import/utils/__init__.py",
    ],
    teardownCommands: ["rm -rf bench-import"],
    expectedOutputs: ["PASS"],
    timeoutMs: 60000,
  },

  // ── Refactor tasks ──
  {
    id: "refactor-extract-function",
    name: "Extract repeated code into functions",
    category: "refactor",
    difficulty: "hard",
    prompt:
      "Create bench-refactor/repetitive.py with intentionally repetitive code:\n\n" +
      "```python\n" +
      'import json, os\n\n' +
      "# Task 1: read and parse a JSON config\n" +
      "with open('config_a.json', 'w') as f:\n" +
      '    json.dump({"port": 8080, "host": "localhost"}, f)\n' +
      "with open('config_a.json') as f:\n" +
      "    config_a = json.load(f)\n" +
      'print(f"Config A: port={config_a[\'port\']}")\n\n' +
      "# Task 2: read and parse another JSON config (same pattern)\n" +
      "with open('config_b.json', 'w') as f:\n" +
      '    json.dump({"workers": 4, "timeout": 30}, f)\n' +
      "with open('config_b.json') as f:\n" +
      "    config_b = json.load(f)\n" +
      'print(f"Config B: workers={config_b[\'workers\']}")\n\n' +
      "# Task 3: read and parse a third (same pattern again)\n" +
      "with open('config_c.json', 'w') as f:\n" +
      '    json.dump({"debug": True, "log_level": "INFO"}, f)\n' +
      "with open('config_c.json') as f:\n" +
      "    config_c = json.load(f)\n" +
      'print(f"Config C: debug={config_c[\'debug\']}")\n' +
      "```\n\n" +
      "REFACTOR this to extract the repeated pattern into a reusable function. " +
      "The refactored code should produce the exact same output when run.",
    verifyCommand:
      "python3 bench-refactor/repetitive.py 2>&1 || python bench-refactor/repetitive.py 2>&1",
    setupCommands: ["rm -rf bench-refactor 2>/dev/null; mkdir -p bench-refactor"],
    teardownCommands: ["rm -rf bench-refactor"],
    expectedOutputs: ["Config A:", "Config B:", "Config C:"],
    timeoutMs: 120000,
  },
];

// ─── Configuration ───────────────────────────────────────────────

const BENCHMARK_DIR = path.join(".pi", "harness", "benchmarks");
const RESULTS_DIR = path.join(BENCHMARK_DIR, "results");
const TASKS_CONFIG_FILE = path.join(BENCHMARK_DIR, "tasks.json");

// ─── Helpers ─────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function generateId(): string {
  return `bench-${Date.now().toString(36)}`;
}

function loadTasks(cwd: string): BenchmarkTask[] {
  const file = path.join(cwd, TASKS_CONFIG_FILE);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {}
  }
  // Fall back to built-in tasks, and write them for customization
  ensureDir(path.join(cwd, BENCHMARK_DIR));
  fs.writeFileSync(file, JSON.stringify(BUILTIN_TASKS, null, 2), "utf-8");
  return BUILTIN_TASKS;
}

function computeHash(data: string): string {
  let hash = 5381;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) + hash + data.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ─── Benchmark Runner ────────────────────────────────────────────

function runTeardown(task: BenchmarkTask, cwd: string): void {
  if (task.teardownCommands) {
    for (const cmd of task.teardownCommands) {
      try {
        execSync(cmd, { cwd, timeout: 10000, stdio: "pipe" });
      } catch {}
    }
  }
}

async function runSingleTask(
  task: BenchmarkTask,
  cwd: string,
  _pi: ExtensionAPI
): Promise<TaskResult> {
  const startTime = Date.now();
  let tokensConsumed = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let agentTurns = 0;

  // Run setup
  if (task.setupCommands) {
    for (const cmd of task.setupCommands) {
      try {
        execSync(cmd, { cwd, timeout: 10000, stdio: "pipe" });
      } catch {
        // Setup might fail if cleaning up non-existent dirs
      }
    }
  }

  try {
    // Try verification immediately — check if expected outputs already exist
    let verificationOutput = "";
    try {
      verificationOutput = execSync(task.verifyCommand, {
        cwd,
        timeout: 30000,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
    } catch (e: any) {
      verificationOutput = e.stdout?.trim() || e.stderr?.trim() || e.message;
    }

    const passed = verificationOutput.includes("PASS");
    const hasExpected =
      !task.expectedOutputs ||
      task.expectedOutputs.length === 0 ||
      task.expectedOutputs.some((eo) => verificationOutput.includes(eo));

    if (passed || hasExpected) {
      runTeardown(task, cwd);
      return {
        taskId: task.id,
        harnessVersion: "current",
        outcome: "pass",
        tokensConsumed: 0,
        toolCalls: 0,
        toolErrors: 0,
        wallClockMs: Date.now() - startTime,
        agentTurns: 0,
        verificationOutput,
      };
    }

    // Task not yet completed — queue the prompt for the agent
    // Don't teardown yet: the agent needs the workspace to work on the task
    try {
      _pi.sendUserMessage?.(task.prompt, { deliverAs: "steer" });
    } catch {
      // sendUserMessage may throw if agent is not idle; ignore
    }

    return {
      taskId: task.id,
      harnessVersion: "current",
      outcome: "fail",
      tokensConsumed: 0,
      toolCalls: 0,
      toolErrors: 0,
      wallClockMs: Date.now() - startTime,
      agentTurns: 0,
      errorMessage: "Task not yet completed. Agent has been prompted. Run verification again after agent finishes.",
      verificationOutput,
    };
  } catch (e: any) {
    runTeardown(task, cwd);
    return {
      taskId: task.id,
      harnessVersion: "current",
      outcome: "error",
      tokensConsumed: 0,
      toolCalls: 0,
      toolErrors: 0,
      wallClockMs: Date.now() - startTime,
      agentTurns: 0,
      errorMessage: e.message,
    };
  }
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Tool: List available benchmark tasks ──
  pi.registerTool({
    name: "ahe_bench_list",
    label: "AHE List Benchmarks",
    description:
      "List all available benchmark tasks with categories and difficulty.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category (bash, edit, read+write, debug, refactor)",
        },
        difficulty: {
          type: "string",
          enum: ["easy", "medium", "hard"],
          description: "Filter by difficulty",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const tasks = loadTasks(ctx.cwd);
      let filtered = tasks;

      if (params.category) {
        filtered = filtered.filter((t) => t.category === params.category);
      }
      if (params.difficulty) {
        filtered = filtered.filter((t) => t.difficulty === params.difficulty);
      }

      const lines: string[] = [
        `# Available Benchmarks (${filtered.length} tasks)`,
        "",
        "| ID | Name | Category | Difficulty | Timeout |",
        "|----|------|----------|------------|---------|",
      ];

      for (const t of filtered) {
        lines.push(
          `| ${t.id} | ${t.name} | ${t.category} | ${t.difficulty} | ${t.timeoutMs / 1000}s |`
        );
      }

      lines.push("");
      lines.push("## Categories");
      lines.push(
        `- **bash**: ${tasks.filter((t) => t.category === "bash").length} tasks`
      );
      lines.push(
        `- **edit**: ${tasks.filter((t) => t.category === "edit").length} tasks`
      );
      lines.push(
        `- **read+write**: ${tasks.filter((t) => t.category === "read+write").length} tasks`
      );
      lines.push(
        `- **debug**: ${tasks.filter((t) => t.category === "debug").length} tasks`
      );
      lines.push(
        `- **refactor**: ${tasks.filter((t) => t.category === "refactor").length} tasks`
      );
      lines.push("");
      lines.push("## Usage");
      lines.push("Run a single task: `ahe_bench_run` with `taskId`");
      lines.push("Run all tasks: `ahe_bench_run` with `taskId: 'all'`");
      lines.push("Compare runs: `ahe_bench_compare`");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { total: tasks.length, filtered: filtered.length },
      };
    },
  });

  // ── Tool: Run benchmark tasks ──
  pi.registerTool({
    name: "ahe_bench_run",
    label: "AHE Run Benchmark",
    description:
      "Run benchmark tasks and measure success rate, token usage, tool errors. Use this to establish a baseline before harness edits, and again after to measure delta.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Task ID to run, or 'all' to run the entire suite. Use 'dry-run' to only verify existing files.",
        },
        label: {
          type: "string",
          description:
            "Label for this run (e.g., 'baseline', 'evolved-1', 'after-tool-fix')",
        },
      },
      required: ["taskId"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const tasks = loadTasks(cwd);
      const label = params.label || "run-" + getTimestamp();

      let tasksToRun: BenchmarkTask[];
      if (params.taskId === "all") {
        tasksToRun = tasks;
      } else if (params.taskId === "dry-run") {
        // Dry run: only verify, don't send prompts
        tasksToRun = [];
        return runDryBenchmark(tasks, cwd, label);
      } else {
        const found = tasks.find((t) => t.id === params.taskId);
        if (!found) {
          return {
            content: [
              {
                type: "text",
                text: `Task '${params.taskId}' not found. Use ahe_bench_list to see available tasks.`,
              },
            ],
          };
        }
        tasksToRun = [found];
      }

      // Load previous results to determine harness version
      const prevRuns = loadPreviousRuns(cwd);
      const harnessVersion =
        prevRuns.length === 0
          ? "baseline"
          : `evolved-${prevRuns.length}`;

      // Also snapshot harness before running
      try {
        // Force component snapshot
        const componentsDir = path.join(cwd, ".pi", "harness");
        const snapshotDir = path.join(componentsDir, "snapshots");
        ensureDir(snapshotDir);
        const snapFile = path.join(
          snapshotDir,
          `bench-snapshot-${label}.json`
        );
        const components = listHarnessFiles(cwd);
        fs.writeFileSync(
          snapFile,
          JSON.stringify(
            {
              timestamp: getTimestamp(),
              label,
              harnessVersion,
              files: components,
            },
            null,
            2
          ),
          "utf-8"
        );
      } catch {}

      // Run tasks
      const results: TaskResult[] = [];
      for (const task of tasksToRun) {
        // Update progress
        _onUpdate?.({
          type: "text",
          text: `Running: ${task.id} (${task.name})...`,
        });

        const result = await runSingleTask(task, cwd, pi);
        result.harnessVersion = harnessVersion;
        results.push(result);
      }

      // Build run summary
      const run = buildRunSummary(results, harnessVersion, label, cwd);

      // Save
      ensureDir(path.join(cwd, RESULTS_DIR));
      const runFile = path.join(
        cwd,
        RESULTS_DIR,
        `run-${run.id}.json`
      );
      fs.writeFileSync(runFile, JSON.stringify(run, null, 2), "utf-8");

      // Format output
      const lines = formatRunReport(run);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: run.summary,
      };
    },
  });

  // ── Tool: Compare two benchmark runs ──
  pi.registerTool({
    name: "ahe_bench_compare",
    label: "AHE Compare Benchmarks",
    description:
      "Compare two benchmark runs to determine if harness edits were improvements or regressions.",
    parameters: {
      type: "object",
      properties: {
        runId1: {
          type: "string",
          description:
            "First run ID (use 'baseline' for the first run). Leave empty for latest two.",
        },
        runId2: {
          type: "string",
          description:
            "Second run ID (use 'latest' for the most recent). Leave empty for latest two.",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const resultsDir = path.join(cwd, RESULTS_DIR);

      if (!fs.existsSync(resultsDir)) {
        return {
          content: [
            {
              type: "text",
              text: "No benchmark runs found. Run ahe_bench_run first to establish a baseline.",
            },
          ],
        };
      }

      const runFiles = fs
        .readdirSync(resultsDir)
        .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
        .sort((a, b) => {
          const timeA = fs.statSync(path.join(resultsDir, a)).mtimeMs;
          const timeB = fs.statSync(path.join(resultsDir, b)).mtimeMs;
          return timeA - timeB;
        });

      if (runFiles.length < 2) {
        return {
          content: [
            {
              type: "text",
              text:
                `Only ${runFiles.length} run(s) found. Need at least 2 to compare. ` +
                `Run ahe_bench_run again after making harness edits.`,
            },
          ],
        };
      }

      // Load the two runs
      const run1Idx = params.runId1 === "baseline" ? 0 : runFiles.length - 2;
      const run2Idx = params.runId2 === "latest" ? runFiles.length - 1 : runFiles.length - 1;

      const run1: BenchmarkRun = JSON.parse(
        fs.readFileSync(path.join(resultsDir, runFiles[run1Idx]), "utf-8")
      );
      const run2: BenchmarkRun = JSON.parse(
        fs.readFileSync(path.join(resultsDir, runFiles[run2Idx]), "utf-8")
      );

      const comparison = buildComparison(run1, run2);

      // Save comparison
      const compFile = path.join(
        cwd,
        RESULTS_DIR,
        `comparison-${run1.id}-vs-${run2.id}.json`
      );
      fs.writeFileSync(compFile, JSON.stringify(comparison, null, 2), "utf-8");

      // Also update decision log if a pending prediction exists
      const decisionsDir = path.join(cwd, ".pi", "harness", "decisions");
      const decisionFile = path.join(decisionsDir, "decision-log.json");
      if (fs.existsSync(decisionFile)) {
        try {
          const decisions = JSON.parse(fs.readFileSync(decisionFile, "utf-8"));
          const pending = decisions.contracts?.filter(
            (c: any) => c.status === "pending"
          );
          if (pending?.length > 0) {
            // Auto-verify the latest pending decision
            const latest = pending[pending.length - 1];
            if (comparison.verdict === "improvement") {
              latest.status = "verified";
              latest.verification.actual = comparison.deltas.passRateDelta;
              latest.verification.verifiedAt = getTimestamp();
            } else if (comparison.verdict === "regression") {
              latest.status = "falsified";
              latest.verification.actual = comparison.deltas.passRateDelta;
              latest.verification.verifiedAt = getTimestamp();
            }
            fs.writeFileSync(
              decisionFile,
              JSON.stringify(decisions, null, 2),
              "utf-8"
            );
          }
        } catch {}
      }

      // Format output
      const lines = formatComparisonReport(comparison);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          verdict: comparison.verdict,
          deltas: comparison.deltas,
        },
      };
    },
  });

  // ── Commands ──
  pi.registerCommand("ahe:bench", {
    description: "Run AHE benchmark suite",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify(
          "Usage: /ahe:bench <task-id|all> [label]. Use 'list' to see available tasks.",
          "info"
        );
        return;
      }
      ctx.ui.notify(
        "Use the ahe_bench_run tool via the Agent to run benchmarks programmatically.",
        "info"
      );
    },
  });

  pi.registerCommand("ahe:bench:compare", {
    description: "Compare two benchmark runs",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Use ahe_bench_compare tool via the Agent to compare runs.",
        "info"
      );
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────

function listHarnessFiles(cwd: string): Array<{ path: string; hash: string }> {
  const files: Array<{ path: string; hash: string }> = [];
  const dirs = [
    path.join(cwd, ".pi", "extensions"),
    path.join(cwd, ".pi", "skills"),
    path.join(cwd, ".pi", "prompts"),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, entry.name);
        if (entry.isFile() && !fp.includes("node_modules")) {
          try {
            files.push({
              path: path.relative(cwd, fp),
              hash: computeHash(fs.readFileSync(fp, "utf-8")),
            });
          } catch {}
        } else if (entry.isDirectory() && !fp.includes("node_modules")) {
          walk(fp);
        }
      }
    };
    walk(dir);
  }

  // Also check settings and AGENTS.md
  for (const f of [".pi/settings.json", "AGENTS.md", "CLAUDE.md"]) {
    const fp = path.join(cwd, f);
    if (fs.existsSync(fp)) {
      try {
        files.push({
          path: f,
          hash: computeHash(fs.readFileSync(fp, "utf-8")),
        });
      } catch {}
    }
  }

  return files;
}

function loadPreviousRuns(cwd: string): BenchmarkRun[] {
  const resultsDir = path.join(cwd, RESULTS_DIR);
  if (!fs.existsSync(resultsDir)) return [];

  return fs
    .readdirSync(resultsDir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(resultsDir, f), "utf-8")
        );
      } catch {
        return null;
      }
    })
    .filter(Boolean) as BenchmarkRun[];
}

function buildRunSummary(
  results: TaskResult[],
  harnessVersion: string,
  label: string,
  cwd: string
): BenchmarkRun {
  const passed = results.filter((r) => r.outcome === "pass").length;
  const failed = results.filter((r) => r.outcome === "fail").length;
  const timeout = results.filter((r) => r.outcome === "timeout").length;
  const error = results.filter((r) => r.outcome === "error").length;

  // Compute average metrics (only from successful and failed runs, not timeout/error)
  const scored = results.filter(
    (r) => r.outcome === "pass" || r.outcome === "fail"
  );
  const avgTokens =
    scored.length > 0
      ? scored.reduce((s, r) => s + r.tokensConsumed, 0) / scored.length
      : 0;
  const avgToolCalls =
    scored.length > 0
      ? scored.reduce((s, r) => s + r.toolCalls, 0) / scored.length
      : 0;
  const avgToolErrors =
    scored.length > 0
      ? scored.reduce((s, r) => s + r.toolErrors, 0) / scored.length
      : 0;
  const avgTimeMs =
    scored.length > 0
      ? scored.reduce((s, r) => s + r.wallClockMs, 0) / scored.length
      : 0;

  return {
    id: generateId(),
    timestamp: getTimestamp(),
    harnessVersion,
    harnessSnapshotPath: path.join(
      cwd,
      ".pi/harness/snapshots",
      `bench-snapshot-${label}.json`
    ),
    tasks: results,
    summary: {
      total: results.length,
      passed,
      failed,
      timeout,
      error,
      passRate: results.length > 0 ? passed / results.length : 0,
      avgTokens,
      avgToolCalls,
      avgToolErrors,
      avgTimeMs,
      totalCost: { input: 0, output: 0, total: 0 },
    },
  };
}

function buildComparison(
  baseline: BenchmarkRun,
  evolved: BenchmarkRun
): BenchmarkComparison {
  const passRateDelta =
    evolved.summary.passRate - baseline.summary.passRate;
  const avgTokensDelta =
    evolved.summary.avgTokens - baseline.summary.avgTokens;
  const avgTimeDelta =
    evolved.summary.avgTimeMs - baseline.summary.avgTimeMs;
  const avgToolErrorsDelta =
    evolved.summary.avgToolErrors - baseline.summary.avgToolErrors;

  // Determine verdict
  let verdict: BenchmarkComparison["verdict"];
  const betterPassRate = passRateDelta > 0.01; // 1% improvement threshold
  const worsePassRate = passRateDelta < -0.01;
  const fewerTokens = avgTokensDelta < -100; // 100 fewer tokens on average
  const moreTokens = avgTokensDelta > 100;

  if (betterPassRate && fewerTokens) {
    verdict = "improvement";
  } else if (worsePassRate || (moreTokens && !betterPassRate)) {
    verdict = "regression";
  } else if (betterPassRate || fewerTokens) {
    verdict = "mixed";
  } else if (
    Math.abs(passRateDelta) < 0.01 &&
    Math.abs(avgTokensDelta) < 100
  ) {
    verdict = "no-change";
  } else {
    verdict = "mixed";
  }

  // Per-task comparison
  const perTask = baseline.tasks.map((bt) => {
    const et = evolved.tasks.find((t) => t.taskId === bt.taskId);
    if (!et) {
      return {
        taskId: bt.taskId,
        baselineResult: bt,
        evolvedResult: bt,
        delta: "N/A (not in evolved run)",
      };
    }

    const bPassed = bt.outcome === "pass";
    const ePassed = et.outcome === "pass";
    const tokenDelta = et.tokensConsumed - bt.tokensConsumed;
    const timeDelta = et.wallClockMs - bt.wallClockMs;

    let delta = "";
    if (!bPassed && ePassed) delta = "✅ Fixed (was failing)";
    else if (bPassed && !ePassed) delta = "❌ Broke (was passing)";
    else if (bPassed && ePassed) {
      if (tokenDelta < -100) delta = `📈 Better (${Math.round(tokenDelta)} tokens)`;
      else if (tokenDelta > 100) delta = `📉 Worse (${Math.round(tokenDelta)} tokens)`;
      else delta = "➡️ Same";
    } else if (!bPassed && !ePassed) {
      delta = "⏳ Still failing";
    }

    return {
      taskId: bt.taskId,
      baselineResult: bt,
      evolvedResult: et,
      delta,
    };
  });

  return {
    baselineRun: baseline,
    evolvedRun: evolved,
    verdict,
    deltas: {
      passRateDelta,
      avgTokensDelta,
      avgTimeDelta,
      avgToolErrorsDelta,
    },
    perTask,
  };
}

// ─── Dry-run: verify existing files without agent interaction ───

function runDryBenchmark(
  tasks: BenchmarkTask[],
  cwd: string,
  label: string
): { content: Array<{ type: string; text: string }>; details: any } {
  // For dry-run, we just run verify commands against whatever files exist
  // This is useful for quick checking without running the full agent
  const results: TaskResult[] = [];

  for (const task of tasks) {
    let outcome: TaskResult["outcome"] = "fail";
    let verificationOutput = "";

    try {
      verificationOutput = execSync(task.verifyCommand, {
        cwd,
        timeout: 15000,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
      const passed = verificationOutput.includes("PASS");
      outcome = passed ? "pass" : "fail";
    } catch (e: any) {
      verificationOutput = e.stdout?.trim() || e.stderr?.trim() || e.message;
      outcome = "fail";
    }

    results.push({
      taskId: task.id,
      harnessVersion: "dry-run",
      outcome,
      tokensConsumed: 0,
      toolCalls: 0,
      toolErrors: 0,
      wallClockMs: 0,
      agentTurns: 0,
      verificationOutput,
    });
  }

  const passed = results.filter((r) => r.outcome === "pass").length;
  const lines: string[] = [
    `## Dry-run Verification (no agent interaction)`,
    "",
    `| Task | Outcome | Notes |`,
    `|------|---------|-------|`,
  ];

  for (const r of results) {
    const icon = r.outcome === "pass" ? "✅" : "❌";
    lines.push(
      `| ${r.taskId} | ${icon} ${r.outcome} | ${r.verificationOutput?.slice(0, 80) || ""} |`
    );
  }

  lines.push("");
  lines.push(
    `**Pass rate:** ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(1)}%)`
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { total: results.length, passed },
  };
}

// ─── Report Formatting ───────────────────────────────────────────

function formatRunReport(run: BenchmarkRun): string[] {
  const lines: string[] = [
    `# Benchmark Run: ${run.id}`,
    "",
    `- **Harness version:** ${run.harnessVersion}`,
    `- **Timestamp:** ${run.timestamp}`,
    `- **Tasks:** ${run.summary.total}`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Pass rate | ${(run.summary.passRate * 100).toFixed(1)}% (${run.summary.passed}/${run.summary.total}) |`,
    `| Failed | ${run.summary.failed} |`,
    `| Timeout | ${run.summary.timeout} |`,
    `| Errors | ${run.summary.error} |`,
    `| Avg tokens | ${Math.round(run.summary.avgTokens).toLocaleString()} |`,
    `| Avg tool calls | ${Math.round(run.summary.avgToolCalls)} |`,
    `| Avg tool errors | ${run.summary.avgToolErrors.toFixed(1)} |`,
    `| Avg time | ${(run.summary.avgTimeMs / 1000).toFixed(1)}s |`,
    "",
    "## Per-Task Results",
    "",
    "| Task | Outcome | Tokens | Tools | Errors | Time |",
    "|------|---------|--------|-------|--------|------|",
  ];

  for (const r of run.tasks) {
    const icon =
      r.outcome === "pass" ? "✅" : r.outcome === "fail" ? "❌" : r.outcome === "timeout" ? "⏰" : "💥";
    lines.push(
      `| ${r.taskId} | ${icon} ${r.outcome} | ${Math.round(r.tokensConsumed).toLocaleString()} | ${r.toolCalls} | ${r.toolErrors} | ${(r.wallClockMs / 1000).toFixed(1)}s |`
    );
  }

  return lines;
}

function formatComparisonReport(comp: BenchmarkComparison): string[] {
  const lines: string[] = [
    `# Benchmark Comparison: ${comp.baselineRun.harnessVersion} → ${comp.evolvedRun.harnessVersion}`,
    "",
    `## Verdict: ${verdictEmoji(comp.verdict)} **${comp.verdict.toUpperCase()}**`,
    "",
    "## Key Metrics",
    "",
    "| Metric | Baseline | Evolved | Delta |",
    "|--------|----------|---------|-------|",
    `| Pass rate | ${(comp.baselineRun.summary.passRate * 100).toFixed(1)}% | ${(comp.evolvedRun.summary.passRate * 100).toFixed(1)}% | ${comp.deltas.passRateDelta >= 0 ? "+" : ""}${(comp.deltas.passRateDelta * 100).toFixed(1)}pp |`,
    `| Avg tokens | ${Math.round(comp.baselineRun.summary.avgTokens).toLocaleString()} | ${Math.round(comp.evolvedRun.summary.avgTokens).toLocaleString()} | ${comp.deltas.avgTokensDelta >= 0 ? "+" : ""}${Math.round(comp.deltas.avgTokensDelta).toLocaleString()} |`,
    `| Avg time | ${(comp.baselineRun.summary.avgTimeMs / 1000).toFixed(1)}s | ${(comp.evolvedRun.summary.avgTimeMs / 1000).toFixed(1)}s | ${comp.deltas.avgTimeDelta >= 0 ? "+" : ""}${(comp.deltas.avgTimeDelta / 1000).toFixed(1)}s |`,
    `| Avg tool errors | ${comp.baselineRun.summary.avgToolErrors.toFixed(1)} | ${comp.evolvedRun.summary.avgToolErrors.toFixed(1)} | ${comp.deltas.avgToolErrorsDelta >= 0 ? "+" : ""}${comp.deltas.avgToolErrorsDelta.toFixed(1)} |`,
    "",
    "## Per-Task Comparison",
    "",
    "| Task | Baseline | Evolved | Delta |",
    "|------|----------|---------|-------|",
  ];

  for (const pt of comp.perTask) {
    const bIcon = pt.baselineResult.outcome === "pass" ? "✅" : "❌";
    const eIcon = pt.evolvedResult.outcome === "pass" ? "✅" : "❌";
    lines.push(
      `| ${pt.taskId} | ${bIcon} | ${eIcon} | ${pt.delta} |`
    );
  }

  lines.push("");
  lines.push(
    comp.verdict === "improvement"
      ? "✅ **The harness edit improved performance.** Consider keeping the change."
      : comp.verdict === "regression"
        ? "❌ **The harness edit caused a regression.** Consider reverting or further tuning."
        : comp.verdict === "mixed"
          ? "⚠️ **Mixed results.** Some metrics improved, others degraded. Analyze per-task results."
          : "➡️ **No significant change detected.** The edit had negligible impact."
  );

  return lines;
}

function verdictEmoji(verdict: string): string {
  switch (verdict) {
    case "improvement":
      return "✅";
    case "regression":
      return "❌";
    case "mixed":
      return "⚠️";
    case "no-change":
      return "➡️";
    default:
      return "❓";
  }
}
