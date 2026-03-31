---
name: spec-task
description: "结构化任务管理与生命周期强制执行。以下场景必须使用：(1) 任何被 coordinator 通过 sessions_spawn 派发的任务 (2) prependContext 要求启动时（基于任务拆分叶子节点数与介入阈值对比）(3) 工作区已存在 spec-task/ 目录且检测到未完成任务时 (4) 用户显式要求使用 spec-task。跳过 spec-task 会导致验收失败。"
metadata: {}
---

# Spec-Task 任务管理

## 核心原则

1. **所有非平凡任务必须通过 spec-task 管理**，不存在"太简单不需要"的例外。
2. 任务生命周期每一步都必须显式转换，不可跳过状态。
3. 四文档必须按拓扑序在 `running` 之前完成：`brief → spec → plan → checklist`。
4. 没有 checklist 的执行 = 不可追溯 = 验收失败。
5. **每完成一个步骤必须立即调用 `checklist_write` 工具写回更新后的 checklist**。先 `checklist_read` 读取当前状态 → 完成步骤 → `checklist_write` 写回完整内容。禁止手动编辑 checklist.md 文件来更新勾选状态。
6. **双层提醒机制**：系统通过 before_prompt_build（system prompt 层注入打勾指引）和 prependContext（用户消息层注入进度摘要）自动提醒 LLM 使用 checklist_write。但这些提醒只是辅助——LLM 仍需主动调用工具。
7. 验收时所有 criteria 通过且任务为 running，自动转为 completed。
8. **`status.yaml.steps` 是步骤状态的唯一权威数据源**，`checklist.md` 是人类可读的派生视图。进度计算全部从 steps 数组推导。

## 介入程度

spec-task 的介入程度由 `interventionLevel` 配置控制（默认：high）：

| 级别 | 阈值 | 含义 |
|------|------|------|
| low | ≥ 20 步 | 仅大型任务触发 |
| medium | ≥ 10 步 | 中型及以上任务触发 |
| high | ≥ 3 步 | 小型及以上任务触发（默认） |
| always | 无条件 | 每次都触发 |

判断方式：将任务拆分为 X.Y.Z 编号，统计叶子节点数与阈值对比。
此评估由 `before_prompt_build` hook 在 prependContext 中引导 LLM 完成。
`enforceOnSubAgents: false` 可完全关闭 hook（优先级最高）。

## 工作流程（9步）

```
1. config_merge    → 检查/合并项目配置
2. task_recall     → 搜索历史经验（keywords 必填，避免重复劳动）
3. task_create     → 创建任务（task_name 必填，生成 status.yaml，解析 checklist → steps）
4. 填充文档        → brief → spec → plan → checklist（按拓扑序）
5. task_transition → assigned → running（开始执行）
6. 执行步骤        → 每完成一步立即调用 checklist_write 写回
7. task_log        → 记录运行时事件（error/alert/add-block/remove-block/output/retry）
8. task_verify     → 验收管理（add-criterion → finalize；finalize 自动触发 completed）
9. task_archive    → 归档（生成 history + lessons，支持 dry_run）
```

## 状态机（8种状态 · 14条转换）

```
pending ──→ assigned ──→ running ──→ completed   (终态)
    │            │            │
    └── cancelled ← ─ ─ ─ ─ ┘
                      running → failed → running
                      running → blocked → pending
                      running → revised → running
                      running → revised → pending
                      running → running   (进度刷新)
```

| 起始状态 | 目标状态 | 说明 |
|---------|---------|------|
| pending | assigned | 任务分配 |
| pending | cancelled | 取消 |
| assigned | running | 开始执行 |
| assigned | cancelled | 取消 |
| running | completed | 完成（终态） |
| running | failed | 失败 |
| running | blocked | 阻塞 |
| running | cancelled | 取消 |
| running | revised | 需修订 |
| running | running | 进度刷新 |
| failed | running | 重试 |
| blocked | pending | 解除阻塞，回到待分配 |
| revised | running | 修订后重新执行 |
| revised | pending | 修订后回到待分配 |

## 四文档拓扑序

```
brief（无依赖）→ spec（依赖 brief）→ plan（依赖 brief）→ checklist（依赖 spec + plan）
```

- **brief.md**: 问题定义、目标、约束条件、成功标准
- **spec.md**: 技术方案、接口设计、数据结构（GIVEN/WHEN/THEN 格式）
- **plan.md**: 实施计划、步骤分解、依赖关系
- **checklist.md**: 可执行检查项，格式：`- [x] 1.1 步骤描述`

### Checklist 标记

| 标记 | 含义 | 示例 |
|------|------|------|
| `[x]` | 已完成 | `- [x] 2.1 数据采集` |
| `[ ]` | 待完成 | `- [ ] 3.1 数据校验` |
| `[-]` | 已跳过 | `- [-] 7.1 历史对比（跳过：无历史数据）` |

