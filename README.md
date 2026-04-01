# Spec-Task System

OpenClaw 结构化任务管理插件，通过状态机和生命周期机制强制执行任务从创建到归档的完整流程。

- **版本**: 0.2.0
- **插件 ID**: `spec-task-system`
- **类型**: OpenClaw 插件（Tool + Hook + Skill）
- **最低 Gateway**: `>=2026.3.28`

---

## 特性亮点

- **状态机驱动** -- 8 种状态、合法转换、3 种终态，任务流转有据可查
- **两文档 + steps** -- brief / spec / plan 分层文档 + status.yaml 结构化步骤，从问题定义到执行追踪全链路覆盖
- **并发安全** -- 排他文件锁 + 原子写入 + 锁内外双重校验，多 agent 协作无竞态
- **断点恢复** -- 任务可从任意中断点恢复执行，配合 revision 追踪器还原完整变更历史
- **自适应失败策略** -- verify_failed 和 execution_blocked 两级策略，支持 retry / escalate / adaptive
- **深度防护** -- 路径遍历防护、YAML 注入防护、嵌套深度告警，安全底线清晰

---

## 架构概览

插件由三层组成：

```
Hooks (before_prompt_build, before_tool_call)
  |
  v
Tools (11 个工具)  <-->  Core (状态机 / 状态存储 / 进度计算 / 变更追踪)
  |
  v
Skill (schema-driven 工作流)  --  LLM 读取的结构化行为指南
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
| `task_recall` | 按关键词搜索历史任务，支持模糊匹配和时间过滤 | 需要回顾历史经验时 |
| `task_create` | 创建新任务目录及 status.yaml，初始状态 pending | 收到新需求时 |
| `task_transition` | 执行状态流转，由状态机校验合法性 | 任务阶段推进时 |
| `task_log` | 向 status.yaml 追加事件日志 | 执行过程中记录关键事件 |
| `task_verify` | 根据验收标准逐项检查，输出通过/失败报告 | 任务执行完毕时 |
| `task_resume` | 从中断点恢复任务，读取 revision 历史还原上下文 | 任务中断后重新启动时 |
| `task_archive` | 将终态任务移入归档目录，提取经验教训 | 任务完结后 |
| `task_instructions` | 查询构件创建指导（instruction + template + context + rules） | 需要了解如何创建下一构件时 |
| `steps_read` | 读取任务步骤数据和进度统计（只读） | 需要查看当前执行进度时 |
| `steps_update` | 全量更新任务步骤数据，自动重算进度 | 每完成一个步骤时 |

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

### 合法转换

```
pending     -> assigned, cancelled
assigned    -> running, cancelled
running     -> completed, failed, blocked, cancelled, revised, running
blocked     -> pending
revised     -> running, pending
completed   -> (终态)
failed      -> running
cancelled   -> (终态)
```

---

## 标准工作流

```
config_merge                        # 合并项目上下文
  -> task_recall                    # 检索历史经验
    -> task_create                  # 创建任务 (pending)
      -> 填充两文档 + steps          # brief -> spec -> plan，steps 通过 steps_update 管理
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
│   │   ├── config.ts               # 配置管理器
│   │   ├── status-store.ts         # 状态持久化（原子写入 + 文件锁）
│   │   ├── state-machine.ts        # 状态机转换校验
│   │   ├── schema-reader.ts        # Schema 驱动的状态推断
│   │   ├── spec-extractor.ts       # 构件提取器
│   │   ├── run-utils.ts            # 运行目录工具（run ID 生成、活跃 run 检测）
│   │   ├── steps-utils.ts          # Steps 操作（进度计算、同步、加载）
│   │   └── revision.ts             # 变更追踪器
│   ├── tools/
│   │   ├── config-merge.ts         # 配置合并
│   │   ├── task-recall.ts          # 历史搜索（TF 评分）
│   │   ├── task-create.ts          # 创建任务
│   │   ├── task-transition.ts      # 状态流转
│   │   ├── task-log.ts             # 事件日志
│   │   ├── task-verify.ts          # 验收管理
│   │   ├── task-resume.ts          # 断点恢复
│   │   ├── task-archive.ts         # 归档
│   │   ├── task-instructions.ts    # 构件创建指导
│   │   ├── steps-read.ts           # 步骤读取
│   │   └── steps-update.ts         # 步骤更新
│   └── hooks/
│       └── before-prompt-build.ts  # 上下文注入钩子
├── skills/spec-task/
│   ├── config.yaml                 # 内置默认配置
│   ├── reference/                  # 参考文档
│   └── schemas/agent-task/         # Schema + 模板
├── test/                           # 测试（580+ 用例）
└── memory/                         # 归档历史和经验教训
```

### 运行时任务结构

每个创建的任务在项目目录下生成如下结构：

```
{task-name}/
├── status.yaml                     # 运行时状态 + 事件日志 + 版本链 + steps
├── brief.md                        # 任务简报（问题定义）
├── spec.md                         # 验收规格（GIVEN/WHEN/THEN）
├── plan.md                         # 执行计划（步骤拆解）
├── runs/                           # 运行目录（支持多轮执行）
│   └── 001/
│       └── status.yaml             # 当前 run 的状态快照
├── outputs/                        # 产出物目录
└── subtasks/                       # 子任务目录（递归结构）
```

---

## 文档规范

| 文档 | 职责 | 核心内容 |
|------|------|----------|
| `brief.md` | 问题定义 | 背景、目标、约束、利益相关者 |
| `spec.md` | 验收场景 | 功能性验收条件、非功能性要求、边界条件 |
| `plan.md` | 执行计划 | 步骤拆解、依赖关系、资源预估、风险评估 |

文档按依赖顺序填充（brief → spec/plan），前序文档通过后才推进到下一阶段。执行步骤通过 `steps_update` 工具管理，存储在 `status.yaml` 的 `steps` 字段中。

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
context: ""                           # 从身份文件提取的背景信息
tracking:
  level: medium                       # 追踪级别：low / medium / high
runtime:
  task_timeout: 60                     # 任务超时（分钟）
  allow_agent_self_delegation: true    # 允许 agent 自行创建子任务
failure_policy:
  verify_failed:
    strategy: adaptive                # retry / escalate / adaptive
    max_retries: 2
    on_exhausted: escalate
  soft_block:
    strategy: retry
    max_retries: 3
  hard_block:
    strategy: adapt
    adapt_modifies: [plan, steps, spec]
    on_adapt_failed: fail
archive:
  record_history: true
  generate_lessons: true
  auto_archive: false
```

