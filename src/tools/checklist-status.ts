import { join, resolve } from "path";
import type { ChecklistStatusParams, ChecklistStatusResult } from "../types.js";
import { FileUtils } from "../file-utils.js";
import { ProgressCalculator } from "../core/progress.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const ChecklistStatusParamsSchema = {
  type: "object",
  required: ["task_dir"],
  properties: {
    task_dir: {
      type: "string",
      description: "任务目录的绝对路径（task_create 返回的 task_dir）",
    },
  },
};

/** 匹配 checkbox 行：`- [x] ...` 或 `- [ ] ...` */
const CHECKBOX_REGEX = /^- \[([ x])\]\s*(.+)/;

/** 从 checkbox 文本中提取步骤编号（如 "1.1", "1.2.3"） */
const STEP_PATTERN = /^(\d+(?:\.\d+)+)/;

/**
 * checklist_status 工具实现。
 *
 * 只读查询工具，返回指定任务目录的 checklist 完成进度。
 * 不修改任何文件。
 */
export async function executeChecklistStatus(
  _id: string,
  params: ChecklistStatusParams
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

  // 3. 读取并解析 checklist.md
  const content = await fu.safeReadFile(checklistPath);
  if (!content) {
    return formatError("CHECKLIST_NOT_FOUND", `checklist.md is empty or unreadable at ${checklistPath}`);
  }

  const lines = content.split("\n");
  const items: Array<{ checked: boolean; step: string; index: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const checkboxMatch = lines[i].match(CHECKBOX_REGEX);
    if (!checkboxMatch) continue;

    const checked = checkboxMatch[1] === "x";
    const text = checkboxMatch[2].trim();
    const stepMatch = text.match(STEP_PATTERN);

    if (stepMatch) {
      items.push({ checked, step: stepMatch[1], index: i });
    } else {
      // 无编号步骤：使用序号作为标识
      items.push({ checked, step: `#${items.length + 1}`, index: i });
    }
  }

  const total = items.length;
  const completed = items.filter(i => i.checked).length;
  const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const unchecked = items.filter(i => !i.checked);
  const uncheckedSteps = unchecked.map(i => i.step);
  const nextSuggestedStep = unchecked.length > 0 ? unchecked[0].step : null;

  return formatResult({
    success: true,
    total_steps: total,
    completed_steps: completed,
    progress_percent: progressPercent,
    unchecked_steps: uncheckedSteps,
    next_suggested_step: nextSuggestedStep,
    checklist_path: checklistPath,
  } satisfies ChecklistStatusResult);
}
