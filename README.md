# Spec-Task

OpenClaw 结构化任务管理插件，通过状态机和生命周期机制强制执行任务从创建到归档的完整流程。

- **版本**: 0.2.0
- **插件 ID**: `spec-task`
- **类型**: OpenClaw 插件（Tool + Hook + Skill）
- **最低 Gateway**: `>=2026.3.28`

---

## 特性亮点

- **状态机驱动** — 8 种状态、14 条合法转换、3 种终态，任务流转有据可查
- **结构化步骤管理** — `status.yaml.steps` 作为唯一权威数据源，支持 `completed` / `pending` / `skipped` 三种步骤状态
- **Checklist 双向同步** — `checklist_write` 接受 markdown 输入，自动解析为结构化 steps 并更新 `status.yaml`；`checklist_read` 从 steps 读取并支持向后兼容迁移
- **四文档规范** — brief / spec / plan / checklist 分层文档，从问题定义到检查清单全链路覆盖
- **并发安全** — 排他文件锁 + 原子写入 + 锁内外双重校验，多 agent 协作无竞态
- **断点恢复** — 任务可从任意中断点恢复执行，配合 revision 追踪器还原完整变更历史
- **自适应失败策略** — verify_failed 和 execution_blocked 两级策略，支持 retry / escalate / adaptive
- **双层注入提醒** — system prompt 层注入打勾指引 + 用户消息层注入进度摘要，确保 LLM 不遗漏 checklist 更新
- **深度防护** — 路径遍历防护、YAML 注入防护、嵌套深度告警，安全底线清晰

---

## 架构概览

插件由三层组成：

```
Hooks (before_prompt_build, before_tool_call)
  |
  v
Tools (10 个工具)  <-->  Core (状态机 / 状态存储 / Checklist 工具 / 进度计算 / 变更追踪)
  |
  v
Skill (skills/spec-task/SKILL.md)  --  LLM 读取的结构化行为指南
```

**工作区检测器** 根据当前目录中任务文档的填充程度，将工作区识别为 5 个级别：

| 级别 | 含义 | 说明 |
|------|------|------|
| `none` | 无任务目录 | 工作区尚未初始化 |
| `empty` | 空任务目录 | 已创建但无任何文档 |
| `skeleton` | 仅有骨架 | 仅 status.yaml，文档未填充 |
| `in_progress` | 执行中 | 文档已部分或全部填充 |
| `all_done` | 全部完成 | 所有子任务已达终态 |

---

## 工具列表

| 工具 | 功能 | 触发时机 |
|------|------|----------|
| `config_merge` | 将身份文件中的 context 合并到项目 config.yaml | 对话开始时 |
| `task_recall` | 按关键词搜索历史任务，支持模糊匹配 | 需要回顾历史经验时 |
| `task_create` | 创建新任务目录及 status.yaml，解析 checklist 为结构化 steps | 收到新需求时 |
| `task_transition` | 执行状态流转，从 steps 重算进度 | 任务阶段推进时 |
| `task_log` | 向 status.yaml 追加事件日志（error / alert / block / output / retry） | 执行过程中记录关键事件 |
| `task_verify` | 验收管理（add-criterion / get / finalize），全部通过自动完成 | 任务执行完毕时 |
| `task_resume` | 从中断点恢复任务，返回 next_action 决策 | 任务中断后重新启动时 |
| `task_archive` | 将终态任务归档到 memory 目录，提取经验教训 | 任务完结后 |
| `checklist_read` | 从 status.yaml.steps 读取进度，支持旧格式自动迁移 | 查看当前进度时 |
| `checklist_write` | 全量写入 checklist markdown，自动解析为 steps 并同步到 status.yaml | 每完成一个步骤后 |

### Checklist 工具详细说明

**`checklist_read`** — 只读读取：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_dir` | string | 是 | 任务目录路径 |

返回：steps 数组、progress 统计、checklist.md 原始内容。

**`checklist_write`** — 全量覆盖写入：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_dir` | string | 是 | 任务目录路径 |
| `content` | string | 是 | 完整 checklist markdown（全量覆盖） |

支持的 checkbox 标记：

| 标记 | 含义 | 示例 |
|------|------|------|
| `[x]` | 已完成 | `- [x] 2.1 数据采集` |
| `[ ]` | 待完成 | `- [ ] 3.1 数据校验` |
| `[-]` | 已跳过 | `- [-] 7.1 历史对比（跳过：无历史数据）` |

