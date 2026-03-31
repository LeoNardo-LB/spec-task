import { join } from "path";
import { writeFile } from "fs/promises";
import type { TaskCreateParams, TaskStatusData, TaskCreateResult } from "../types.js";
import { StatusStore } from "../core/status-store.js";
import { RevisionBuilder } from "../core/revision.js";
import { FileUtils } from "../file-utils.js";
import { markdownToSteps, syncStepsToStatus } from "../core/checklist-utils.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const TaskCreateParamsSchema = {
  type: "object",
  required: ["task_name"],
  properties: {
    task_name: { type: "string", description: "Task name in kebab-case (required)" },
    project_root: { type: "string", description: "Project root directory (default: cwd)" },
    title: { type: "string", description: "Human-readable title (default: task_name)" },
    assigned_to: { type: "string", description: "Assigned agent (default: 'agent')" },
    brief: {
      type: "string",
      description: "任务简报：定义目标和成功标准。格式：## 目标\n...\n## 成功标准\n...",
    },
    plan: {
      type: "string",
      description: "执行计划：说明步骤分解和策略。格式：## 概述\n...\n## 步骤分解\n...",
    },
    checklist: {
      type: "string",
      description: "进度追踪清单：markdown checkbox 列表。格式：## 1. 阶段\n- [ ] 1.1 步骤\n...",
    },
  },
};

/**
 * task_create 工具实现。
 * 创建目录结构 → 初始化 status.yaml → 写入构件内容 → 创建 revision。
 */
export async function executeTaskCreate(
  _id: string,
  params: TaskCreateParams
): Promise<ToolResponse> {
  const {
    task_name,
    project_root = process.cwd(),
    title = task_name,
    assigned_to = "agent",
    brief,
    plan,
    checklist,
  } = params;

  // 1. 参数校验
  if (!task_name || task_name.trim() === "")
    return formatError("INVALID_PARAMS", "task_name must not be empty");
  if (task_name.includes("/") || task_name.includes("\0") || task_name.includes("\\"))
    return formatError("INVALID_PARAMS", `task_name contains illegal characters: ${task_name}`);

  const fu = new FileUtils();

  // 防御：验证 project_root 是 agent workspace 而非项目根目录
  const wsCheck = await fu.validateWorkspacePath(project_root);
  if (!wsCheck.valid) {
    return formatError("INVALID_PARAMS", `Invalid project_root: ${wsCheck.reason}`);
  }

  const store = new StatusStore();
  const rb = new RevisionBuilder();
  const taskDir = fu.resolveTaskDir(task_name, project_root);

  // 2. 检查重复
  if (await fu.safeStat(join(taskDir, "status.yaml")))
    return formatError("TASK_ALREADY_EXISTS", `Task '${task_name}' already exists at ${taskDir}`);

  // 3. 创建任务目录
  await fu.ensureDir(taskDir);

  // 4. 从 checklist 解析 steps
  let steps: import("../types.js").Step[] = [];
  let progress: import("../types.js").TaskProgress = { total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 };

  if (checklist) {
    steps = markdownToSteps(checklist);
    const { calculateProgressFromSteps } = await import("../core/checklist-utils.js");
    progress = calculateProgressFromSteps(steps);
  }

  // 5. 构建初始 status
  const now = new Date().toISOString();
  const initialData: TaskStatusData = {
    task_id: task_name, title, created: now, updated: now,
    status: "pending", assigned_to,
    started_at: null, completed_at: null,
    progress,
    steps,
    children: [], outputs: [],
    timing: { elapsed_minutes: null },
    errors: [], alerts: [], blocked_by: [],
    verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
    revisions: [],
  };

  // 6. 创建 revision + 保存
  const revision = rb.build({ data: initialData, type: "created", trigger: assigned_to, summary: `Task '${task_name}' created` });
  initialData.revisions.push(revision);
  await store.saveStatus(taskDir, initialData);

  // 7. 写入 LLM 传入的构件内容
  const createdArtifacts: string[] = [];

  if (brief) {
    const filePath = join(taskDir, "brief.md");
    await writeFile(filePath, brief, "utf-8");
    createdArtifacts.push("brief");
  }

  if (plan) {
    const filePath = join(taskDir, "plan.md");
    await writeFile(filePath, plan, "utf-8");
    createdArtifacts.push("plan");
  }

  if (checklist) {
    const filePath = join(taskDir, "checklist.md");
    await writeFile(filePath, checklist, "utf-8");
    createdArtifacts.push("checklist");
  }

  return formatResult({
    success: true,
    task_dir: taskDir,
    task_id: task_name,
    status: "pending",
    created_dirs: [taskDir],
    created_artifacts: createdArtifacts,
  } satisfies TaskCreateResult);
}
