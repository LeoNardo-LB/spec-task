import { join, resolve } from "path";
import type { ChecklistReadParams, ChecklistReadResult } from "../types.js";
import { FileUtils } from "../file-utils.js";
import { calculateProgressSync } from "../core/checklist-utils.js";
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
 * 全量读取 checklist.md 内容 + 结构化进度统计。
 * 不修改任何文件。
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

  // 2. 检查 checklist.md 是否存在
  const checklistStat = await fu.safeStat(checklistPath);
  if (!checklistStat || !checklistStat.isFile()) {
    return formatError("CHECKLIST_NOT_FOUND", `checklist.md not found at ${checklistPath}`);
  }

  // 3. 读取内容
  const content = await fu.safeReadFile(checklistPath);
  if (!content) {
    return formatError("CHECKLIST_NOT_FOUND", `checklist.md is empty or unreadable at ${checklistPath}`);
  }

  // 4. 计算进度（复用 checklist-utils 的 calculateProgressSync）
  const progress = calculateProgressSync(content);

  return formatResult({
    success: true,
    content,
    progress,
    checklist_path: checklistPath,
  } satisfies ChecklistReadResult);
}