写入流程：解析 markdown → 生成结构化 steps → 保留已有 `completed_at` 时间戳 → 覆写 checklist.md → 同步更新 status.yaml.steps + progress。

### 数据源说明

`status.yaml.steps` 是步骤状态的**唯一权威数据源**。`checklist.md` 是人类可读的派生视图。

- 进度计算（percentage、completed、skipped）全部从 steps 数组推导
- `before_prompt_build` hook 的进度摘要从 steps 读取
- 旧格式任务（无 steps 字段）在 `checklist_read` 时自动迁移

---

## 状态机

### 状态定义

| 状态 | 含义 | 是否终态 |
|------|------|----------|
| `pending` | 已创建，等待分配 | 否 |
| `assigned` | 已分配，等待启动 | 否 |
| `running` | 执行中 | 否 |
| `completed` | 验收通过 | 是 |
| `failed` | 执行失败 | 是 |
| `blocked` | 被外部依赖阻塞 | 否 |
| `cancelled` | 被取消 | 是 |
| `revised` | 需求变更，待重新规划 | 否 |

### 合法转换（14 条）

```
pending     -> assigned, cancelled
assigned    -> running, cancelled
running     -> completed, failed, blocked, cancelled, revised, running(心跳)
failed      -> running
blocked     -> pending
revised     -> running, pending
```

---

## 标准工作流

```
config_merge                        # 合并项目上下文
  -> task_recall                    # 检索历史经验
    -> task_create                  # 创建任务 (pending)，解析 checklist → steps
      -> 填充四文档                  # brief -> spec -> plan -> checklist
        -> task_transition          # pending -> assigned -> running
          -> 执行步骤
            -> checklist_write      # 每完成一步立即写回（全量覆盖）
            -> task_log             # 记录过程事件
            -> task_verify          # 验收检查（全部通过自动 completed）
              -> task_archive       # 归档 + 提取经验
```

---

## 目录结构

```
spec-task/
├── index.ts                        # 插件入口（注册 10 工具 + 2 hook）
├── openclaw.plugin.json            # 插件清单
├── package.json                    # 依赖管理
├── src/
│   ├── types.ts                    # 全局类型定义（Step, TaskProgress, TaskStatusData 等）
│   ├── detector.ts                 # 工作区检测器（5 级）
│   ├── file-utils.ts               # 文件操作工具类
│   ├── tool-utils.ts               # 工具响应格式化
│   ├── openclaw-sdk.d.ts           # SDK 类型声明
│   ├── core/
│   │   ├── config.ts               # 配置管理器（深度合并 + 自动生成）
│   │   ├── status-store.ts         # 状态持久化（排他锁 + 原子写入）
│   │   ├── state-machine.ts        # 状态机转换校验（14 条规则）
│   │   ├── checklist-utils.ts      # Checklist 解析 / 同步 / 进度计算
│   │   └── revision.ts             # 变更追踪器（精简 7 字段）
│   ├── tools/
│   │   ├── config-merge.ts         # 配置合并
│   │   ├── task-recall.ts          # 历史搜索（TF 评分）
│   │   ├── task-create.ts          # 创建任务
│   │   ├── task-transition.ts      # 状态流转（双重验证）
│   │   ├── task-log.ts             # 事件日志（6 种 action）
│   │   ├── task-verify.ts          # 验收管理（自动完成）
│   │   ├── task-resume.ts          # 断点恢复（next_action 决策）
│   │   ├── task-archive.ts         # 归档（history + lessons）
│   │   ├── checklist-read.ts       # 进度读取（向后兼容迁移）
│   │   └── checklist-write.ts      # 进度写入（markdown → steps 同步）
│   └── hooks/
│       └── before-prompt-build.ts  # 双层注入 hook
└── skills/spec-task/
    ├── SKILL.md                    # 技能指南（LLM 读取）
    ├── config.yaml                 # 内置默认配置
    └── schemas/agent-task/         # Schema + 模板
```

### 运行时任务结构

每个创建的任务在项目目录下生成如下结构：

```
{task-name}/
├── status.yaml                     # 运行时状态（steps + progress + revisions）
├── brief.md                        # 任务简报（问题定义）
├── spec.md                         # 验收规格（GIVEN/WHEN/THEN）
├── plan.md                         # 执行计划（步骤拆解）
├── checklist.md                    # 检查清单（人类可读派生视图）
└── outputs/                        # 产出物目录
```

