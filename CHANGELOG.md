# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-03-31

### Added

- **结构化步骤管理** — `status.yaml.steps` 作为唯一权威数据源，支持 `completed` / `pending` / `skipped` 三种步骤状态
- **`checklist_read` 工具** — 从 status.yaml.steps 读取进度，支持旧格式（无 steps）自动迁移到新结构
- **`checklist_write` 工具** — 全量写入 checklist markdown，自动解析为结构化 steps 并同步到 status.yaml，保留已有 `completed_at` 时间戳
- **`[-]` 跳过标记** — 扩展 checkbox 正则支持 `[x]`/`[ ]`/`[-]` 三种标记，`[-]` 步骤记录 `skip_reason`
- **阶段感知提醒** — `before_prompt_build` hook 的进度摘要按阶段分组，显示同阶段所有未完成步骤
- **`interventionLevel` 配置** — 支持 `low` / `medium` / `high` / `always` 四级介入控制，基于任务拆分叶子节点数与阈值对比
- **`before_tool_call` hook** — 自动注入 `project_root` 参数（task_create / config_merge / task_archive / task_recall），拦截对 checklist.md 的直接写入
- **openspec 风格 task_create** — LLM 在调用时传入 brief / plan / checklist 内容，工具内部解析为结构化 steps
- **`enforceOnSubAgents` 配置** — 控制是否为子 agent 注入 spec-task 提醒
- **524 个测试用例** — 覆盖单元、工具、Hook、E2E 全链路
- **生产级 E2E 验证** — 通过 Coordinator 真实执行 000858 五粮液分析任务，165 项自动化结构检查全部通过

### Changed

- **进度计算** — 从 `ProgressCalculator` 类（正则解析 checklist.md）迁移到 `calculateProgressFromSteps()`（从 steps 数组推导），percentage = completed / total（skipped 不计入分子）
- **`before_prompt_build` hook** — 进度摘要从 status.yaml.steps 读取，不再扫描 checklist.md
- **`task_create`** — 创建时自动从 checklist markdown 解析为 steps 数组写入 status.yaml
- **`task_transition`** — 状态变更时从 steps 重算 progress
- **`task_verify`** — finalize 时从 steps 重算 progress
- **checklist 工具重命名** — `checklist_update` / `checklist_status` → `checklist_write` / `checklist_read`，接口从单步操作改为全量读写
- **文档体系更新** — README.md 和 SKILL.md 全面更新，反映 10 个工具、结构化 steps、正确状态机转换

### Removed

- **`progress.ts`** — 删除 `ProgressCalculator` 类，功能由 `checklist-utils.ts` 的 `calculateProgressFromSteps` 替代
- **`tool-result-reminder.ts`** — 删除 `tool_result_persist` hook，功能合并到 `before_prompt_build`
- **15 个死代码字段** — `parent`, `depth`, `estimated_minutes`, Revision 的 6 个字段（`impact`, `changes`, `affected_steps`, `status_before`, `status_after`, `resume_from`）
- **死类型** — `ImpactLevel`, `RevisionChange`, `AffectedSteps`, `ArtifactAction`
- **`checklist_update.ts` / `checklist_status.ts`** — 被 `checklist-write.ts` / `checklist-read.ts` 替代

### Fixed

- **`task-resume.ts`** — 移除对已删除 `resume_from` 字段的引用
- **7 个测试文件 TS 类型过时** — 全部更新以匹配新的类型定义
- **E2E 测试临时目录** — 使用系统临时目录避免污染工作区

---

## [0.1.0] - 2026-03-30

### Added

- **spec-task 插件初始版本** — OpenClaw 结构化任务管理与生命周期强制执行
- **8 个核心工具** — `config_merge`, `task_recall`, `task_create`, `task_transition`, `task_log`, `task_verify`, `task_resume`, `task_archive`
- **状态机** — 8 种状态（pending / assigned / running / completed / failed / blocked / cancelled / revised），14 条合法转换，3 种终态
- **四文档规范** — brief / spec / plan / checklist 按拓扑序填充，Schema 驱动的构件模板（brief.md / spec.md / plan.md / checklist.md）
- **5 级工作区检测器** — none / empty / skeleton / in_progress / all_done
- **`before_prompt_build` hook** — 检测工作区状态，注入 prependContext 提醒
- **`checklist_update` / `checklist_status` 工具** — 单步打勾和进度查询
- **`tool_result_persist` hook** — 工具返回结果后的多层提醒
- **并发安全** — `proper-lockfile` 排他锁 + POSIX rename 原子写入 + 锁内外双重校验
- **自适应失败策略** — verify_failed 和 execution_blocked 两级策略（retry / escalate / adaptive）
- **配置管理** — 深度合并（项目 config.yaml > 插件内置默认），自动首次生成
- **任务归档** — 归档到 memory/task-history + memory/task-lessons，支持 dry_run
- **历史搜索** — TF 评分模糊匹配，文件名权重 ×3
- **安全机制** — 路径遍历防护、workspace 4 级启发式验证
- **300+ 测试用例** — 单元测试、工具测试、E2E 测试（生命周期 / 边界条件 / 安全审计 / v1 兼容 / 性能基准）
- **.npmignore** — 排除测试文件和开发工具产物