---

## 快速开始

### 1. 安装

在 OpenClaw 的 `openclaw.json` 中注册插件：

```json
{
  "plugins": {
    "spec-task-system": {
      "path": "./extensions/spec-task-system"
    }
  }
}
```

### 2. 安装依赖

```bash
cd extensions/spec-task-system
npm install
```

### 3. 启动任务

向 LLM 发送需求后，插件会自动通过 `before_prompt_build` 钩子注入技能指南，引导 LLM 按工作流执行：

1. `config_merge` -- 合并上下文
2. `task_recall` -- 搜索相关历史任务
3. `task_create` -- 创建任务目录
4. 填充 brief / spec / plan，通过 steps_update 管理执行步骤
5. `task_transition` -- 推进状态至 running
6. 执行计划并 `task_log` 记录
7. `task_verify` -- 验收检查
8. `task_archive` -- 归档

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

共 580+ 测试用例，覆盖以下场景：

- **单元测试** -- status-store、state-machine、config、revision、file-utils、steps-utils
- **工具测试** -- 11 个工具的完整输入输出校验
- **E2E 测试** -- 完整生命周期、边界条件、安全审计、性能基准

性能基准：1000+ 版本读写 < 2 秒，100 任务扫描 < 5 秒。

### 添加新工具

1. 在 `src/tools/` 下创建工具文件，实现 `ToolExecuteFn` 签名
2. 在 `src/types.ts` 中注册工具名和参数类型
3. 在 `index.ts` 的 `registerTools` 中添加注册调用
4. 编写对应测试用例

### 安全机制

- **路径遍历防护** — 拒绝包含 `/`、`\0`、`\\` 的任务名
- **排他文件锁** — `proper-lockfile` 排他锁，stale=10s，retries=3
- **原子写入** — 先写临时文件再 POSIX rename，避免写入中断导致数据损坏
- **双重校验** — 锁外预检 + 锁内重检，消除 TOCTOU 竞态
- **checklist 拦截** — `before_tool_call` hook 拦截对 checklist.md 的直接 write/edit，强制走 `checklist_write`
- **workspace 验证** — 4 级启发式验证确保 `project_root` 是 agent workspace 而非项目根目录
