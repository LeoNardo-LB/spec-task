import { join } from "path";
import { writeFile, mkdir } from "fs/promises";
import type { ChecklistWriteParams, ChecklistWriteResult } from "../types.js";
import { updateProgress } from "../core/checklist-utils.js";
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
      description: "完整的 checklist markdown 内容。全量覆盖 checklist.md，传入什么就存什么。包含 checkbox 的行会自动被解析用于进度计算。",
    },
  },
};

/**
 * checklist_write 工具实现。
 *
 * 全量覆盖 checklist.md + 自动更新 status.yaml 进度。
 * 不做格式校验，LLM 拥有完全自由度。
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

  // 3. 写入 checklist.md（全量覆盖）
  await writeFile(checklistPath, content, "utf-8");

  // 4. 自动更新 status.yaml 进度（静默失败）
  updateProgress(task_dir);

  return formatResult({
    success: true,
    task_dir,
    checklist_path: checklistPath,
  } satisfies ChecklistWriteResult);
}
