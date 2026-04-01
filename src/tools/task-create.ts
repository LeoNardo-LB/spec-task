import { join } from "path";
import { writeFile, mkdir } from "fs/promises";
import type { TaskCreateParams, TaskStatusData, TaskCreateResult } from "../types.js";
import { StatusStore } from "../core/status-store.js";
import { RevisionBuilder } from "../core/revision.js";
import { FileUtils } from "../file-utils.js";
import { getNextRunId, getActiveRuns, resolveRunDir, resolveTaskRoot } from "../core/run-utils.js";
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
      description: "执行计划：说明策略、关键决策、步骤分解和依赖。格式：## Strategy\n...\n## Key Decisions\n...\n## Steps Overview\n...",
    },
  },
};

/**
 * task_create 工具实现。
 *
 * 行为矩阵：
 * 1. 任务不存在 → 创建任务目录 + runs/001/ + 写入 brief/plan + 创建 status.yaml
 * 2. 任务存在 + 所有 runs 终态 → 更新 brief/plan（如有）+ 创建 runs/NEXT/status.yaml
 * 3. 任务存在 + 有活跃 runs → 错误 "task has active runs"
 * 4. 任务不存在 + 无 brief → 错误 "brief is required for new task"
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
  const taskRoot = resolveTaskRoot(task_name, project_root);

  // 2. 判断任务是否已存在
  const taskExists = await fu.safeStat(taskRoot);

  if (!taskExists) {
    // 场景 4：新任务必须提供 brief
    if (!brief) {
      return formatError("INVALID_PARAMS", "brief is required for new task");
    }
  }

  if (taskExists) {
    // 场景 3：检查是否有活跃 runs
    const activeRuns = await getActiveRuns(taskRoot);
    if (activeRuns.length > 0) {
      return formatError(
        "TASK_HAS_ACTIVE_RUNS",
        `Task '${task_name}' has active run(s): ${activeRuns.join(", ")}. Complete or cancel them before creating a new run.`,
      );
    }

    // 场景 2：所有 runs 终态，可以创建新 run
    // 如提供了 brief/plan，更新任务根目录的构件
    if (brief) {
      await writeFile(join(taskRoot, "brief.md"), brief, "utf-8");
    }
    if (plan) {
      await writeFile(join(taskRoot, "plan.md"), plan, "utf-8");
    }
  } else {
    // 场景 1：新任务，创建任务根目录
    await fu.ensureDir(taskRoot);

    // 写入 brief.md 和 plan.md 到任务根目录
    if (brief) {
      await writeFile(join(taskRoot, "brief.md"), brief, "utf-8");
    }
    if (plan) {
      await writeFile(join(taskRoot, "plan.md"), plan, "utf-8");
    }
  }

  // 3. 获取下一个 run ID 并创建 run 目录
  const runId = await getNextRunId(taskRoot);
  const runDir = resolveRunDir(task_name, runId, project_root);
  await mkdir(runDir, { recursive: true });

  // 4. 构建初始 status（不含 steps，steps 由 steps_update 写入）
  const now = new Date().toISOString();
  const initialData: TaskStatusData = {
    task_id: task_name,
    title,
    created: now,
    updated: now,
    status: "pending",
    assigned_to,
    run_id: runId,
    started_at: null,
    completed_at: null,
    progress: { total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 },
    steps: [],
    outputs: [],
    errors: [],
    blocked_by: [],
    verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
    revisions: [],
  };

  // 5. 创建 revision + 保存 status.yaml 到 runDir
  const revisionSummary = taskExists
    ? `New run ${runId} created for task '${task_name}'`
    : `Task '${task_name}' created with run ${runId}`;
  const revision = rb.build({
    data: initialData,
    type: "created",
    trigger: assigned_to,
    summary: revisionSummary,
  });
  initialData.revisions.push(revision);
  await store.saveStatus(runDir, initialData);

  // 6. 收集创建信息
  const createdArtifacts: string[] = [];
  if (brief) createdArtifacts.push("brief");
  if (plan) createdArtifacts.push("plan");

  return formatResult({
    success: true,
    task_dir: runDir,
    task_id: task_name,
    status: "pending",
    run_id: runId,
    created_dirs: [taskRoot, runDir],
    created_artifacts: createdArtifacts,
  } satisfies TaskCreateResult);
}
