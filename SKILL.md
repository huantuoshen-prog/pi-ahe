---
name: ahe-self-improvement
description: >
  Applies the Agentic Harness Engineering (AHE) methodology from arXiv 2604.25850 to
  pi itself. Implements three observability pillars: (1) component observability —
  all harness parts become versioned files; (2) experience observability — session
  trajectories are distilled into structured evidence; (3) decision observability —
  every edit carries a falsifiable prediction. Use when you want to systematically
  improve pi's harness (extensions, skills, prompts, settings) based on real usage data.
---

# AHE Self-Improvement for Pi

基于论文 [Agentic Harness Engineering (arXiv:2604.25850)](https://arxiv.org/abs/2604.25850) 的
三大可观测性支柱，为 pi 构建自我改进闭环。

---

## 架构概览

```
                    ┌──────────────────────────┐
                    │   AHE Outer Loop          │
                    │                           │
                    │  1. Explore (分析轨迹)     │
                    │  2. Debug   (定位根因)    │
                    │  3. Evolve  (编辑 harness)│
                    │  4. Verify  (验证预测)    │
                    └──────────┬───────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ Component    │   │ Experience   │   │ Decision     │
   │ Observatory  │   │ Observatory  │   │ Observatory  │
   │ (pillar 1)   │   │ (pillar 2)   │   │ (pillar 3)   │
   └──────────────┘   └──────────────┘   └──────────────┘
```

---

## 支柱 1：组件可观测性 (component-observatory.ts)

**目标**：让 pi 的每个 harness 组件都有文件级表示，可编辑、可版本控制、可回滚。

### pi 当前的 harness 组件映射

| 组件 | 文件表示 | 是否可被 Agent 编辑？ |
|------|---------|---------------------|
| 系统提示词 | 动态生成（不可直接编辑） | ❌ |
| 内置工具 (bash, read, write, edit) | 源码中硬编码 | ❌ |
| 扩展 (extensions) | `~/.pi/agent/extensions/*.ts` | ✅ 已有 |
| 技能 (skills) | `~/.pi/agent/skills/*/SKILL.md` | ✅ 已有 |
| 提示词模板 (prompts) | `~/.pi/agent/prompts/*.md` | ✅ 已有 |
| 设置 (settings) | `settings.json` | ❌（需手动编辑） |
| 上下文文件 (AGENTS.md) | `AGENTS.md` | ✅ 已有 |
| 压缩策略 (compaction) | 硬编码 | ❌ |
| 会话管理器 | 源码中硬编码 | ❌ |

### 改进方案

1. **系统提示词快照**：每次 `before_agent_start` 时将当前系统提示词写入 `.pi/harness/system-prompt.md`，Agent 可直接看到并建议修改
2. **工具清单**：生成 `.pi/harness/tools.json`，列出所有可用工具及其描述
3. **Harness 版本追踪**：每次修改自动 Git commit，支持 `git diff` / `git log` 查看演进历史
4. **统一 Harness 工作区**：`.pi/harness/` 目录作为 Agent 可直接编辑的 harness 根目录

---

## 支柱 2：经验可观测性 (trajectory-distiller.ts)

**目标**：将数百万 token 的原始会话轨迹蒸馏为分层、可钻取的证据语料库。

### 蒸馏层级

```
原始会话 (JSONL)
  └─► L1: 任务摘要 (每个 user prompt → 成功/失败 + 关键指标)
       └─► L2: 失败模式聚类 (同类失败归类 + 根因假设)
            └─► L3: 改进建议 (针对具体 harness 组件的编辑建议)
```

### 实现

- **`/ahe:analyze`** 命令：分析最近 N 个会话，生成分层报告
- 自动提取：token 消耗、工具调用频率、失败模式、回滚次数
- 输出到 `.pi/harness/evidence/` 目录

---

## 支柱 3：决策可观测性 (decision-logger.ts)

**目标**：每次 harness 编辑都附带自声明的预测断言，下一轮用任务结果验证。

### 编辑契约格式

```yaml
# .pi/harness/decisions/2026-05-27-tool-timeout.yaml
component: bash_tool
edit: 增加默认超时从 120s → 300s
prediction: 长编译任务（如 pip install）不再因超时失败
verification:
  metric: Terminal-Bench-2 编译类任务通过率
  baseline: 65%
  target: 75%
status: pending  # → verified | falsified
```

### 实现

- **`/ahe:decide`** 命令：记录一次编辑决策及其预测
- **`/ahe:verify`** 命令：根据后续会话结果验证之前的预测
- 决策链追踪：哪个预测被证实、哪个被证伪

---

## 使用方法

### 安装

此扩展包放在 `.pi/extensions/ahe/`，pi 自动发现并加载。

### 命令

| 命令 | 说明 |
|------|------|
| `/ahe:snapshot` | 快照当前 harness 状态到 `.pi/harness/` |
| `/ahe:analyze` | 分析最近的会话轨迹，生成证据报告 |
| `/ahe:decide <component> <edit> <prediction>` | 记录一次编辑决策 |
| `/ahe:verify` | 验证之前的决策预测 |
| `/ahe:report` | 生成完整的 harness 健康报告 |
| `/ahe:evolve` | 运行一轮完整的 AHE 闭环 |

### 工具

| 工具 | 说明 |
|------|------|
| `ahe_snapshot_harness` | LLM 可调用：快照当前 harness |
| `ahe_analyze_sessions` | LLM 可调用：分析会话轨迹 |
| `ahe_log_decision` | LLM 可调用：记录编辑决策 |
| `ahe_read_evidence` | LLM 可调用：读取证据语料库 |

---

## 外部循环流程

```
Explore（探索阶段）
  ├─ /ahe:analyze → 读取最近会话，发现失败模式
  ├─ 输出: .pi/harness/evidence/failure-clusters.md
  │
Debug（诊断阶段）
  ├─ Agent 阅读 evidence 报告
  ├─ 定位根因 → 提出编辑假设
  │
Evolve（演化阶段）
  ├─ /ahe:decide <component> <edit> <prediction>
  ├─ Agent 直接编辑 harness 文件 (extensions/skills/prompts)
  │
Verify（验证阶段）
  ├─ 运行 Terminal-Bench-2 或 SWE-bench 类任务
  ├─ /ahe:verify → 对比实际结果与预测
  └─ 更新 .pi/harness/decisions/ 中的验证状态
```
