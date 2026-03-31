import { join, resolve } from "path";
import { readFileSync, existsSync } from "fs";
import YAML from "yaml";
import type { ChecklistReadParams, ChecklistReadResult, Step, TaskProgress } from "../types.js";
import { FileUtils } from "../file-utils.js";
import { calculateProgressFromSteps, loadStepsFromStatus, markdownToSteps, syncStepsToStatus } from "../core/checklist-utils.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const ChecklistReadParamsSchema = {
  type: "object",
  required: ["task_dir"],
  properties: {
    task_dir: {
      type: "string",
      description: "任务目录的绝对路径（task_create 返回的 task_dir）",
    },
  },
};

/**
 * checklist_read 工具实现。
 *
 * 从 status.yaml.steps 读取结构化步骤数据。
 * 如果 steps 不存在但 checklist.md 存在，自动迁移。
 * 如果两者都不存在，返回错误。
 */
export async function executeChecklistRead(
  _id: string,
  params: ChecklistReadParams
): Promise<ToolResponse> {
  const { task_dir } = params;

  // 1. 参数校验
  if (!task_dir || task_dir.trim() === "") {
    return formatError("INVALID_PARAMS", "task_dir must not be empty");
  }

  const fu = new FileUtils();
  const checklistPath = resolve(task_dir, "checklist.md");

  // 2. 尝试从 status.yaml.steps 读取
  let steps = loadStepsFromStatus(task_dir);
  let content: string | null = null;

  // 3. 读取 checklist.md 内容（如果存在）
  if (existsSync(checklistPath)) {
    try {
      content = readFileSync(checklistPath, "utf-8");
    } catch {
      content = null;
    }
  }

  // 4. 向后兼容：steps 不存在但 checklist.md 存在时，自动迁移
  if (!steps && content) {
    console.warn(`[spec-task] Auto-migrated checklist.md → status.yaml.steps for ${task_dir}`);
    steps = markdownToSteps(content);
    syncStepsToStatus(task_dir, steps);
  }

  // 5. 两者都不存在
  if (!steps || steps.length === 0) {
    return formatError("CHECKLIST_NOT_FOUND", `No checklist data found at ${task_dir}`);
  }

  // 6. 从 steps 计算进度
  const progress: TaskProgress = calculateProgressFromSteps(steps);

  return formatResult({
    success: true,
    steps,
    progress,
    content,
    checklist_path: checklistPath,
  } satisfies ChecklistReadResult);
}
