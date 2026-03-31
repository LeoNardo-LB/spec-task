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
  ChecklistReadParamsSchema,
  executeChecklistRead,
} from "./src/tools/checklist-read.js";
import {
  ChecklistWriteParamsSchema,
  executeChecklistWrite,
} from "./src/tools/checklist-write.js";

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
      // ── 拦截对 checklist.md 的直接写入，强制使用 checklist_write ──
      if (event.toolName === "write" || event.toolName === "edit") {
        const filePath = (event.params?.path ?? event.params?.file_path ?? "") as string;
        if (filePath.endsWith("checklist.md") || filePath.includes("/checklist.md")) {
          api.logger.info(`[spec-task] before_tool_call: BLOCKED ${event.toolName} to checklist.md — use checklist_write instead`);
          return {
            block: true,
            params: event.params,
          };
        }
      }

      // ── 仅保留 project_root 注入逻辑 ──
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
        "创建 spec-task 任务。创建目录结构、初始化 status.yaml、写入构件文件。" +
        "\n\n**参数说明：**" +
        "\n- task_name (必需): kebab-case 任务名称" +
        "\n- brief (推荐): 任务简报，定义目标和成功标准" +
        "\n- plan (推荐): 执行计划，说明步骤分解和策略" +
        "\n- checklist (推荐): 进度追踪清单，后续用 checklist_write 更新进度" +
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
      name: "checklist_read",
      description:
        "全量读取指定任务的 checklist.md 内容和进度统计（只读，不修改任何文件）。返回完整 markdown 内容、进度百分比和未完成步骤。",
      parameters: ChecklistReadParamsSchema,
      async execute(_id, params) {
        return executeChecklistRead(_id, params as any);
      },
    });

    api.registerTool({
      name: "checklist_write",
      description:
        `全量覆盖指定任务的 checklist.md 文件。传入完整 markdown 内容，覆盖写入 checklist.md 并自动更新 status.yaml 进度。

**推荐工作流**：先 checklist_read 读取当前状态 → 完成步骤 → checklist_write 写回更新后的完整内容。

**参数说明**：
- task_dir（必填）：任务目录的绝对路径（task_create 返回的 task_dir）
- content（必填）：完整的 checklist markdown 内容。全量覆盖，传入什么就存什么。

**典型用法**：
✅ checklist_read(task_dir) → 修改 content 中的 [ ] 为 [x] → checklist_write(task_dir, content)
✅ 重新规划任务：直接传入新的完整步骤列表
✅ 批量打勾：传入的内容中已勾选的步骤会被正确计算进度`,
      parameters: ChecklistWriteParamsSchema,
      async execute(_id, params) {
        return executeChecklistWrite(_id, params as any);
      },
    });
  },
});
