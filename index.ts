import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "fs";
import { Detector } from "./src/detector.js";
import { createPromptBuildHandler } from "./src/hooks/before-prompt-build.js";
import { validateStepsForCompletion, checkTransitionBlocked, checkVerificationBlocked, checkVerifyFinalizeBlocked } from "./src/core/steps-utils.js";
import { join } from "path";
import YAML from "yaml";

// 工具导入
import {
  TaskCreateParamsSchema,
  executeTaskCreate,
} from "./src/tools/task-create.js";
import {
  TaskTransitionParamsSchema,
  executeTaskTransition,
} from "./src/tools/task-transition.js";
import {
  TaskLogParamsSchema,
  executeTaskLog,
} from "./src/tools/task-log.js";
import {
  TaskVerifyParamsSchema,
  executeTaskVerify,
} from "./src/tools/task-verify.js";
import {
  TaskResumeParamsSchema,
  executeTaskResume,
} from "./src/tools/task-resume.js";
import {
  TaskArchiveParamsSchema,
  executeTaskArchive,
} from "./src/tools/task-archive.js";
import {
  TaskRecallParamsSchema,
  executeTaskRecall,
} from "./src/tools/task-recall.js";
import {
  ConfigMergeParamsSchema,
  executeConfigMerge,
} from "./src/tools/config-merge.js";
import {
  StepsUpdateParamsSchema,
  executeStepsUpdate,
} from "./src/tools/steps-update.js";
import {
  StepsReadParamsSchema,
  executeStepsRead,
} from "./src/tools/steps-read.js";
import {
  TaskInstructionsParamsSchema,
  executeTaskInstructions,
} from "./src/tools/task-instructions.js";

