import { join } from "path";
import { writeFile, readFile } from "fs/promises";
import type { ChecklistUpdateParams, ChecklistUpdateResult, TaskProgress } from "../types.js";
import { FileUtils } from "../file-utils.js";
import { ProgressCalculator } from "../core/progress.js";
import { StatusStore } from "../core/status-store.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const ChecklistUpdateParamsSchema = {
  type: "object",
  required: ["task_dir", "step_number", "checked"],
  properties: {
    task_dir: {
      type: "string",
      description: "任务目录的绝对路径（task_create 返回的 task_dir）",
    },
    step_number: {
      type: "string",
      description: "步骤编号，如 '1.1'、'2.3'。必须与 checklist.md 中的编号完全匹配。",
    },
    checked: {
      type: "boolean",
      description: "true 表示勾选（标记为完成），false 表示取消勾选。",
    },
  },
};

/**
 * 匹配包含步骤编号的 checkbox 行。
 * 与 ProgressCalculator 的 CHECKBOX_REGEX + STEP_PATTERN 保持一致：
 * - CHECKBOX_REGEX: /^- \[([ x])\]\s*(.+)/
 * - STEP_PATTERN: /^(\d+(?:\.\d+)+)/  （要求至少一个点号）
 */
const STEP_CHECKBOX_REGEX = /^- \[([ x])\]\s*(\d+(?:\.\d+)+)\s+(.+)/;

/**
 * checklist_update 工具实现。
 *
 * 设计目标（参考 Claude Code 的 TodoWrite）：
 * - 一次 API 调用完成单个 checklist 条目的勾选/取消勾选
 * - 自动更新 status.yaml 的 progress 字段
 * - 不自动推断步骤状态，完全由 LLM 显式控制
 *
 * 不做的事：
 * - 不自动打勾（防止误判）
 * - 不修改 checklist 的其他内容
 * - 不写入 revision 记录（checkbox 更新不是状态转换）
 */
export async function executeChecklistUpdate(
  _id: string,
  params: ChecklistUpdateParams
): Promise<ToolResponse> {
  const { task_dir, step_number, checked } = params;

  // 1. 参数校验
  if (!task_dir || task_dir.trim() === "") {
    return formatError("INVALID_PARAMS", "task_dir must not be empty");
  }
  if (!step_number || step_number.trim() === "") {
    return formatError("INVALID_PARAMS", "step_number must not be empty");
  }
  if (typeof checked !== "boolean") {
    return formatError("INVALID_PARAMS", "checked must be a boolean (true or false)");
  }
  // 验证 step_number 格式（至少含一个点号，与 ProgressCalculator 一致）
  if (!/^\d+(?:\.\d+)+$/.test(step_number)) {
    return formatError("INVALID_PARAMS", `Invalid step_number format: "${step_number}". Expected format: "1.1", "2.3", etc. (must contain at least one dot).`);
  }

  const fu = new FileUtils();
  const checklistPath = join(task_dir, "checklist.md");

  // 2. 检查 checklist.md 是否存在
  const checklistStat = await fu.safeStat(checklistPath);
  if (!checklistStat || !checklistStat.isFile()) {
    return formatError("TASK_NOT_FOUND", `checklist.md not found at ${checklistPath}`);
  }

  // 3. 读取并修改 checklist.md
  const content = await readFile(checklistPath, "utf-8");
  const lines = content.split("\n");

  let matchFound = false;
  let lineBefore = "";
  let lineAfter = "";

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(STEP_CHECKBOX_REGEX);
    if (!match) continue;

    const currentChecked = match[1] === "x";
    const currentStepNumber = match[2];

    if (currentStepNumber === step_number) {
      matchFound = true;
      lineBefore = lines[i];

      if (currentChecked === checked) {
        // 状态未变化，返回提示
        return formatResult({
          success: true,
          task_dir,
          step_number,
          checked,
          line_before: lineBefore,
          line_after: lineBefore,
          progress: { total: 0, completed: 0, current_step: "", percentage: 0 },
          progress_note: `Step ${step_number} is already ${checked ? "checked" : "unchecked"}. No change made.`,
        } satisfies ChecklistUpdateResult & { progress_note: string });
      }

      // 执行替换
      const checkbox = checked ? "x" : " ";
      lines[i] = `- [${checkbox}] ${match[2]} ${match[3]}`;
      lineAfter = lines[i];
      break;
    }
  }

  if (!matchFound) {
    return formatError(
      "INVALID_PARAMS",
      `Step "${step_number}" not found in checklist.md. Available steps can be found by reading the file.`
    );
  }

  // 4. 写回 checklist.md
  await writeFile(checklistPath, lines.join("\n"), "utf-8");

  // 5. 重新计算进度
  const pc = new ProgressCalculator(fu);
  const newProgress: TaskProgress = await pc.calculate(checklistPath);

  // 6. 更新 status.yaml 的 progress 字段（事务方式）
  const store = new StatusStore();
  try {
    await store.transaction(task_dir, (data) => {
      data.progress = newProgress;
      return data;
    });
  } catch (err) {
    // status.yaml 更新失败不影响 checklist 本身的更新
    const msg = err instanceof Error ? err.message : String(err);
    return formatResult({
      success: true,
      task_dir,
      step_number,
      checked,
      line_before: lineBefore,
      line_after: lineAfter,
      progress: newProgress,
      warning: `checklist.md updated successfully, but status.yaml progress update failed: ${msg}`,
    } satisfies ChecklistUpdateResult & { warning: string });
  }

  return formatResult({
    success: true,
    task_dir,
    step_number,
    checked,
    line_before: lineBefore,
    line_after: lineAfter,
    progress: newProgress,
  } satisfies ChecklistUpdateResult);
}
