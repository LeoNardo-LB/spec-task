import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Detector } from "./src/detector.js";
import { createPromptBuildHandler } from "./src/hooks/before-prompt-build.js";

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
  ChecklistUpdateParamsSchema,
  executeChecklistUpdate,
} from "./src/tools/checklist-update.js";
import {
  ChecklistStatusParamsSchema,
  executeChecklistStatus,
} from "./src/tools/checklist-status.js";
import { createToolResultReminderHandler } from "./src/hooks/tool-result-reminder.js";

export default definePluginEntry({
  id: "spec-task",
  name: "Spec-Task",
  description: "Structured task management with lifecycle enforcement",

  register(api) {
    // ── Hook 注册 ───────────────────────────────────────────
    const detector = new Detector();
    const pluginConfig = (api.pluginConfig ?? api.config ?? {}) as {
      enforceOnSubAgents?: boolean;
      interventionLevel?: "low" | "medium" | "high" | "always";
    };

    // 闭包 Map：存储 agentId/sessionKey → workspaceDir 映射
    // PluginHookToolContext（before_tool_call）没有 workspaceDir 字段，
    // 但 PluginHookAgentContext（before_prompt_build）有。
    // 因此在 before_prompt_build 中记录映射，在 before_tool_call 中查找。
    const workspaceDirMap = new Map<string, string>();
    const normalizeKey = (k: string | undefined) => k?.trim().toLowerCase() || undefined;

    // before_prompt_build: 检测 spec-task 状态，注入系统提示，同时记录 workspaceDir
    api.on(
      "before_prompt_build",
      createPromptBuildHandler(api.logger, detector, pluginConfig, workspaceDirMap)
    );

    // before_tool_call: 自动注入 project_root 为 agent 的 workspace 目录
    // PluginHookToolContext 没有 workspaceDir，需要从 workspaceDirMap 中查找。
    // 查找优先级：sessionKey > agentId。
    const SPEC_TASK_TOOLS = new Set(["task_create", "config_merge", "task_archive", "task_recall"]);
    api.on("before_tool_call", async (event, ctx) => {
      if (!SPEC_TASK_TOOLS.has(event.toolName)) return;
      const params = event.params ?? {};
      if (params.project_root) {
        api.logger.info(`[spec-task] before_tool_call: ${event.toolName} already has project_root=${params.project_root}, skip`);
        return;
      }
      // DEBUG: 记录查找过程
      api.logger.info(`[spec-task] before_tool_call: tool=${event.toolName} agentId=${ctx.agentId} sessionKey=${ctx.sessionKey} mapSize=${workspaceDirMap.size}`);
      if (workspaceDirMap.size > 0) {
        api.logger.info(`[spec-task] Map keys: ${[...workspaceDirMap.keys()].join(", ")}`);
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

    // tool_result_persist: 在每次工具调用结果中注入 checklist 提醒
    // 利用 LLM 近因效应——提醒出现在最近的上下文中，比 system prompt 更有效
    api.on(
      "tool_result_persist",
      createToolResultReminderHandler(
        workspaceDirMap,
        normalizeKey,
        api.logger
      )
    );

    // ── 工具注册（9 个）──────────────────────────────────────
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
        "创建新任务并初始化 status.yaml。创建后必须按 brief → spec → plan → checklist 拓扑序填充内容，不允许创建后不填充就进入 running 状态。",
      parameters: TaskCreateParamsSchema,
      async execute(_id, params) {
        return executeTaskCreate(_id, params as any);
      },
    });

    api.registerTool({
      name: "task_transition",
      description:
        "转换任务状态。task_dir 为必填参数（任务目录路径）。支持 8 种状态的 14 条合法转换。自动记录 revision、更新进度和时间戳。",
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
        "管理任务验收。task_dir 为必填参数（任务目录路径）。支持 3 种操作：add-criterion（添加验收标准）、finalize（汇总并最终确认）、get（查看当前验证状态）。",
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
      name: "checklist_update",
      description:
        `原子更新 checklist.md 中单个步骤的勾选状态。每完成一个步骤后**必须**调用此工具。

**触发条件**：当你完成 checklist 中的任何步骤时，必须调用此工具来打勾。不要手动编辑 checklist.md 文件。

**参数说明**：
- task_dir（必填）：任务目录的绝对路径（task_create 返回的 task_dir）
- step_number（必填）：步骤编号，如 '1.1'、'2.3'。必须与 checklist.md 中的编号完全匹配
- checked（必填）：true 表示勾选（标记为完成），false 表示取消勾选

**正例**：
✅ 完成数据获取后调用 checklist_update(task_dir, '1.1', true)
✅ 发现步骤标记错误时调用 checklist_update(task_dir, '1.2', false) 取消

**反例**：
❌ 直接编辑 checklist.md 文件来打勾——这是禁止的，必须使用此工具
❌ 将未完成的步骤标记为已完成——不要虚假打勾

**状态约束**：一次只能打勾一个步骤。自动重新计算进度并更新 status.yaml。`,
      parameters: ChecklistUpdateParamsSchema,
      async execute(_id, params) {
        return executeChecklistUpdate(_id, params as any);
      },
    });

    api.registerTool({
      name: "checklist_status",
      description:
        "查询指定任务的 checklist 完成进度（只读，不修改任何文件）。返回总步骤数、已完成数、完成百分比、未完成步骤列表和建议的下一步骤。",
      parameters: ChecklistStatusParamsSchema,
      async execute(_id, params) {
        return executeChecklistStatus(_id, params as any);
      },
    });
  },
});
