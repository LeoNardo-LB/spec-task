import type { TaskProgress } from "../types.js";
import { FileUtils } from "../file-utils.js";

/** 匹配 checkbox 行：`- [x] ...` 或 `- [ ] ...` */
const CHECKBOX_REGEX = /^- \[([ x])\]\s*(.+)/;

/** 从 checkbox 文本中提取步骤编号（如 "1.1", "1.2.3", "10.1"），等价于 v1.0 的 STEP_PATTERN */
const STEP_PATTERN = /^(\d+(?:\.\d+)+)/;

export class ProgressCalculator {
  private fileUtils: FileUtils;

  constructor(fileUtils?: FileUtils) {
    this.fileUtils = fileUtils ?? new FileUtils();
  }

  /**
   * 解析 checklist.md，计算进度。
   * 等价于 v1.0 的 calc_progress()。
   *
   * 宽松正则匹配所有 checkbox 行，再用严格正则提取步骤编号。
   * 不含步骤编号的 checkbox 行不计入 total。
   *
   * @returns { total, completed, current_step, percentage }
   * 文件不存在返回全零。
   */
  async calculate(checklistPath: string): Promise<TaskProgress> {
    try {
      const content = await this.fileUtils.safeReadFile(checklistPath);
      if (!content) return { total: 0, completed: 0, current_step: "", percentage: 0 };

      const lines = content.split("\n");
      const items: Array<{ checked: boolean; step: string }> = [];
      for (const line of lines) {
        const checkboxMatch = line.match(CHECKBOX_REGEX);
        if (!checkboxMatch) continue;

        const checked = checkboxMatch[1] === "x";
        const text = checkboxMatch[2].trim();
        const stepMatch = text.match(STEP_PATTERN);
        if (!stepMatch) continue; // 无步骤编号，跳过

        items.push({ checked, step: stepMatch[1] });
      }

      const total = items.length;
      const completed = items.filter(i => i.checked).length;
      const firstUnchecked = items.find(i => !i.checked);
      const currentStep = firstUnchecked ? firstUnchecked.step : "";
      const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

      return { total, completed, current_step: currentStep, percentage };
    } catch {
      return { total: 0, completed: 0, current_step: "", percentage: 0 };
    }
  }
}
