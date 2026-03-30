import { join } from "path";
import type { TaskCreateParams, TaskStatusData, TaskCreateResult } from "../types.js";
import { StatusStore } from "../core/status-store.js";
import { RevisionBuilder } from "../core/revision.js";
import { FileUtils } from "../file-utils.js";
import { ConfigManager } from "../core/config.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const TaskCreateParamsSchema = {
  type: "object",
  required: ["task_name"],
  properties: {
    task_name: { type: "string", description: "Task name in kebab-case (required)" },
    project_root: { type: "string", description: "Project root directory (default: cwd)" },
    title: { type: "string", description: "Human-readable title (default: task_name)" },
    assigned_to: { type: "string", description: "Assigned agent (default: 'agent')" },
    parent: { type: "string", description: "Parent task directory path" },
    depth: { type: "number", description: "Nesting depth (default: 0)" },
  },
};

/**
 * task_create 工具实现。
 * 创建目录结构 → 初始化 status.yaml → 创建 revision → 注册父子关系。
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
    parent = null,
    depth = 0,
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

  // 4. 构建初始 status
  const now = new Date().toISOString();
  const initialData: TaskStatusData = {
    task_id: task_name, title, created: now, updated: now,
    status: "pending", assigned_to,
    started_at: null, completed_at: null,
    progress: { total: 0, completed: 0, current_step: "", percentage: 0 },
    parent, depth, children: [], outputs: [],
    timing: { estimated_minutes: null, elapsed_minutes: null },
    errors: [], alerts: [], blocked_by: [],
    verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
    revisions: [],
  };

  // 5. 创建 revision + 保存
  const revision = rb.build({ data: initialData, type: "created", trigger: assigned_to, summary: `Task '${task_name}' created` });
  initialData.revisions.push(revision);
  await store.saveStatus(taskDir, initialData);

  // 6. 更新父任务 children
  if (parent && await fu.safeStat(join(parent, "status.yaml"))) {
    try {
      await store.transaction(parent, (pd) => { if (!pd.children.includes(taskDir)) pd.children.push(taskDir); return pd; });
    } catch { /* 父任务更新失败不阻塞 */ }
  }

  return formatResult({ success: true, task_dir: taskDir, task_id: task_name, status: "pending", created_dirs: [taskDir] } satisfies TaskCreateResult);
}
