<p align="center">
  <img src="https://img.shields.io/badge/arXiv-2604.25850-b31b1b?style=for-the-badge&logo=arxiv&logoColor=white" alt="arXiv">
  <img src="https://img.shields.io/badge/TypeScript-4,540_lines-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/pi-extension-blueviolet?style=for-the-badge" alt="pi">
</p>

<h1 align="center">🧠 pi-ahe</h1>
<h3 align="center">Agentic Harness Engineering for pi</h3>
<p align="center"><em>Self-improving harness that evolves autonomously through structured observability</em></p>

<p align="center">
  <a href="README_CN.md">📄 中文说明</a>
</p>

---

## 📋 Contents

- [Background](#-background)
- [What It Does](#-what-it-does)
- [Three Observability Pillars](#-three-observability-pillars)
- [Evolved Improvements](#-evolved-improvements)
- [Benchmark Results](#-benchmark-results)
- [Quick Start](#-quick-start)
- [Commands](#-commands)
- [Tools (LLM-callable)](#-tools-llm-callable)
- [Telemetry & Tracking (Developer/Research)](#-telemetry--tracking-developerresearch)
- [Architecture](#-architecture)
- [Paper](#-paper)
- [Related Projects](#-related-projects)
- [Acknowledgments](#-acknowledgments)
- [License](#-license)

---

## 📖 Background

### What is a Harness?

In coding agents, the **harness** is everything around the model that shapes what it can do:

```
┌─────────────────────────────────────────┐
│                 Harness                   │
│  ┌─────────┐ ┌──────┐ ┌──────┐ ┌─────┐ │
│  │ System  │ │ Tools│ │ Mid- │ │Mem- │ │
│  │ Prompt  │ │      │ │ ware │ │ ory │ │
│  └─────────┘ └──────┘ └──────┘ └─────┘ │
│  ┌─────────┐ ┌──────┐ ┌──────────────┐  │
│  │ Skills  │ │Config│ │Context Files │  │
│  └─────────┘ └──────┘ └──────────────┘  │
│                    ┌──────┐              │
│                    │Model │              │
│                    └──────┘              │
└─────────────────────────────────────────┘
```

The harness determines what the agent **can do** and **how it does it** — tools, interfaces, execution constraints, feedback loops. Yet harness engineering today is still a manual craft, because automating it faces three challenges:

| Challenge | Description |
|-----------|-------------|
| **Heterogeneous action space** | Editable components span prompts, tools, middleware, memory — no unified representation |
| **Voluminous trajectories** | Millions of tokens per run bury actionable improvement signals |
| **Attribution problem** | Hard to tell which edit caused a performance change |

### The AHE Solution

Lin et al. (2026) introduced **Agentic Harness Engineering (AHE)** — a closed loop addressing these challenges through three matched observability pillars. Over 10 iterations on Terminal-Bench 2, pass@1 improved from 69.7% to 77.0%, surpassing the human-designed Codex-CLI (71.9%). Critically, the frozen harness **transfers cross-benchmark and cross-model** without re-evolution — indicating the evolved components encode general engineering experience, not benchmark-specific tuning.

This project implements the full AHE methodology on the [pi](https://github.com/agegr/pi-web) coding agent.

---

## ⚡ What It Does

```
                    ┌──────────────────────────┐
                    │     AHE Outer Loop         │
                    │                           │
                    │  1. Explore  (analyze)    │
                    │  2. Debug    (root cause) │
                    │  3. Evolve   (edit)       │
                    │  4. Verify   (benchmark)  │
                    │        ↻ loop             │
                    └──────────┬───────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ Pillar 1     │   │ Pillar 2     │   │ Pillar 3     │
   │ Component    │   │ Experience   │   │ Decision     │
   │ Observatory  │   │ Observatory  │   │ Observatory  │
   └──────────────┘   └──────────────┘   └──────────────┘
```

**Core idea:** Every harness edit is a **falsifiable contract** — declare a prediction ("this change will improve metric X from A to B"), then verify against benchmarks. Confirmed edits stay; falsified edits revert. Harness evolution proceeds autonomously without collapsing into trial-and-error.

---

## 🔬 Three Observability Pillars

### Pillar 1: Component Observatory (`component-observatory.ts` · 434 lines)

> *"component observability gives every editable harness component a file-level representation so the action space is explicit and revertible"*

Auto-executes on every agent start:

| Action | Output | Purpose |
|--------|--------|---------|
| System prompt snapshot | `.pi/harness/system-prompt.md` | Agent can read current prompt |
| Tools manifest | `.pi/harness/tools.json` | All available tools with sources |
| Component index | `.pi/harness/components.json` | Hashes of all editable files |
| Git auto-commit | `git commit` | Full version history |

7 component types tracked: extensions · skills · prompts · settings · context files · system prompt · tools manifest.

### Pillar 2: Experience Observatory (`trajectory-distiller.ts` · 780 lines)

> *"experience observability distills millions of raw trajectory tokens into a layered, drill-down evidence corpus"*

Three-layer distillation:

```
Raw sessions (JSONL)
  │
  ├─► L1 Task summaries    success/fail + metrics per prompt
  │                        (tokens, tool calls, errors, wall time)
  │
  ├─► L2 Failure clusters  grouped failures + root cause hypotheses
  │                        (bash errors, missing files, context exhaustion, loops)
  │
  └─► L3 Improvement suggestions   actionable edits for specific harness components
                                   (timeout tuning, pre-checks, compaction config)
```

LLM calls `ahe_analyze_sessions` to generate structured evidence reports on demand.

### Pillar 3: Decision Observatory (`decision-logger.ts` · 669 lines)

> *"decision observability pairs every edit with a self-declared prediction, later verified against the next round's task-level outcomes"*

Every harness edit is a contract:

```yaml
component:    python-middleware
edit:         auto-syntax-check on .py writes + dedicated py tool
prediction:   Python debug round-trips drop, avg calls from 4.25 to ≤3.0
metric:       avg tool calls per Python task
baseline:     4.25  →  target: ≤3.0  →  actual: 2.75 ✅
status:       verified
```

Full decision chain visible: every edit → prediction → verification. Data persists across `/reload` and restarts.

---

## 🚀 Evolved Improvements

Three middleware modules evolved through the AHE loop:

### Round 1: Python Middleware (`python-middleware.ts` · 142 lines)

**Gain: -21.4% tool calls (28 → 22)**

| Feature | Benefit |
|---------|---------|
| Auto-syntax-check | Catches errors inline on .py file writes, no separate run needed |
| Dedicated `py` tool | Replaces `bash python3 file.py` — cleaner, faster |
| Eliminates debug round-trips | "edit → run → error → edit again" drops from 2 cycles to 1 |

### Round 2: Bash Pre-flight (`bash-preflight.ts` · 315 lines)

**Gain: -4.5% tool calls (22 → 21)**

| Feature | Benefit |
|---------|---------|
| Quote balancing | Unclosed quotes → blocked before execution |
| Heredoc validation | Missing closing delimiter → blocked |
| Bracket matching | Mismatched parens/braces → warned |
| Dangerous patterns | `rm -rf /`, `git push --force main` → warned |
| Post-execution diagnosis | Auto-analyzes failures + suggests fixes |

### Round 3: Import Guard (`import-guard.ts` · 253 lines)

**Gain: -4.8% tool calls (21 → 20)**

| Feature | Benefit |
|---------|---------|
| Import scanning | Scans `import`/`from ... import` on every .py file write |
| Missing detection | Checks if local modules exist on disk |
| Proactive alert | Agent creates missing module before running — no `ModuleNotFoundError` wasted round-trip |
| `check_imports` tool | LLM can manually audit any file's imports |

---

## 📊 Benchmark Results

### Easy Suite (9 tasks, 5 categories)

| Task | Category | Base | R1 | R2 | R3 | Saved |
|------|----------|------|----|----|----|-------|
| bash-file-analysis | bash | 1 | 1 | 1 | 1 | 0 |
| bash-git-workflow | bash | 1 | 1 | 1 | 1 | 0 |
| bash-data-processing | bash | 2 | 1 | 1 | 1 | **-1** |
| edit-fix-syntax | edit | 3 | 2 | 2 | 2 | **-1** |
| edit-add-function | edit | 4 | 3 | 3 | 3 | **-1** |
| readwrite-scaffold | r/w | 5 | 5 | 5 | 5 | 0 |
| debug-logic-error | debug | 4 | 2 | 2 | 2 | **-2** |
| debug-import-error | debug | 6 | 4 | 4 | 3 | **-3** |
| refactor-extract | refactor | 2 | 2 | 2 | 2 | 0 |
| **Total** | | **28** | **22** | **21** | **20** | **-28.6%** |

### Hard Suite (3 tasks, cross-transfer)

*(These tasks were never seen during evolution — testing frozen harness transfer)*

| Task | Description | Baseline | Evolved | Saved |
|------|-------------|----------|---------|-------|
| H1 | Multi-file Python fix (5 errors) | 12 calls | 8 calls | **-33.3%** |
| H2 | Bash data pipeline (4 traps) | 10 calls | 6 calls | **-40.0%** |
| H3 | CLI tool from scratch | 4 calls | 3 calls | **-25.0%** |
| **Total** | | **26** | **17** | **-34.6%** |

### Key Findings

```
Easy tasks: ████████████████████████ 28  →  ██████████████ 20  (-28.6%)
Hard tasks: ██████████████████████ 26    →  █████████████ 17    (-34.6%)
                                        ↑ harder = bigger gains
```

| Finding | Evidence |
|---------|----------|
| **Harder tasks benefit more** | -28.6% on easy, -34.6% on hard, -40% on hardest single task (H2) |
| **Debug round-trips are the bottleneck** | "edit→run→error→edit again" accounts for ~35% of Python overhead |
| **Middleware is the primary gain source** | All 3 improvements are middleware (110-315 lines); no system prompt changes |
| **Benefits transfer to unseen tasks** | H1-H3 never seen during evolution, yet frozen harness still works |
| **All predictions verifiable** | 3/3 verified, 0 falsified, 0 regressions |
| **Bash tasks saturate early** | Optimal by Round 2 (1 call/task); further gains in edit/debug |

---

## 🏁 Quick Start

### Option 1: Clone as project extension

```bash
cd your-pi-project
git clone https://github.com/huantuoshen-prog/pi-ahe .pi/extensions/ahe
```

Type `/reload` in pi. All 9 modules auto-load. Type `/ahe` to see status.

### Option 2: Install as pi package

```json
// .pi/settings.json
{
  "packages": ["git:github.com/huantuoshen-prog/pi-ahe@master"]
}
```

### First Run

```bash
/ahe                  # View system status
/ahe:analyze          # Analyze recent sessions → evidence report
/ahe:bench            # Run benchmarks, establish baseline
/ahe:evolve           # Run a full AHE cycle
```

---

## ⌨️ Commands

| Command | Args | Description |
|---------|------|-------------|
| `/ahe` | — | System status overview (modules, improvements, commands) |
| `/ahe:snapshot` | — | Snapshot harness to `.pi/harness/` + auto git commit |
| `/ahe:analyze` | `[count]` | Analyze N sessions → layered evidence report |
| `/ahe:decide` | `<component> <edit> <prediction>` | Log harness edit with prediction contract |
| `/ahe:verify` | — | Verify all pending predictions |
| `/ahe:report` | — | Full AHE health report (evidence + decisions + benchmarks) |
| `/ahe:bench` | `<task-id\|all>` | Run benchmark suite |
| `/ahe:bench:compare` | — | Compare two most recent benchmark runs |
| `/ahe:dashboard` | — | Telemetry dashboard (cross-session data) |
| `/ahe:evolve` | — | Run a complete AHE cycle |
| `/ahe:py` | — | View Python middleware status |
| `/ahe:bash-check` | — | View Bash pre-flight status |
| `/ahe:imports` | — | View Import guard status |

---

## 🔧 Tools (LLM-callable)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `ahe_view_harness` | `component` | View current harness state |
| `ahe_analyze_sessions` | `sessionCount, focusArea` | Analyze trajectories → evidence report |
| `ahe_log_decision` | `component, editDescription, prediction, metric, baseline, target` | Log edit with falsifiable prediction |
| `ahe_verify_decision` | `decisionId, actualValue, conclusion` | Verify prediction against outcomes |
| `ahe_view_decisions` | `filter` | View decision chain |
| `ahe_bench_list` | `category, difficulty` | List available benchmarks |
| `ahe_bench_run` | `taskId, label` | Run benchmarks |
| `ahe_bench_compare` | `runId1, runId2` | Compare two runs, output verdict |
| `ahe_telemetry` | `view` | View tracking dashboard |
| `bash_check` | `command` | Validate bash syntax without executing |
| `check_imports` | `file` | Check Python file imports |
| `py` | `file, args` | Run Python (faster than bash+python) |

---

## 📈 Telemetry & Tracking (Developer/Research)

> ⚠️ **Regular users do NOT need this.** Tracking is for harness developers iterating on improvements, or researchers analyzing agent behavior. The three harness improvements (Python syntax check, Bash pre-flight, Import guard) work automatically without tracking enabled.
>
> Telemetry is OFF by default. All data stays local in `.pi/harness/telemetry/store.json` — nothing is ever sent anywhere.

### Toggle Commands (developers only)

| Command | Description |
|---------|-------------|
| `/ahe:telemetry-on` | Enable efficiency tracking (opt-in) |
| `/ahe:telemetry-off` | Disable tracking (stops new data, existing data preserved) |
| `/ahe:dashboard` | View tracking status and efficiency data |

The LLM can also toggle via `ahe_telemetry_toggle(enable: true/false)` tool.

### What is tracked (when enabled)

| Tracked | Stored At |
|---------|-----------|
| Cumulative stats | Sessions, tool calls, tokens, errors |
| Benchmark history | Pass rate, avg calls, token comparisons per run |
| Decision chain | Edit → prediction → verification (full history) |
| Session log | Last 50 sessions with summary data |
| Disk backup | `.pi/harness/telemetry/store.json` |

Auto-saved on each session shutdown. Restored on startup. Ready for research analysis.

---

## 🏗️ Architecture

```
pi-ahe/                             14 files · 4,540 TypeScript lines
│
├── Core Pillars ──────────────────────────
├── index.ts                   (99 ln)   Entry point
├── component-observatory.ts  (434 ln)  Pillar 1: harness snapshots + Git
├── trajectory-distiller.ts   (780 ln)  Pillar 2: trajectory → evidence
├── decision-logger.ts        (669 ln)  Pillar 3: prediction contracts
│
├── Verification Loop ─────────────────────
├── benchmark-runner.ts       (1,203 ln) Run + compare + verdict
├── telemetry.ts              (311 ln)  Cross-session persistence
│
├── Evolved Improvements ──────────────────
├── python-middleware.ts      (142 ln)  R1: auto-syntax-check + py tool
├── bash-preflight.ts         (315 ln)  R2: bash validation + diagnosis
├── import-guard.ts           (253 ln)  R3: missing import detection
│
├── Docs ──────────────────────────────────
├── README.md                          English (this file)
├── README_CN.md                       Chinese
├── SKILL.md                           Design doc
├── package.json                       pi package config
└── LICENSE                            MIT
```

---

## 📚 Paper

```bibtex
@article{lin2026agentic,
  title     = {Agentic Harness Engineering: Observability-Driven
               Automatic Evolution of Coding-Agent Harnesses},
  author    = {Lin, Jiahang and Liu, Shichun and Pan, Chengjun and
               Lin, Lizhi and Dou, Shihan and Xi, Zhiheng and
               Huang, Xuanjing and Yan, Hang and Han, Zhenhua and
               Gui, Tao and Jiang, Yu-Gang},
  journal   = {arXiv preprint arXiv:2604.25850},
  year      = {2026},
  url       = {https://arxiv.org/abs/2604.25850}
}
```

**Key Results:**
- 10 AHE iterations: Terminal-Bench 2 pass@1 69.7% → 77.0% (+7.3pp)
- Surpasses human-designed Codex-CLI (71.9%) and self-evolving baselines
- Frozen harness transfers to SWE-bench-verified (highest aggregate, -12% tokens)
- Cross-model transfer: +5.1 to +10.1pp across 3 model families
- Ablation: gains from tools, middleware, memory — not system prompts

---

## 🔗 Related Projects

| Project | Description | Link |
|---------|-------------|------|
| **pi** | The coding agent framework this extends | [github.com/agegr/pi-web](https://github.com/agegr/pi-web) |
| **AHE Paper** | Original paper | [arxiv.org/abs/2604.25850](https://arxiv.org/abs/2604.25850) |
| **NexAU** | Agent framework used in the paper | [github.com/nex-agi/NexAU](https://github.com/nex-agi/NexAU) |
| **SWE-bench** | Software engineering benchmark | [swebench.com](https://swebench.com) |
| **Terminal-Bench** | Terminal task benchmark | [github.com/terminal-bench](https://github.com/terminal-bench) |
| **OpenCode** | Open-source coding agent | [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode) |
| **Claude Code** | Anthropic's coding agent | [github.com/anthropics/claude-code](https://github.com/anthropics/claude-code) |
| **SWE-agent** | Automated software engineering | [github.com/SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) |
| **OpenHands** | AI software developer platform | [github.com/All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) |
| **ACE** | Agentic Context Engineering | [openreview.net](https://openreview.net/forum?id=eC4ygDs02R) |
| **The Bitter Lesson** | Harness engineering reflection | [browser-use.com](https://browser-use.com/posts/bitter-lesson-agent-harnesses) |

---

## 🙏 Acknowledgments

- **[Lin, Liu, Pan et al.](https://arxiv.org/abs/2604.25850)** — Original authors of the AHE methodology. Thank you for pioneering this work and releasing it openly.
- **[pi team](https://github.com/agegr/pi-web)** — Built the extensible, observable coding agent framework this extends.
- **[NexAU team](https://github.com/nex-agi/NexAU)** — Provided the agent substrate used in the AHE paper.
- **[SWE-bench](https://swebench.com) & [Terminal-Bench](https://github.com/terminal-bench) teams** — Established industry-standard benchmarks for coding agent evaluation.
- **[Rich Sutton](http://incompleteideas.net/IncIdeas/BitterLesson.html)** — "The Bitter Lesson" inspired thinking about automated harness engineering.
- All researchers and developers contributing to the open-source coding agent ecosystem.

---

## 📄 License

MIT © 2026 [huantuoshen-prog](https://github.com/huantuoshen-prog)

---

<p align="center">
  <sub>If this project helps your research, please consider citing the original AHE paper:</sub>
</p>
<p align="center">
  <sub>Lin et al., "Agentic Harness Engineering", arXiv:2604.25850, 2026.</sub>
</p>