步骤编号格式要求：`X.Y.Z`（如 1.1、2.3.1）。支持 tag 标记如 `[spawn:agent-name]`。

## 5级检测器

| 级别 | 名称 | 条件 | 行为 |
|------|------|------|------|
| L1 | none | spec-task/ 不存在 | 自动初始化 |
| L2 | empty | 目录存在但无任务 | 等待任务创建 |
| L3 | skeleton | 有 status.yaml 但缺文档 | 提醒补全文档 |
| L4 | in_progress | 有非终态任务且文档完整 | 正常推进 |
| L5 | all_done | 所有任务终态 | 建议归档 |

## 子 Agent 合规

作为子 agent（被 coordinator 通过 sessions_spawn 派发）时：

1. **必须使用 spec-task**，不存在例外。
2. 第一步调用 `config_merge`，第二步调用 `task_recall`，第三步调用 `task_create`。
3. 创建后必须填充 brief → spec → plan → checklist 全部四文档。
4. 只有 checklist 中第一个步骤勾选后，才能开始实际执行。
5. **每完成一个步骤，必须立即调用 `checklist_write(task_dir, content)` 写回更新后的完整 checklist。先 `checklist_read` 获取当前内容，修改勾选后用 `checklist_write` 覆盖。这是强制要求，不是可选的。**
6. 工作区已有 spec-task/ 目录时，优先用 `task_resume` 检查可恢复任务。

## Hook 系统

- **before_prompt_build**: 检测工作区状态，注入 prependContext 提醒（含从 steps 读取的 checklist 进度摘要）。
- **before_tool_call**: 对 task_create、config_merge、task_archive、task_recall 自动注入 `project_root` 参数，并拦截对 checklist.md 的直接写入（强制走 checklist_write）。

## 工具速查表

| 工具 | 必填参数 | 用途 |
|------|---------|------|
| `config_merge` | — | 合并项目配置（可选 project_root, format） |
| `task_recall` | keywords | 搜索历史经验（可选 project_root, agent_workspace, top） |
| `task_create` | task_name | 创建任务（可选 project_root, title, assigned_to, brief, plan, checklist） |
| `task_transition` | task_dir, status | 状态流转（可选 revision_type, trigger, summary, block_type, block_reason, assigned_to） |
| `task_log` | task_dir, action | 记录事件；action: error / alert / add-block / remove-block / output / retry |
| `task_verify` | task_dir, action | 验收管理；action: add-criterion / get / finalize |
| `task_resume` | task_dir | 断点恢复，返回 next_action 决策 |
| `task_archive` | task_dir | 归档（可选 agent_workspace, project_root, agent_name, dry_run） |
| `checklist_write` | task_dir, content | 全量覆盖 checklist.md 并自动解析为 steps 同步到 status.yaml。**每完成一步必须调用**。 |
| `checklist_read` | task_dir | 从 status.yaml.steps 读取进度和步骤状态（只读）。旧格式自动迁移。 |

## 验收状态

标准（criterion）状态：`pending | passed | failed`

验收流程：`add-criterion`（添加标准）→ `get`（查看结果）→ `finalize`（汇总确认）
finalize 时若全部 passed 且任务 status 为 running，自动转为 completed。

## 错误码

| 错误码 | 场景 |
|--------|------|
| `TASK_NOT_FOUND` | 任务目录不存在 |
| `CHECKLIST_NOT_FOUND` | checklist.md 不存在 |
| `TASK_ALREADY_EXISTS` | 同名任务已存在 |
| `INVALID_TRANSITION` | 非法状态转换 |
| `DUPLICATE_BLOCK` | 重复阻塞记录 |
| `BLOCK_NOT_FOUND` | 阻塞记录不存在 |
| `DUPLICATE_OUTPUT` | 重复产出记录 |
| `NO_CRITERIA` | 无验收标准时执行 finalize |
| `CONFIG_NOT_FOUND` | 配置文件不存在 |

## 配置参考（SpecTaskConfig）

```yaml
tracking:
  level: medium                       # low / medium / high

runtime:
  task_timeout: 60                    # 分钟
  depth_alert: 5                      # 嵌套深度告警阈值
  max_retries: 2
  allow_agent_self_delegation: true

failure_policy:
  verify_failed:
    strategy: adaptive                # retry / escalate / adaptive
    max_retries: 2
    on_exhausted: escalate
  execution_blocked:
    soft_block:
      strategy: retry
      max_retries: 3
      backoff: exponential
    hard_block:
      strategy: adapt
      adapt_modifies: [plan, checklist, spec]
      on_adapt_failed: fail

archive:
  per_agent_archive: true
  record_history: true
  generate_lessons: true
  auto_archive: false

rules:
  brief: [简报必须包含明确的成功标准, 简报必须标注预期执行时间]
  plan: [必须列出所需的工具或 API]
  checklist: [每个步骤必须有可验证的产出物, 单个步骤不超过15分钟]
```
