import { join } from "path";
import { writeFile, mkdir } from "fs/promises";
import type { ChecklistWriteParams, ChecklistWriteResult } from "../types.js";
import { markdownToSteps, syncStepsToStatus, loadStepsFromStatus } from "../core/checklist-utils.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const ChecklistWriteParamsSchema = {
  type: "object",
  required: ["task_dir", "content"],
  properties: {
    task_dir: {
      type: "string",
      description: "任务目录的绝对路径（task_create 返回的 task_dir）",
    },
    content: {
      type: "string",
      description: "完整的 checklist markdown 内容。全量覆盖 checklist.md，传入什么就存什么。支持 `[x]` 完成、`[ ]` 待完成、`[-] 跳过 (原因)` 三种标记。",
    },
  },
};

/**
 * checklist_write 工具实现。
 *
 * 全量覆盖 checklist.md + 解析为 steps 更新 status.yaml。
 * status.yaml.steps 是步骤状态的唯一权威数据源。
 */
export async function executeChecklistWrite(
  _id: string,
  params: ChecklistWriteParams
): Promise<ToolResponse> {
  const { task_dir, content } = params;

  // 1. 参数校验
  if (!task_dir || task_dir.trim() === "") {
    return formatError("INVALID_PARAMS", "task_dir must not be empty");
  }
  if (!content || content.trim() === "") {
    return formatError("INVALID_PARAMS", "content must not be empty");
  }

  const checklistPath = join(task_dir, "checklist.md");

  // 2. 确保 task_dir 存在
  try {
    await mkdir(task_dir, { recursive: true });
  } catch {
    return formatError("INVALID_PARAMS", `task_dir does not exist and cannot be created: ${task_dir}`);
  }

  // 3. 读取已有 steps（保留 completed_at）
  const existingSteps = loadStepsFromStatus(task_dir);

  // 4. 解析 markdown → 结构化 steps
  const steps = markdownToSteps(content, existingSteps ?? undefined);

  // 5. 写入 checklist.md（全量覆盖）
  await writeFile(checklistPath, content, "utf-8");

  // 6. 同步更新 status.yaml.steps + progress（静默失败）
  syncStepsToStatus(task_dir, steps);

  return formatResult({
    success: true,
    task_dir,
    checklist_path: checklistPath,
  } satisfies ChecklistWriteResult);
}