---

## 四文档规范

| 文档 | 职责 | 核心内容 |
|------|------|----------|
| `brief.md` | 问题定义 | 背景、目标、约束、利益相关者 |
| `spec.md` | 验收场景 | 功能性验收条件、非功能性要求、边界条件 |
| `plan.md` | 执行计划 | 步骤拆解、依赖关系、资源预估、风险评估 |
| `checklist.md` | 检查清单 | 逐项验证条目，支持 `[x]`/`[ ]`/`[-]` 三种标记 |

四文档按拓扑序填充：`brief → spec → plan → checklist`。`rules` 配置中可自定义每份文档必须包含的章节。

---

## 配置说明

### 插件级配置（openclaw.plugin.json）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enforceOnSubAgents` | boolean | `true` | 是否为子 agent 注入 spec-task 提醒 |
| `interventionLevel` | string | `"high"` | 介入程度：`low` / `medium` / `high` / `always` |

### 项目级配置（spec-task/config.yaml）

项目级配置文件位于 `spec-task/config.yaml`，首次运行时由 `config_merge` 自动生成。与插件内置配置深度合并（项目配置优先）：

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
    on_exhausted: escalate            # escalate / fail
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

---

## 快速开始

### 1. 安装

在 OpenClaw 的 `openclaw.json` 中注册插件：

```json
{
  "plugins": {
    "spec-task": {
      "path": "./extensions/spec-task"
    }
  }
}
```

### 2. 安装依赖

```bash
cd extensions/spec-task
npm install
```

### 3. 启动任务

向 LLM 发送需求后，插件会自动通过 `before_prompt_build` 钩子注入技能指南，引导 LLM 按工作流执行：

1. `config_merge` — 合并上下文
2. `task_recall` — 搜索相关历史任务
3. `task_create` — 创建任务目录，解析 checklist → steps
4. 填充 brief / spec / plan / checklist
5. `task_transition` — 推进状态至 running
6. 执行计划，每完成一步调用 `checklist_write` 写回
7. `task_log` — 记录关键事件
8. `task_verify` — 验收检查（全部通过自动 completed）
9. `task_archive` — 归档

---

## 开发指南

### 技术栈

| 类别 | 技术 | 用途 |
|------|------|------|
| 语言 | TypeScript 5.9 | 插件开发 |
| 运行时 | Node.js (ESM) | 模块系统 |
| 序列化 | yaml ^2.0 | YAML 读写 |
| 文件锁 | proper-lockfile ^4.0 | 并发安全 |
| 测试 | Vitest ^3.0 | 单元 + 集成 + E2E |

### 运行测试

```bash
# 全部测试
npx vitest run

# 仅核心模块测试
npx vitest run --testPathPattern "test/core"

# 仅 E2E 测试
npx vitest run --testPathPattern "test/e2e"

# 类型检查
npx tsc --noEmit
```

### 测试覆盖

共 524 测试用例，覆盖以下场景：

- **单元测试** — status-store、state-machine、config、checklist-utils、revision、file-utils
- **工具测试** — 10 个工具的完整输入输出校验
- **Hook 测试** — before-prompt-build 各检测级别行为
- **E2E 测试** — 完整生命周期、边界条件、安全审计、v1 兼容性、checklist 全覆盖、性能基准

性能基准：1000+ 版本读写 < 2 秒，100 任务扫描 < 5 秒。

### 添加新工具

1. 在 `src/tools/` 下创建工具文件，实现 `ToolExecuteFn` 签名
2. 在 `index.ts` 的 `registerTools` 中添加注册调用
3. 在 `skills/spec-task/SKILL.md` 中补充工具使用说明
4. 编写对应测试用例

### 安全机制

- **路径遍历防护** — 拒绝包含 `/`、`\0`、`\\` 的任务名
- **排他文件锁** — `proper-lockfile` 排他锁，stale=10s，retries=3
- **原子写入** — 先写临时文件再 POSIX rename，避免写入中断导致数据损坏
- **双重校验** — 锁外预检 + 锁内重检，消除 TOCTOU 竞态
- **checklist 拦截** — `before_tool_call` hook 拦截对 checklist.md 的直接 write/edit，强制走 `checklist_write`
- **workspace 验证** — 4 级启发式验证确保 `project_root` 是 agent workspace 而非项目根目录
