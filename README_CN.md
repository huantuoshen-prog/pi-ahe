# pi-ahe — 智能体化 Harness 工程（pi 扩展）

[![arXiv](https://img.shields.io/badge/arXiv-2604.25850-b31b1b.svg)](https://arxiv.org/abs/2604.25850)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

基于 Lin 等人 (2026) 论文《Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses》实现的 pi 自我改进扩展。

**核心思想：** 编程智能体的 harness（工具 + 中间件 + 提示词）决定了其能力上限，但它不应该靠人工手调。AHE 通过三大可观测性支柱，让 harness 自动演化、自我改进。

---

## 它能做什么

```
分析会话轨迹 → 定位失败根因 → 编辑 harness（附带预测）→ 跑分验证 → 循环
```

每次编辑都是一个**可证伪的契约**：先声明"改这个会提升什么指标"，再用基准测试验证。证实的保留，证伪的回滚。

---

## 三大可观测性支柱

| 支柱 | 模块 | 代码量 | 功能 |
|------|------|--------|------|
| **组件可观测** | `component-observatory.ts` | 434 行 | 将每个 harness 组件映射为文件，支持 Git 版本追踪 |
| **经验可观测** | `trajectory-distiller.ts` | 780 行 | 将数百万 token 的会话轨迹蒸馏为分层证据报告 |
| **决策可观测** | `decision-logger.ts` | 669 行 | 每次编辑附带自声明预测，跑分后验证 |

---

## 已演化的三项改进

| 轮次 | 模块 | 代码量 | 效果 | 做了什么 |
|------|------|--------|------|---------|
| R1 | `python-middleware.ts` | 142 行 | **-21.4%** 工具调用 | `.py` 文件写入后自动语法检查 + 专用 `py` 工具 |
| R2 | `bash-preflight.ts` | 315 行 | **-4.5%** 工具调用 | bash 命令预检（引号配对、heredoc 闭合、括号匹配）+ 失败诊断 |
| R3 | `import-guard.ts` | 253 行 | **-4.8%** 工具调用 | Python import 缺失检测，运行前提示创建缺失模块 |

---

## 基准测试结果

```
简单任务 (9 个):   28 → 20 次调用  (-28.6%)
困难任务 (3 个):   26 → 17 次调用  (-34.6%)
预测验证:          3/3 证实，0 证伪
性能回退:          0
```

**关键发现：任务越难，改进越大。** 每个中间件消灭一类"编辑→运行→报错→再编辑"的调试往返。简单任务 0-1 个错误，收益有限；困难任务 4-5 个错误，收益叠加放大到 -34.6%。

详细报告：`AHE-Benchmark-Report.docx`

---

## 快速开始

### 方式一：克隆到项目扩展目录

```bash
cd your-project
git clone https://github.com/huantuoshen-prog/pi-ahe .pi/extensions/ahe
```

在 pi 中输入 `/reload` 即可加载全部 9 个模块。

### 方式二：作为 pi 包安装

```json
// .pi/settings.json
{
  "packages": ["git:github.com/huantuoshen-prog/pi-ahe@master"]
}
```

---

## 命令

| 命令 | 说明 |
|------|------|
| `/ahe` | 系统状态总览 |
| `/ahe:snapshot` | 快照当前 harness 到 `.pi/harness/` |
| `/ahe:analyze` | 分析最近会话 → 生成证据报告 |
| `/ahe:decide` | 记录一次 harness 编辑决策（含预测） |
| `/ahe:verify` | 验证待定预测 |
| `/ahe:report` | 完整 AHE 健康报告 |
| `/ahe:bench` | 运行基准测试套件 |
| `/ahe:dashboard` | 追踪仪表盘（跨会话数据） |
| `/ahe:evolve` | 运行一轮完整 AHE 闭环 |

---

## 工具（LLM 可调用）

| 工具 | 说明 |
|------|------|
| `ahe_view_harness` | 查看当前 harness 状态 |
| `ahe_analyze_sessions` | 分析轨迹 → 生成证据报告 |
| `ahe_log_decision` | 记录编辑 + 预测契约 |
| `ahe_verify_decision` | 用实际结果验证预测 |
| `ahe_view_decisions` | 查看决策链 |
| `ahe_bench_list` | 列出基准任务 |
| `ahe_bench_run` | 运行基准测试 |
| `ahe_bench_compare` | 对比两次跑分 |
| `ahe_telemetry` | 查看追踪仪表盘 |
| `bash_check` | 校验 bash 命令（不执行） |
| `check_imports` | 检查 Python 文件 import |
| `py` | 运行 Python（比 bash+python 更高效） |

---

## 追踪系统

所有数据跨 pi 会话和 `/reload` 持久化：

- **累计统计**：会话数、工具调用数、token 消耗
- **基准历史**：每次跑分的通过率、平均调用、token 对比
- **决策链**：每次编辑 → 预测 → 验证的完整链路
- **磁盘备份**：`.pi/harness/telemetry/store.json`

每次会话关闭时自动保存。`/reload` 或重启 pi 后自动恢复。

---

## 论文依据

Lin, J., Liu, S., Pan, C., et al. (2026).  
*Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses.*  
arXiv:2604.25850.

论文在 Terminal-Bench 2 上 10 轮 AHE 迭代将 pass@1 从 69.7% 提升到 77.0%，超越人工设计的 Codex-CLI (71.9%)。冻结的 harness 可跨基准、跨模型迁移且无需重新演化。

---

## 文件结构

```
pi-ahe/
├── index.ts                    # 主入口，串联全部模块
├── telemetry.ts                # 跨会话持久化追踪
├── component-observatory.ts    # 支柱 1：harness 文件化 + Git 追踪
├── trajectory-distiller.ts     # 支柱 2：会话轨迹蒸馏
├── decision-logger.ts          # 支柱 3：可证伪决策契约
├── benchmark-runner.ts         # 基准测试跑分 + 对比
├── python-middleware.ts        # R1：自动语法检查 + py 工具
├── bash-preflight.ts           # R2：bash 预检 + 错误诊断
├── import-guard.ts             # R3：import 缺失检测
├── SKILL.md                    # 设计文档
├── README.md                   # 英文说明
├── README_CN.md                # 中文说明（本文件）
├── package.json                # pi 包配置
└── LICENSE                     # MIT
```

---

## 许可证

MIT
