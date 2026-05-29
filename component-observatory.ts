/**
 * AHE Self-Improvement for Pi — Component Observatory (Pillar 1)
 *
 * Gives every editable harness component a file-level representation
 * so the action space is explicit and revertible.
 *
 * Core idea from arXiv:2604.25850:
 *   "component observability gives every editable harness component
 *    a file-level representation so the action space is explicit and revertible"
 *
 * What this module does:
 *   1. Snapshots the dynamic system prompt to a file on every agent start
 *   2. Generates a tools manifest listing all available tools
 *   3. Tracks harness changes via Git (auto-commit on snapshot)
 *   4. Maintains .pi/harness/ as a unified, Agent-editable workspace
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ─── Configuration ───────────────────────────────────────────────

const HARNESS_DIR = ".pi/harness";
const SNAPSHOTS_DIR = path.join(HARNESS_DIR, "snapshots");
const SYSTEM_PROMPT_FILE = path.join(HARNESS_DIR, "system-prompt.md");
const TOOLS_MANIFEST_FILE = path.join(HARNESS_DIR, "tools.json");
const COMPONENTS_INDEX_FILE = path.join(HARNESS_DIR, "components.json");

interface HarnessSnapshot {
  timestamp: string;
  sessionId?: string;
  systemPromptHash: string;
  componentHashes: Record<string, string>;
  toolCount: number;
  extensionCount: number;
  skillCount: number;
}

interface ToolsManifest {
  generatedAt: string;
  tools: Array<{
    name: string;
    description: string;
    source: "builtin" | "extension" | "skill";
    sourcePath?: string;
  }>;
}

interface ComponentIndex {
  generatedAt: string;
  components: Array<{
    type: string;
    name: string;
    path: string;
    editable: boolean;
    lastModified?: string;
    hash?: string;
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function hashString(s: string): string {
  // Simple DJB2 hash for change detection
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function hashFile(filePath: string): string {
  try {
    return hashString(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return "missing";
  }
}

function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function gitAutoCommit(cwd: string, message: string): boolean {
  try {
    // Check if harness dir is tracked
    const status = execSync("git status --porcelain -- .pi/harness/", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (status.trim()) {
      execSync(`git add .pi/harness/ && git commit -m "AHE: ${message}"`, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    }
    return false;
  } catch {
    // Git might not be available or harness dir not in repo
    return false;
  }
}

// ─── Main Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Lifecycle: ensure harness workspace exists ──
  pi.on("session_start", async (_event, _ctx) => {
    ensureDir(HARNESS_DIR);
    ensureDir(SNAPSHOTS_DIR);
    ensureDir(path.join(HARNESS_DIR, "evidence"));
    ensureDir(path.join(HARNESS_DIR, "decisions"));
  });

  // ── Pillar 1: Snapshot system prompt on every agent start ──
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd;
    ensureDir(path.join(cwd, HARNESS_DIR));
    ensureDir(path.join(cwd, SNAPSHOTS_DIR));

    // 1. Write system prompt to file
    const systemPrompt = event.systemPrompt || ctx.getSystemPrompt?.() || "";
    const promptFilePath = path.join(cwd, SYSTEM_PROMPT_FILE);
    const prevHash = hashFile(promptFilePath);
    fs.writeFileSync(promptFilePath, systemPrompt, "utf-8");
    const newHash = hashString(systemPrompt);

    // 2. Generate tools manifest
    const tools = pi.getAllTools?.() || [];
    const manifest: ToolsManifest = {
      generatedAt: getTimestamp(),
      tools: tools.map((t: any) => ({
        name: t.name || "unknown",
        description: t.description || "",
        source: t.source || "builtin",
        sourcePath: t.sourcePath || undefined,
      })),
    };
    const manifestPath = path.join(cwd, TOOLS_MANIFEST_FILE);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    // 3. Build component index
    const componentIndex = buildComponentIndex(cwd);
    fs.writeFileSync(
      path.join(cwd, COMPONENTS_INDEX_FILE),
      JSON.stringify(componentIndex, null, 2),
      "utf-8"
    );

    // 4. Save snapshot if system prompt changed
    if (prevHash !== newHash) {
      const snapshot: HarnessSnapshot = {
        timestamp: getTimestamp(),
        systemPromptHash: newHash,
        componentHashes: {},
        toolCount: tools.length,
        extensionCount: componentIndex.components.filter(
          (c) => c.type === "extension"
        ).length,
        skillCount: componentIndex.components.filter((c) => c.type === "skill")
          .length,
      };
      const snapshotPath = path.join(
        cwd,
        SNAPSHOTS_DIR,
        `snapshot-${getTimestamp()}.json`
      );
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
    }

    // 5. Auto git commit (non-blocking, best-effort)
    gitAutoCommit(cwd, `harness snapshot ${getTimestamp()}`);
  });

  // ── Tool: LLM can call this to view current harness state ──
  pi.registerTool({
    name: "ahe_view_harness",
    label: "AHE View Harness",
    description:
      "View the current harness state: system prompt, available tools, component index.",
    parameters: {
      type: "object",
      properties: {
        component: {
          type: "string",
          enum: ["system-prompt", "tools", "components", "all"],
          description: "Which harness component to view",
        },
      },
      required: ["component"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const results: string[] = [];

      if (params.component === "all" || params.component === "system-prompt") {
        const promptFile = path.join(cwd, SYSTEM_PROMPT_FILE);
        if (fs.existsSync(promptFile)) {
          const content = fs.readFileSync(promptFile, "utf-8");
          results.push(
            `## System Prompt (${content.length} chars)\n\n${content.slice(0, 3000)}${content.length > 3000 ? "\n\n... (truncated)" : ""}`
          );
        } else {
          results.push("## System Prompt\n\nNot yet snapshotted. The next agent turn will generate it.");
        }
      }

      if (params.component === "all" || params.component === "tools") {
        const manifestPath = path.join(cwd, TOOLS_MANIFEST_FILE);
        if (fs.existsSync(manifestPath)) {
          const manifest: ToolsManifest = JSON.parse(
            fs.readFileSync(manifestPath, "utf-8")
          );
          results.push(
            `## Tools (${manifest.tools.length} available)\n\n` +
              manifest.tools
                .map(
                  (t) =>
                    `- **${t.name}** [${t.source}]${t.sourcePath ? ` (${t.sourcePath})` : ""}: ${t.description}`
                )
                .join("\n")
          );
        } else {
          results.push("## Tools\n\nManifest not yet generated.");
        }
      }

      if (params.component === "all" || params.component === "components") {
        const indexFile = path.join(cwd, COMPONENTS_INDEX_FILE);
        if (fs.existsSync(indexFile)) {
          const index: ComponentIndex = JSON.parse(
            fs.readFileSync(indexFile, "utf-8")
          );
          results.push(
            `## Harness Components (${index.components.length})\n\n` +
              index.components
                .map(
                  (c) =>
                    `- **${c.type}** / ${c.name}: \`${c.path}\` [${c.editable ? "editable" : "read-only"}]${c.hash ? ` hash:${c.hash.slice(0, 8)}` : ""}`
                )
                .join("\n")
          );
        } else {
          results.push("## Components\n\nIndex not yet generated.");
        }
      }

      return {
        content: [{ type: "text", text: results.join("\n\n---\n\n") }],
        details: { components: params.component },
      };
    },
  });

  // ── Command: /ahe:snapshot ──
  pi.registerCommand("ahe:snapshot", {
    description: "Snapshot current harness state to .pi/harness/",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      ensureDir(path.join(cwd, HARNESS_DIR));
      ensureDir(path.join(cwd, SNAPSHOTS_DIR));

      const index = buildComponentIndex(cwd);
      fs.writeFileSync(
        path.join(cwd, COMPONENTS_INDEX_FILE),
        JSON.stringify(index, null, 2),
        "utf-8"
      );

      const committed = gitAutoCommit(cwd, `manual snapshot ${getTimestamp()}`);

      ctx.ui.notify(
        `Snapshotted ${index.components.length} harness components${committed ? " (git committed)" : ""}`,
        "info"
      );
    },
  });
}

// ─── Component Index Builder ─────────────────────────────────────

function buildComponentIndex(cwd: string): ComponentIndex {
  const components: ComponentIndex["components"] = [];

  // Extensions (global + project)
  const extDirs = [
    path.join(process.env.HOME || process.env.USERPROFILE || "~", ".pi/agent/extensions"),
    path.join(cwd, ".pi/extensions"),
  ];
  for (const dir of extDirs) {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          const fp = path.join(dir, entry.name);
          components.push({
            type: "extension",
            name: entry.name.replace(".ts", ""),
            path: fp,
            editable: true,
            hash: hashFile(fp),
          });
        } else if (entry.isDirectory()) {
          const indexPath = path.join(dir, entry.name, "index.ts");
          if (fs.existsSync(indexPath)) {
            components.push({
              type: "extension",
              name: entry.name,
              path: indexPath,
              editable: true,
              hash: hashFile(indexPath),
            });
          }
        }
      }
    }
  }

  // Skills
  const skillDirs = [
    path.join(process.env.HOME || process.env.USERPROFILE || "~", ".pi/agent/skills"),
    path.join(cwd, ".pi/skills"),
  ];
  for (const dir of skillDirs) {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillMd = path.join(dir, entry.name, "SKILL.md");
          if (fs.existsSync(skillMd)) {
            components.push({
              type: "skill",
              name: entry.name,
              path: skillMd,
              editable: true,
              hash: hashFile(skillMd),
            });
          }
        }
      }
    }
  }

  // Prompt templates
  const promptDirs = [
    path.join(process.env.HOME || process.env.USERPROFILE || "~", ".pi/agent/prompts"),
    path.join(cwd, ".pi/prompts"),
  ];
  for (const dir of promptDirs) {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const fp = path.join(dir, entry.name);
          components.push({
            type: "prompt",
            name: entry.name.replace(".md", ""),
            path: fp,
            editable: true,
            hash: hashFile(fp),
          });
        }
      }
    }
  }

  // Settings
  const settingsPaths = [
    path.join(process.env.HOME || process.env.USERPROFILE || "~", ".pi/agent/settings.json"),
    path.join(cwd, ".pi/settings.json"),
  ];
  for (const sp of settingsPaths) {
    if (fs.existsSync(sp)) {
      components.push({
        type: "settings",
        name: path.basename(path.dirname(sp)) === "agent" ? "global" : "project",
        path: sp,
        editable: true,
        hash: hashFile(sp),
      });
    }
  }

  // Context files (AGENTS.md, CLAUDE.md)
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const fp = path.join(cwd, name);
    if (fs.existsSync(fp)) {
      components.push({
        type: "context",
        name: name,
        path: fp,
        editable: true,
        hash: hashFile(fp),
      });
    }
  }

  // System prompt snapshot
  const sysPromptPath = path.join(cwd, SYSTEM_PROMPT_FILE);
  if (fs.existsSync(sysPromptPath)) {
    components.push({
      type: "system-prompt",
      name: "system-prompt.md",
      path: sysPromptPath,
      editable: false, // System prompt is read-only snapshot; edit via settings/extensions
      hash: hashFile(sysPromptPath),
    });
  }

  // Tools manifest
  const toolsPath = path.join(cwd, TOOLS_MANIFEST_FILE);
  if (fs.existsSync(toolsPath)) {
    components.push({
      type: "tools-manifest",
      name: "tools.json",
      path: toolsPath,
      editable: false,
      hash: hashFile(toolsPath),
    });
  }

  return {
    generatedAt: getTimestamp(),
    components,
  };
}
