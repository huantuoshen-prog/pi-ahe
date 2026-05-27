# pi-ahe — Agentic Harness Engineering for pi

[![arXiv](https://img.shields.io/badge/arXiv-2604.25850-b31b1b.svg)](https://arxiv.org/abs/2604.25850)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Self-improving harness for [pi](https://github.com/agegr/pi-web) — the coding agent. Implements the **AHE methodology** from Lin et al. (2026) to automatically evolve harness performance through structured observability.

## What it does

The harness (tools + middleware + prompts) determines how well a coding agent performs. AHE automates harness improvement through a closed loop:

```
Explore → Debug → Evolve → Verify → (repeat)
```

## Three Observability Pillars

| Pillar | Module | Lines | Function |
|--------|--------|-------|----------|
| **Component** | `component-observatory.ts` | 434 | Snapshots every harness component to version-controlled files |
| **Experience** | `trajectory-distiller.ts` | 780 | Distills session trajectories into layered evidence reports |
| **Decision** | `decision-logger.ts` | 669 | Every edit carries a falsifiable prediction, verified against outcomes |

## Evolved Harness Improvements

Three middleware modules, evolved through the AHE loop:

| Round | Module | Lines | Gain | What it does |
|-------|--------|-------|------|-------------|
| R1 | `python-middleware.ts` | 142 | -21.4% calls | Auto-syntax-check on .py edits + dedicated `py` tool |
| R2 | `bash-preflight.ts` | 315 | -4.5% calls | Bash validation (quotes, heredocs, parens) + error diagnosis |
| R3 | `import-guard.ts` | 253 | -4.8% calls | Detects missing Python imports before execution |

## Verified Results (pi benchmarks)

```
Easy tasks (9):   28 → 20 calls  (-28.6%)
Hard tasks (3):   26 → 17 calls  (-34.6%)
Predictions:      3/3 verified, 0 falsified
Regressions:      0
```

**Key finding:** Harder tasks benefit MORE from harness improvements — each middleware eliminates one debug round-trip per error type, and hard tasks contain more errors.

Full report: [AHE-Benchmark-Report.docx](https://github.com/huantuoshen-prog/pi-ahe/releases)

## Quick Start

### Install as pi extension

```bash
# Clone into pi's project extensions
cd your-project
git clone https://github.com/huantuoshen-prog/pi-ahe .pi/extensions/ahe
```

Then in pi, run `/reload` to load all modules.

### Or install as pi package

```json
// .pi/settings.json
{
  "packages": ["git:github.com/huantuoshen-prog/pi-ahe@main"]
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/ahe` | System status + module overview |
| `/ahe:snapshot` | Snapshot harness to `.pi/harness/` |
| `/ahe:analyze` | Analyze sessions → evidence report |
| `/ahe:decide` | Log harness edit with prediction |
| `/ahe:verify` | Verify pending predictions |
| `/ahe:report` | Full AHE health report |
| `/ahe:bench` | Run benchmark suite |
| `/ahe:dashboard` | Telemetry dashboard |
| `/ahe:evolve` | Run one full AHE cycle |

## Tools (LLM-callable)

| Tool | Description |
|------|-------------|
| `ahe_view_harness` | View current harness state |
| `ahe_analyze_sessions` | Analyze trajectories → evidence |
| `ahe_log_decision` | Log edit with prediction contract |
| `ahe_verify_decision` | Verify prediction against outcomes |
| `ahe_view_decisions` | View decision chain |
| `ahe_bench_list` | List benchmark tasks |
| `ahe_bench_run` | Run benchmark suite |
| `ahe_bench_compare` | Compare two runs |
| `ahe_telemetry` | View tracking dashboard |
| `bash_check` | Validate bash without executing |
| `check_imports` | Check Python file imports |
| `py` | Run Python (faster than bash) |

## Telemetry & Tracking

All data persists across pi sessions and `/reload`:

- Cumulative session/tool/token counts
- Benchmark run history with before/after comparisons
- Decision chain (edit → prediction → verification)
- Disk backup at `.pi/harness/telemetry/store.json`

## Paper

Lin, J., Liu, S., Pan, C., et al. (2026). *Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses*. arXiv:2604.25850.

## License

MIT
