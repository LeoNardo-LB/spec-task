/**
 * Checklist 解析与操作工具函数。
 *
 * 所有操作均为同步（readFileSync / writeFileSync / existsSync），
 * 因为会被同步 hook 调用。
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { TaskProgress } from "../types.js";

// ============================================================================
// 类型
// ============================================================================

export interface ChecklistStep {
  checked: boolean;
  text: string;
  stepNumber?: string;
  tag?: string;
}

// ============================================================================
// 常量正则
// ============================================================================

/** 匹配 checkbox 行：`- [x] ...` 或 `- [ ] ...` */
const CHECKBOX_REGEX = /^- \[([ x])\]\s*(.+)/;

/** 从 checkbox 文本中提取步骤编号（如 "1.1", "1.2.3"） */
const STEP_PATTERN = /^(\d+(?:\.\d+)+)/;

/** 从文本中提取标签（如 `[spawn:financial-valuation]` → `spawn:financial-valuation`） */
const TAG_PATTERN = /\[([\w-]+:[\w-]+)\]/;

// ============================================================================
// parseChecklist
// ============================================================================

/**
 * 解析 checklist.md 文本内容，返回 ChecklistStep 数组。
 */
export function parseChecklist(content: string): ChecklistStep[] {
  const lines = content.split("\n");
  const steps: ChecklistStep[] = [];

  for (const line of lines) {
    const match = line.match(CHECKBOX_REGEX);
    if (!match) continue;

    const checked = match[1] === "x";
    const text = match[2].trim();

    const stepMatch = text.match(STEP_PATTERN);
    const stepNumber = stepMatch ? stepMatch[1] : undefined;

    const tagMatch = text.match(TAG_PATTERN);
    const tag = tagMatch ? tagMatch[1] : undefined;

    steps.push({ checked, text, stepNumber, tag });
  }

  return steps;
}

// ============================================================================
// toggleStep
// ============================================================================

/**
 * 在 checklist 内容中切换指定步骤的 checkbox 状态。
 *
 * @param content  checklist.md 的完整文本
 * @param matchFn  匹配函数，返回 true 时选中该步骤
 * @param checked  目标状态：true 勾选，false 取消勾选
 * @returns { content: string, matched: boolean }
 *   - matched=false：步骤未找到，或当前状态已与目标一致（无需修改）
 *   - matched=true：已修改，content 为新内容
 */
export function toggleStep(
  content: string,
  matchFn: (step: ChecklistStep) => boolean,
  checked: boolean,
): { content: string; matched: boolean } {
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineMatch = lines[i].match(CHECKBOX_REGEX);
    if (!lineMatch) continue;

    const currentChecked = lineMatch[1] === "x";
    const text = lineMatch[2].trim();

    // 构建 ChecklistStep 供 matchFn 判断
    const stepMatch = text.match(STEP_PATTERN);
    const stepNumber = stepMatch ? stepMatch[1] : undefined;

    const tagMatch = text.match(TAG_PATTERN);
    const tag = tagMatch ? tagMatch[1] : undefined;

    const step: ChecklistStep = { checked: currentChecked, text, stepNumber, tag };

    if (!matchFn(step)) continue;

    // 找到匹配的步骤
    if (currentChecked === checked) {
      // 状态已一致，无需修改
      return { content, matched: false };
    }

    // 用字符串操作修改 checkbox 部分：找到 `- [` 后面的第一个字符
    const bracketIdx = lines[i].indexOf("[");
    const newCheckbox = checked ? "x" : " ";
    lines[i] = lines[i].substring(0, bracketIdx + 1) + newCheckbox + lines[i].substring(bracketIdx + 2);

    return { content: lines.join("\n"), matched: true };
  }

  // 没有匹配的步骤
  return { content, matched: false };
}

// ============================================================================
// updateProgress
// ============================================================================

/**
 * 同步更新 taskDir 下的 status.yaml 中的 progress 字段。
 *
 * 读取 checklist.md → 计算进度 → 写入 status.yaml。
 * status.yaml 不存在或 checklist.md 不存在时静默忽略。
 */
export function updateProgress(taskDir: string): void {
  try {
    const statusPath = join(taskDir, "status.yaml");
    if (!existsSync(statusPath)) return;

    const checklistPath = join(taskDir, "checklist.md");
    if (!existsSync(checklistPath)) return;

    // 读取并计算进度
    const checklistContent = readFileSync(checklistPath, "utf-8");
    const progress = calculateProgressSync(checklistContent);

    // 读取 status.yaml，更新 progress，写回
    const statusContent = readFileSync(statusPath, "utf-8");
    const statusData = YAML.parse(statusContent) ?? {};
    statusData.progress = progress;
    writeFileSync(statusPath, YAML.stringify(statusData), "utf-8");
  } catch {
    // 静默忽略所有错误
  }
}

/**
 * 纯同步的 checklist 进度计算。
 * 逻辑与 ProgressCalculator.calculate 保持一致。
 */
export function calculateProgressSync(content: string): TaskProgress {
  const steps = parseChecklist(content);

  // 只计算有 stepNumber 的步骤（与 ProgressCalculator 一致）
  const items = steps.filter((s) => s.stepNumber !== undefined);

  const total = items.length;
  const completed = items.filter((s) => s.checked).length;
  const firstUnchecked = items.find((s) => !s.checked);
  const currentStep = firstUnchecked?.stepNumber ?? "";
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { total, completed, current_step: currentStep, percentage };
}