export default definePluginEntry({
  id: "spec-task",
  name: "Spec-Task",
  description: "Structured task management with lifecycle enforcement",

  register(api) {
    // ── Hook 注册 ───────────────────────────────────────────
    const detector = new Detector();
    const pluginConfig = (api.pluginConfig ?? api.config ?? {}) as {
      enforceOnSubAgents?: boolean;
    };

    // 闭包 Map：存储 agentId/sessionKey → workspaceDir 映射
    // PluginHookToolContext（before_tool_call）没有 workspaceDir 字段，
    // 但 PluginHookAgentContext（before_prompt_build）有。
    // 因此在 before_prompt_build 中记录映射，在 before_tool_call 中查找。
    const workspaceDirMap = new Map<string, string>();

    // before_prompt_build: 检测 spec-task 状态，注入系统提示，同时记录 workspaceDir
    api.on(
      "before_prompt_build",
      createPromptBuildHandler(api.logger, detector, pluginConfig, workspaceDirMap)
    );

    // before_tool_call: Steps 完成性拦截 + Verification 拦截 + 自动注入 project_root
    // PluginHookToolContext 没有 workspaceDir，需要从 workspaceDirMap 中查找。
    // 查找优先级：sessionKey > agentId。
    const SPEC_TASK_TOOLS = new Set(["task_create", "config_merge", "task_archive", "task_recall", "task_instructions"]);
    api.on("before_tool_call", async (event, ctx) => {
      // ── Steps 完成性拦截：task_transition(completed) ──
      if (event.toolName === "task_transition" && event.params?.status === "completed") {
        const taskDir = event.params?.task_dir;
        if (taskDir) {
          const blocked = checkTransitionBlocked(taskDir);
          if (blocked) {
            api.logger.warn(`[spec-task] before_tool_call: blocked task_transition(completed) — ${blocked.blockReason}`);
            return { block: true, blockReason: blocked.blockReason };
          }
          // ── Verification 前置条件拦截 ──
          const verifyBlocked = checkVerificationBlocked(taskDir);
          if (verifyBlocked) {
            api.logger.warn(`[spec-task] before_tool_call: blocked task_transition(completed) — verification not passed — ${verifyBlocked.blockReason}`);
            return { block: true, blockReason: verifyBlocked.blockReason };
          }
        }
      }

      // ── Verification finalize 空标准拦截 ──
      if (event.toolName === "task_verify" && event.params?.action?.action === "finalize") {
        const taskDir = event.params?.task_dir;
        if (taskDir) {
          const verifyFinalizeBlocked = checkVerifyFinalizeBlocked(taskDir);
          if (verifyFinalizeBlocked) {
            api.logger.warn(`[spec-task] before_tool_call: blocked task_verify(finalize) — ${verifyFinalizeBlocked.blockReason}`);
            return { block: true, blockReason: verifyFinalizeBlocked.blockReason };
          }
        }
      }

      // ── project_root 注入逻辑 ──
      if (!SPEC_TASK_TOOLS.has(event.toolName)) return;
      const params = event.params ?? {};
      if (params.project_root) {
        api.logger.info(`[spec-task] before_tool_call: ${event.toolName} already has project_root=${params.project_root}, skip`);
        return;
      }
      // 从 Map 中查找 workspaceDir
      const workspaceDir =
        (ctx.sessionKey && workspaceDirMap.get(ctx.sessionKey)) ||
        (ctx.agentId && workspaceDirMap.get(ctx.agentId));
      if (!workspaceDir) {
        api.logger.warn(`[spec-task] before_tool_call: NO workspaceDir found for agentId=${ctx.agentId} sessionKey=${ctx.sessionKey}`);
        return;
      }
      api.logger.info(`[spec-task] before_tool_call: injecting project_root=${workspaceDir}`);
      return { params: { ...params, project_root: workspaceDir } };
    });

    // ── 工具注册（11 个）─────────────────────────────────────
    api.registerTool({
      name: "config_merge",
      description:
        "合并 spec-task 配置。首次使用时自动生成项目级配置（从 AGENTS.md 等身份文件提取 context）。后续调用返回合并后的完整配置。",
      parameters: ConfigMergeParamsSchema,
      async execute(_id, params) {
        return executeConfigMerge(_id, params as any);
      },
    });

    api.registerTool({
      name: "task_recall",
      description:
        "在历史任务和经验教训中搜索相关内容。创建新任务前必须先调用此工具，避免重复工作和已知陷阱。",
      parameters: TaskRecallParamsSchema,
      async execute(_id, params) {
        return executeTaskRecall(_id, params as any);
      },
    });

    api.registerTool({
      name: "task_create",
      description:
        "创建 spec-task 任务。创建目录结构、初始化 status.yaml、写入构件文件。" +
        "\n\n**参数说明：**" +
        "\n- task_name (必需): kebab-case 任务名称" +
        "\n- brief (推荐): 任务简报，定义目标和成功标准" +
        "\n- plan (推荐): 执行计划，说明步骤分解和策略" +
        "\n- checklist (推荐): 进度追踪清单，后续用 steps_update 更新进度" +
        "\n\n**brief 格式参考：**" +
        "\n## 目标" +
        "\n一句话概括核心目标。" +
        "\n## 成功标准" +
        "\n- 标准1: 可衡量的完成条件" +
        "\n- 标准2: ..." +
        "\n## 背景与上下文" +
        "\n为什么需要做这件事。" +
        "\n\n**plan 格式参考：**" +
        "\n## 概述" +
        "\n整体执行策略。" +
        "\n## 步骤分解" +
        "\n### 步骤 1: 名称" +
        "\n- 做什么 → 为什么 → 预期产出" +
        "\n### 步骤 2: 名称" +
        "\n- ..." +
        "\n\n**checklist 格式参考：**" +
        "\n## 1. 阶段名称" +
        "\n- [ ] 1.1 步骤描述" +
        "\n- [ ] 1.2 步骤描述" +
        "\n## 2. 阶段名称" +
        "\n- [ ] 2.1 步骤描述" +
        "\n\n建议：在调用时同时传入 brief + checklist（或 brief + plan + checklist），" +
        "\n确保任务有清晰的目标定义和进度追踪。",
      parameters: TaskCreateParamsSchema,
      async execute(_id, params) {
        return executeTaskCreate(_id, params as any);
      },
    });

    api.registerTool({
      name: "task_transition",
      description:
        "转换任务状态。task_dir 为必填参数（任务目录路径）。支持 8 种状态的 14 条合法转换。自动记录 revision、更新进度和时间戳。\n\n⚠️ 当目标状态为 completed 时，必须先调用 task_verify(finalize) 通过验收。直接调用 task_transition(completed) 在未验收时会被拒绝并返回下一步操作指引。",
      parameters: TaskTransitionParamsSchema,
      async execute(_id, params) {
        return executeTaskTransition(_id, params as any);
      },
    });

    api.registerTool({
      name: "task_log",
      description:
        "记录任务运行时事件。task_dir 为必填参数（任务目录路径）。action 是一个对象，其中 action.action 是操作类型（必填）。各操作所需字段：error(step必填,message必填)、alert(type必填,message必填)、add-block(task必填,reason)、remove-block(task必填)、output(path可选,默认自动生成)、retry(step必填)。",
      parameters: TaskLogParamsSchema,
      async execute(_id, params) {
        return executeTaskLog(_id, params as any);
      },
    });

    api.registerTool({
      name: "task_verify",
      description:
        "管理任务验收。task_dir 为必填参数（任务目录路径）。\n\n" +
        "**推荐流程**：\n" +
        "1. `task_verify(action: { action: \"get\" })` — 查看当前验收状态\n" +
        "2. `task_verify(action: { action: \"add-criterion\", criterion: \"...\", result: \"passed\"|\"failed\" })` — 逐条添加验收标准\n" +
        "3. `task_verify(action: { action: \"finalize\", verified_by: \"...\" })` — 汇总确认，全部通过时自动完成任务\n\n" +
        "**关键行为**：\n" +
        "- finalize 时至少需要一条验收标准，否则会被拒绝\n" +
        "- 所有标准 passed → verification.status = \"passed\"，如果 steps 也全部完成则自动 task_transition(completed)\n" +
        "- 存在 failed 标准 → verification.status = \"failed\"，需要修正后重新 finalize\n" +
        "- add-criterion/get 后会返回 `suggested_criteria`（基于 steps 的未覆盖建议），帮助你补全验收标准\n\n" +
        "**参数说明**：\n" +
        "- criterion: 验收标准描述（建议引用步骤标题，如\"验证步骤 1.1: 实现用户登录\"）\n" +
        "- result: \"passed\" 或 \"failed\"\n" +
        "- evidence: 可选，验收证据（如测试输出、截图路径）\n" +
        "- reason: 可选，失败原因或通过说明\n" +
        "- verified_by: finalize 时可选，验证人标识",
      parameters: TaskVerifyParamsSchema,
      async execute(_id, params) {
        return executeTaskVerify(_id, params as any);
      },
    });

    api.registerTool({
      name: "task_resume",
      description:
        "读取任务当前状态，输出断点恢复信息（next_action）。task_dir 为必填参数（任务目录路径）。用于新 session 中继续未完成的任务。",
      parameters: TaskResumeParamsSchema,
      async execute(_id, params) {
        return executeTaskResume(_id, params as any);
      },
    });

    api.registerTool({
      name: "task_archive",
      description:
        "归档已完成任务。task_dir 为必填参数（任务目录路径）。生成 task-history 和 task-lessons 文件，写入 agent workspace 的 memory 目录。",
      parameters: TaskArchiveParamsSchema,
      async execute(_id, params) {
        return executeTaskArchive(_id, params as any);
      },
    });

    api.registerTool({
      name: "task_instructions",
      description:
        "查询 spec-task 构件的创建指导。返回指定构件的 instruction（创建说明）、template（模板）、context（项目上下文）、rules（规则约束）、dependencies（依赖构件内容）。用于获取下一个需要创建的构件的详细指导信息。",
      parameters: TaskInstructionsParamsSchema,
      async execute(_id, params) {
        return executeTaskInstructions(_id, params as any);
      },
    });

    api.registerTool({
      name: "steps_read",
      description:
        "读取指定任务的步骤数据和进度统计（只读，不修改任何文件）。从 status.yaml.steps 读取结构化步骤列表，返回每个步骤的 id、summary、status、completed_at 等信息，以及总体进度百分比。",
      parameters: StepsReadParamsSchema,
      async execute(_id, params) {
        return executeStepsRead(_id, params as any);
      },
    });

    api.registerTool({
      name: "steps_update",
      description:
        `全量更新指定任务的步骤数据。传入结构化 Step[] 数组，替换 status.yaml 中的 steps 字段。

**推荐工作流**：先 steps_read 读取当前步骤 → 完成步骤 → steps_update 写回更新后的完整步骤数组。

**参数说明**：
- task_dir（必填）：任务 run 目录的绝对路径（task_create 返回的 task_dir）
- steps（必填）：完整的步骤数组，全量替换。每个步骤包含 id、summary（title/content/approach/sources）、status（pending/completed/skipped）、tags 等字段。

**典型用法**：
✅ steps_read(task_dir) → 修改步骤的 status 为 "completed" → steps_update(task_dir, steps)
✅ 重新规划任务：直接传入新的完整步骤列表
✅ 批量更新：传入已更新的步骤数组，自动计算进度`,
      parameters: StepsUpdateParamsSchema,
      async execute(_id, params) {
        return executeStepsUpdate(_id, params as any);
      },
    });
  },
});
