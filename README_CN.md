<p align="center">
  <img src="https://img.shields.io/badge/arXiv-2604.25850-b31b1b?style=for-the-badge&logo=arxiv&logoColor=white" alt="arXiv">
  <img src="https://img.shields.io/badge/TypeScript-4,540_lines-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/pi-extension-blueviolet?style=for-the-badge" alt="pi">
</p>

<h1 align="center">🧠 pi-ahe</h1>
<h3 align="center">Agentic Harness Engineering · 智能体化 Harness 工程</h3>
<p align="center"><em>让编码智能体的 harness 自动演化、自我改进</em></p>

---

## 📋 目录

- [背景](#-背景)
- [它能做什么](#-它能做什么)
- [三大可观测性支柱](#-三大可观测性支柱)
- [已演化的改进](#-已演化的改进)
- [基准测试结果](#-基准测试结果)
- [快速开始](#-快速开始)
- [命令参考](#-命令参考)
- [工具参考](#-工具参考)
- [追踪系统](#-追踪系统)
- [架构设计](#-架构设计)
- [论文依据](#-论文依据)
- [相关项目](#-相关项目)
- [致谢](#-致谢)
- [许可证](#-许可证)

---

## 📖 背景

### 什么是 Harness？

在编码智能体中，**harness**（脚手架/中间件层）指的是模型之外、包围模型的所有可编辑组件：

```
┌─────────────────────────────────────────┐
│                 Harness                   │
│  ┌─────────┐ ┌──────┐ ┌──────┐ ┌─────┐ │
│  │系统提示词│ │ 工具  │ │中间件│ │记忆 │ │
│  └─────────┘ └──────┘ └──────┘ └─────┘ │
│  ┌─────────┐ ┌──────┐ ┌──────────────┐  │
│  │  技能   │ │ 设置  │ │ 上下文文件   │  │
│  └─────────┘ └──────┘ └──────────────┘  │
│                    ┌──────┐              │
│                    │ 模型  │              │
│                    └──────┘              │
└─────────────────────────────────────────┘
```

Harness 决定了智能体**能做什么**和**怎么做**——它定义了工具接口、执行约束、反馈循环。目前 harness 工程仍然靠**人工手调**，因为自动化面临三大挑战：

| 挑战 | 说明 |
|------|------|
| **操作空间异构** | 可编辑组件类型多样（提示词、工具、中间件、记忆），没有统一表示 |
| **轨迹数据庞大** | 每次运行的轨迹动辄数百万 token，有用信号被淹没 |
| **归因困难** | 改了某个组件后，很难判断到底是哪个改动起了作用 |

### AHE 方案

Lin 等人 (2026) 在论文中提出了 **Agentic Harness Engineering (AHE)**——一个闭环系统，通过三大匹配的可观测性支柱解决以上挑战。在 Terminal-Bench 2 上经过 10 轮迭代，pass@1 从 69.7% 提升至 77.0%，超越人工设计的 Codex-CLI (71.9%)。更重要的是，冻结的 harness **可以跨基准、跨模型迁移**，无需重新演化——说明演化出来的组件编码的是**通用的工程经验**，而非针对特定基准的过拟合。

本项目将 AHE 方法论完整实现在 [pi](https://github.com/agegr/pi-web) 编码智能体上。

---

## ⚡ 它能做什么

```
                    ┌──────────────────────────┐
                    │     AHE 外循环             │
                    │                           │
                    │  ① Explore  分析会话轨迹   │
                    │  ② Debug    定位失败根因   │
                    │  ③ Evolve   编辑 harness   │
                    │  ④ Verify   基准验证预测   │
                    │        ↻ 循环              │
                    └──────────┬───────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ Pillar 1     │   │ Pillar 2     │   │ Pillar 3     │
   │ 组件可观测性  │   │ 经验可观测性  │   │ 决策可观测性  │
   │              │   │              │   │              │
   │ 每个组件     │   │ 轨迹蒸馏     │   │ 每次编辑     │
   │ → 文件快照   │   │ → 证据报告   │   │ → 可证伪契约  │
   └──────────────┘   └──────────────┘   └──────────────┘
```

**核心理念：** 每次 harness 编辑都是一份**可证伪的契约**——先声明预测（"改这个会把 X 指标从 A 提升到 B"），再用基准测试验证。证实的保留，证伪的回滚。这样 harness 演化就能自主进行，不会退化为盲目试错。

---

## 🔬 三大可观测性支柱

### 支柱 1：组件可观测性 (`component-observatory.ts` · 434 行)

> "component observability gives every editable harness component a file-level representation so the action space is explicit and revertible"

每次 Agent 启动时自动执行：

| 操作 | 产出 | 用途 |
|------|------|------|
| 系统提示词快照 | `.pi/harness/system-prompt.md` | Agent 可直接查看当前提示词 |
| 工具清单 | `.pi/harness/tools.json` | 列出所有可用工具及来源 |
| 组件索引 | `.pi/harness/components.json` | 所有可编辑文件的哈希值 |
| Git 自动提交 | `git commit` | 每次快照自动版本追踪 |

7 种组件类型全部文件化：扩展 · 技能 · 提示词 · 设置 · 上下文文件 · 系统提示词 · 工具清单。

### 支柱 2：经验可观测性 (`trajectory-distiller.ts` · 780 行)

> "experience observability distills millions of raw trajectory tokens into a layered, drill-down evidence corpus"

三层蒸馏架构：

```
原始会话 (JSONL)
  │
  ├─► L1 任务摘要   每个 user prompt → 成功/失败 + 关键指标
  │                 (token 消耗、工具调用、错误次数、耗时)
  │
  ├─► L2 失败聚类   同类失败归类 + 根因假设
  │                 (bash 错误、文件缺失、token 耗尽、死循环)
  │
  └─► L3 改进建议   针对具体 harness 组件的可操作编辑建议
                   (修改工具超时、增加预检、调整压缩策略)
```

LLM 可通过 `ahe_analyze_sessions` 工具直接调用，生成结构化证据报告。

### 支柱 3：决策可观测性 (`decision-logger.ts` · 669 行)

> "decision observability pairs every edit with a self-declared prediction, later verified against the next round's task-level outcomes"

每次 harness 编辑都是一份契约：

```yaml
组件:   python-middleware
编辑:   增加 .py 文件自动语法检查 + 专用 py 工具
预测:   Python 任务调试往返次数减少，平均工具调用从 4.25 降到 ≤3.0
指标:   平均工具调用数
基线:   4.25  →  目标: ≤3.0  →  实际: 2.75 ✅
状态:   verified
```

决策链完整可见：每次编辑 → 每次预测 → 每次验证 → 证实/证伪。所有数据持久化，跨 `/reload` 和重启保留。

---

## 🚀 已演化的改进

通过三轮 AHE 外循环演化出的三项中间件改进：

### Round 1: Python 中间件 (`python-middleware.ts` · 142 行)

**效果：-21.4% 工具调用（28 → 22）**

| 功能 | 说明 |
|------|------|
| 自动语法检查 | `.py` 文件写入/编辑后立即检查语法，错误内联显示 |
| 专用 `py` 工具 | 替代 `bash python3 file.py`，更快更简洁 |
| 消灭调试往返 | "编辑 → 运行 → 报错 → 再编辑" 循环从 2 轮降为 1 轮 |

### Round 2: Bash 预检 (`bash-preflight.ts` · 315 行)

**效果：-4.5% 工具调用（22 → 21）**

| 功能 | 说明 |
|------|------|
| 引号配对检查 | 单引号/双引号未闭合 → 拦截 |
| Heredoc 验证 | `<<'EOF'` 无对应 `EOF` → 拦截 |
| 括号匹配 | 圆括号/方括号/花括号不配对 → 警告 |
| 危险模式检测 | `rm -rf /` / `git push --force main` → 警告 |
| 事后诊断 | 执行失败后自动分析错误原因 + 修复建议 |

### Round 3: Import 守卫 (`import-guard.ts` · 253 行)

**效果：-4.8% 工具调用（21 → 20）**

| 功能 | 说明 |
|------|------|
| Import 扫描 | `.py` 文件写入后立即扫描 `import` / `from ... import` 语句 |
| 缺失检测 | 检查本地模块是否存在（`utils/helper.py` 等） |
| 主动提示 | 缺失模块 → 立即提示 Agent 创建，无需先运行再看到 `ModuleNotFoundError` |
| `check_imports` 工具 | LLM 可主动调用，检查指定文件的全部 import |

---

## 📊 基准测试结果

### 简单任务套件（9 个任务，5 个类别）

| 任务 | 类别 | 基线 | R1 | R2 | R3 | 节省 |
|------|------|------|----|----|----|------|
| bash-file-analysis | bash | 1 | 1 | 1 | 1 | 0 |
| bash-git-workflow | bash | 1 | 1 | 1 | 1 | 0 |
| bash-data-processing | bash | 2 | 1 | 1 | 1 | **-1** |
| edit-fix-syntax | edit | 3 | 2 | 2 | 2 | **-1** |
| edit-add-function | edit | 4 | 3 | 3 | 3 | **-1** |
| readwrite-scaffold | r/w | 5 | 5 | 5 | 5 | 0 |
| debug-logic-error | debug | 4 | 2 | 2 | 2 | **-2** |
| debug-import-error | debug | 6 | 4 | 4 | 3 | **-3** |
| refactor-extract | refactor | 2 | 2 | 2 | 2 | 0 |
| **合计** | | **28** | **22** | **21** | **20** | **-28.6%** |

### 困难任务套件（3 个任务，跨迁移验证）

*（这些任务在演化过程中从未出现过——测试冻结 harness 迁移能力）*

| 任务 | 描述 | 基线 | 演化后 | 节省 |
|------|------|------|--------|------|
| H1 | 多文件 Python 修复（5 个错误） | 12 调用 | 8 调用 | **-33.3%** |
| H2 | Bash 数据管道（4 个陷阱） | 10 调用 | 6 调用 | **-40.0%** |
| H3 | 从零构建 CLI 工具 | 4 调用 | 3 调用 | **-25.0%** |
| **合计** | | **26** | **17** | **-34.6%** |

### 关键发现

```
简单任务: ████████████████████████ 28  →  ██████████████ 20  (-28.6%)
困难任务: ██████████████████████ 26    →  █████████████ 17    (-34.6%)
                                     ↑ 越难越省
```

| 发现 | 证据 |
|------|------|
| **任务越难，收益越大** | 简单任务 -28.6%，困难任务 -34.6%，最难的单个任务 (H2) -40% |
| **调试往返是最大瓶颈** | "编辑→运行→报错→再编辑" 占 Python 任务开销的 ~35% |
| **中间件是主要增益来源** | 三项改进都是中间件级别（110-315 行），未修改系统提示词 |
| **收益可跨任务迁移** | H1-H3 从未在演化中见过，但冻结 harness 仍然有效 |
| **所有预测可验证** | 3/3 预测证实，0 证伪，0 性能回退 |
| **Bash 任务快速饱和** | 第 2 轮后已达最优（1 调用/任务），优化空间在 edit/debug 类别 |

---

## 🏁 快速开始

### 方式一：克隆到项目扩展目录

```bash
cd your-pi-project
git clone https://github.com/huantuoshen-prog/pi-ahe .pi/extensions/ahe
```

在 pi 中输入 `/reload`，全部 9 个模块自动加载。输入 `/ahe` 查看状态。

### 方式二：作为 pi 包安装

```json
// .pi/settings.json
{
  "packages": ["git:github.com/huantuoshen-prog/pi-ahe@master"]
}
```

### 首次使用

```bash
/ahe                  # 查看系统状态
/ahe:analyze          # 分析最近会话，生成证据报告
/ahe:bench            # 运行基准测试，建立基线
/ahe:evolve           # 运行一轮完整 AHE 闭环
```

---

## ⌨️ 命令参考

| 命令 | 参数 | 说明 |
|------|------|------|
| `/ahe` | — | 系统状态总览（所有模块、改进、命令列表） |
| `/ahe:snapshot` | — | 快照当前 harness 到 `.pi/harness/`，自动 Git 提交 |
| `/ahe:analyze` | `[会话数]` | 分析最近 N 个会话 → 生成分层证据报告 |
| `/ahe:decide` | `<组件> <编辑> <预测>` | 记录一次 harness 编辑决策（附带预测契约） |
| `/ahe:verify` | — | 验证所有 pending 状态的预测 |
| `/ahe:report` | — | 完整 AHE 健康报告（证据+决策+基准总览） |
| `/ahe:bench` | `<task-id\|all>` | 运行基准测试 |
| `/ahe:bench:compare` | — | 对比最近两次基准跑分 |
| `/ahe:dashboard` | — | 追踪仪表盘（跨会话累计数据） |
| `/ahe:evolve` | — | 运行一轮完整 AHE 闭环 |
| `/ahe:py` | — | 查看 Python 中间件状态 |
| `/ahe:bash-check` | — | 查看 Bash 预检状态 |
| `/ahe:imports` | — | 查看 Import 守卫状态 |

---

## 🔧 工具参考（LLM 可调用）

| 工具 | 参数 | 说明 |
|------|------|------|
| `ahe_view_harness` | `component` | 查看当前 harness 状态（提示词/工具/组件） |
| `ahe_analyze_sessions` | `sessionCount, focusArea` | 分析轨迹 → 生成结构化证据报告 |
| `ahe_log_decision` | `component, editDescription, prediction, metric, baseline, target` | 记录编辑 + 可证伪预测契约 |
| `ahe_verify_decision` | `decisionId, actualValue, conclusion` | 用实际跑分结果验证预测 |
| `ahe_view_decisions` | `filter` | 查看决策链（全部/待定/证实/证伪） |
| `ahe_bench_list` | `category, difficulty` | 列出可用基准任务 |
| `ahe_bench_run` | `taskId, label` | 运行基准测试 |
| `ahe_bench_compare` | `runId1, runId2` | 对比两次跑分，输出裁决 |
| `ahe_telemetry` | `view` | 查看追踪仪表盘 |
| `bash_check` | `command` | 校验 bash 命令语法（不执行） |
| `check_imports` | `file` | 检查 Python 文件的所有 import |
| `py` | `file, args` | 运行 Python 脚本（比 bash+python 更高效） |

---

## 📈 追踪系统

所有数据通过 `pi.appendEntry()` 跨会话持久化，`/reload` 或重启后自动恢复：

| 追踪内容 | 存储位置 |
|----------|---------|
| 累计统计 | 会话数、工具调用数、token 消耗、错误数 |
| 基准历史 | 每次跑分的通过率、平均调用、token 对比 |
| 决策链 | 编辑 → 预测 → 验证的完整链路 |
| 会话日志 | 最近 50 次会话的摘要数据 |
| 磁盘备份 | `.pi/harness/telemetry/store.json` |

每次会话关闭时自动保存。这些数据可直接用于后续改进分析和研究。

---

## 🏗️ 架构设计

```
pi-ahe/                             14 files · 4,540 行 TypeScript
│
├── 核心支柱 ─────────────────────────────
├── index.ts                   (99 行)  主入口，串联全部模块
├── component-observatory.ts  (434 行)  Pillar 1: harness 快照 + Git 追踪
├── trajectory-distiller.ts   (780 行)  Pillar 2: 轨迹蒸馏 → 证据报告
├── decision-logger.ts        (669 行)  Pillar 3: 决策契约 + 验证
│
├── 验证闭环 ─────────────────────────────
├── benchmark-runner.ts       (1,203 行) 基准跑分 + 对比 + 裁决
├── telemetry.ts              (311 行)  跨会话持久化追踪
│
├── 演化产物 ─────────────────────────────
├── python-middleware.ts      (142 行)  R1: 自动语法检查 + py 工具
├── bash-preflight.ts         (315 行)  R2: bash 预检 + 错误诊断
├── import-guard.ts           (253 行)  R3: import 缺失检测
│
├── 文档 ─────────────────────────────────
├── README.md                          英文说明
├── README_CN.md                       中文说明（本文件）
├── SKILL.md                           设计文档
├── package.json                       pi 包配置
└── LICENSE                            MIT
```

---

## 📚 论文依据

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

**核心结论：**
- 10 轮 AHE 迭代：Terminal-Bench 2 pass@1 69.7% → 77.0%（+7.3pp）
- 超越人工设计的 Codex-CLI (71.9%) 和自演化基线 ACE、TF-GRPO
- 冻结 harness 跨基准迁移：SWE-bench-verified 综合成功率最高，token 消耗减少 12%
- 跨模型迁移：3 个不同模型家族上 +5.1 到 +10.1pp
- 消融实验：增益来自工具、中间件和长期记忆，而非系统提示词

---

## 🔗 相关项目

| 项目 | 说明 | 链接 |
|------|------|------|
| **pi** | 本扩展的目标编码智能体框架 | [github.com/agegr/pi-web](https://github.com/agegr/pi-web) |
| **AHE 论文** | 原始论文 | [arxiv.org/abs/2604.25850](https://arxiv.org/abs/2604.25850) |
| **NexAU** | AHE 论文使用的 Agent 框架 | [github.com/nex-agi/NexAU](https://github.com/nex-agi/NexAU) |
| **SWE-bench** | 软件工程基准测试 | [swebench.com](https://swebench.com) |
| **Terminal-Bench** | 终端任务基准测试 | [github.com/terminal-bench](https://github.com/terminal-bench) |
| **OpenCode** | 开源编码智能体 | [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode) |
| **Claude Code** | Anthropic 编码智能体 | [github.com/anthropics/claude-code](https://github.com/anthropics/claude-code) |
| **SWE-agent** | 自动软件工程智能体 | [github.com/SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) |
| **OpenHands** | AI 软件开发者平台 | [github.com/All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) |
| **ACE (Agentic Context Engineering)** | 上下文自演化 | [openreview.net](https://openreview.net/forum?id=eC4ygDs02R) |
| **The Bitter Lesson of Agent Harnesses** | Harness 工程反思 | [browser-use.com](https://browser-use.com/posts/bitter-lesson-agent-harnesses) |

---

## 🙏 致谢

- **[Lin, Liu, Pan 等](https://arxiv.org/abs/2604.25850)** — AHE 方法论的原创作者，感谢他们开创性的工作和开源精神
- **[pi 团队](https://github.com/agegr/pi-web)** — 构建了优秀的编码智能体框架，使其可扩展、可观测
- **[NexAU 团队](https://github.com/nex-agi/NexAU)** — 提供了 AHE 论文的底层 Agent 框架
- **[SWE-bench](https://swebench.com) & [Terminal-Bench](https://github.com/terminal-bench) 团队** — 建立了编码智能体评测的行业标准
- **[Rich Sutton](http://incompleteideas.net/IncIdeas/BitterLesson.html)** — "The Bitter Lesson" 启发了 harness 工程自动化的思考
- 所有为开源编码智能体生态做出贡献的研究者和开发者

---

## 📄 许可证

MIT © 2026 [huantuoshen-prog](https://github.com/huantuoshen-prog)

---

<p align="center">
  <sub>If this project helps your research, please consider citing the original AHE paper:</sub>
</p>
<p align="center">
  <sub>Lin et al., "Agentic Harness Engineering", arXiv:2604.25850, 2026.</sub>
</p>
