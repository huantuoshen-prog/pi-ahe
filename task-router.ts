/**
 * AHE Evolution #8 — Task Router
 *
 * Classifies incoming user tasks and injects targeted best-practice
 * guidance. R5 provides general rules; R8 provides task-specific rules
 * that address the exact failure modes seen in benchmarks.
 *
 * Prediction: Targeted guidance will reduce task-type-specific waste:
 *   - git tasks: single bash chain instead of 3-4 separate calls
 *   - python-create: write correct code first, not write→edit→write
 *   - python-refactor: verify once, don't diff-compare
 *   - data-processing: single pipeline, not step-by-step
 *
 * Metric: tool calls on git, edit, refactor, data-processing tasks
 * Baseline: Task 2=4, Task 4=9, Task 9=15 (v4-pro)
 * Target: Task 2≤2, Task 4≤5, Task 9≤6
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Task Classification ─────────────────────────────────────────

type TaskType =
  | "git-workflow"
  | "python-create"
  | "python-debug"
  | "python-refactor"
  | "data-processing"
  | "file-scaffold"
  | "general";

interface TaskGuide {
  type: TaskType;
  rules: string[];
}

const TASK_GUIDES: Record<TaskType, TaskGuide> = {
  "git-workflow": {
    type: "git-workflow",
    rules: [
      "Chain ALL git commands with && in ONE bash call — mkdir && cd && git init && ... && git log > log.txt",
      "Do NOT use separate bash calls for init, commit, branch, merge. One call is enough.",
      "Do NOT read log.txt to verify — the bash stdout already confirms success.",
    ],
  },
  "python-create": {
    type: "python-create",
    rules: [
      "Write the CORRECT code directly. Do NOT write buggy code and then edit it.",
      "Use write to create all .py files in parallel in a single turn.",
      "Use py for verification. Never use bash python — it won't find the interpreter.",
      "If py returns exitCode=0 with output, the task is DONE. No further checks.",
    ],
  },
  "python-debug": {
    type: "python-debug",
    rules: [
      "Identify the bug FIRST in your thinking, then write the FIXED version directly.",
      "Do NOT write the buggy code to disk. Fix it in your head, write the correct version.",
      "Use py to verify once. If it prints PASS, you're done.",
    ],
  },
  "python-refactor": {
    type: "python-refactor",
    rules: [
      "Apply ALL refactoring changes at once in a single write.",
      "Use py to verify the refactored code produces the same output. Once is enough.",
      "Do NOT use bash diff to compare outputs. py shows the output directly.",
      "Do NOT re-run the same py command multiple times.",
    ],
  },
  "data-processing": {
    type: "data-processing",
    rules: [
      "Use a SINGLE bash pipeline with pipes and && — chain write, process, and output together.",
      "Use awk/sed/sort/cut/wc directly. No need for temporary files.",
      "The final output file IS the verification. No separate read needed.",
    ],
  },
  "file-scaffold": {
    type: "file-scaffold",
    rules: [
      "Plan ALL files first, then create them ALL with parallel write calls in ONE turn.",
      "Use ls to verify all files exist — one bash call confirms everything.",
      "Do NOT re-read files you just wrote.",
    ],
  },
  general: {
    type: "general",
    rules: [
      "Plan before acting. Batch independent operations. Verify once.",
    ],
  },
};

// ─── Classifier ──────────────────────────────────────────────────

function classifyTask(prompt: string): TaskType {
  const lower = prompt.toLowerCase();

  // Git operations
  if (/git\s+(init|commit|branch|checkout|merge|log|clone)/.test(lower)) return "git-workflow";

  // Python debug: fixing bugs, errors
  if (/debug|bug|error|crash|broken|wrong|fix.*bug|fix.*error/i.test(lower) && /\.py|python/i.test(lower)) return "python-debug";
  if (/修复|bug|错误/.test(lower) && /py|python/.test(lower)) return "python-debug";

  // Python refactor
  if (/refactor|extract.*function|重复|提取.*函数|重构/.test(lower) && (/\.py|python/i.test(lower) || /import|def\s/.test(lower))) return "python-refactor";

  // Python create: writing new code
  if (/创建|create|write.*\.py|python.*script/i.test(lower) && /function|def|class|import/i.test(lower)) return "python-create";
  if (/\.py/.test(lower) && /write|create|make|build|scaffold/i.test(lower)) return "python-create";

  // Data processing
  if (/csv|awk|sed|sort|cut|grep|data.*process|统计|平均|排序/.test(lower) && !/git/i.test(lower)) return "data-processing";

  // File scaffold: creating multiple independent files
  if (/scaffold|create.*files?|创建.*文件/.test(lower) && /html|css|js|readme/i.test(lower)) return "file-scaffold";
  if (/\.html.*\.css.*\.js/i.test(lower) || /html.*css.*js/i.test(lower)) return "file-scaffold";

  return "general";
}

// ─── Helper ──────────────────────────────────────────────────────

function buildSteerMessage(guide: TaskGuide, prompt: string): string {
  const rules = guide.rules.map((r) => `  - ${r}`).join("\n");
  const label =
    guide.type === "git-workflow" ? "Git 工作流" :
    guide.type === "python-create" ? "Python 代码创建" :
    guide.type === "python-debug" ? "Python Debug" :
    guide.type === "python-refactor" ? "Python 重构" :
    guide.type === "data-processing" ? "数据处理" :
    guide.type === "file-scaffold" ? "多文件创建" : "通用任务";

  return (
    `[Task Router] 检测到任务类型: **${label}**\n\n` +
    `针对此类任务的高效指南:\n${rules}`
  );
}

// ─── Cooldown ─────────────────────────────────────────────────────

const COOLDOWN_MS = 10_000; // Don't route again within 10s (avoids double-fire)
let lastRouteTime = 0;

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("message_start", async (event, _ctx) => {
    const now = Date.now();
    if (now - lastRouteTime < COOLDOWN_MS) return;

    const msg = (event as any).message || (event as any);
    if (msg.role !== "user") return;

    const prompt =
      msg.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join(" ") || "";

    if (!prompt || prompt.length < 10) return;

    const taskType = classifyTask(prompt);
    if (taskType === "general") return; // Don't inject for unclassified tasks

    const guide = TASK_GUIDES[taskType];
    const steerMsg = buildSteerMessage(guide, prompt);

    lastRouteTime = now;

    try {
      pi.sendUserMessage(steerMsg, { deliverAs: "steer" });
    } catch {
      // If sendUserMessage throws (agent not idle), skip silently
    }
  });

  // ── Command ──
  pi.registerCommand("ahe:route", {
    description: "Show task router status / classify current task",
    handler: async (_args, ctx) => {
      ctx.ui.notify?.(
        `Task router active — classifies tasks into 6 types and injects targeted guidance`,
        "info"
      );
    },
  });
}
