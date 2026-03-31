/**
 * Checklist 解析与操作工具函数。
 *
 * 核心职责：markdown checklist ↔ 结构化 Step[] 的双向转换。
 * status.yaml.steps 是步骤状态的唯一权威数据源。
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { Step, StepStatus, TaskProgress } from "../types.js";

// ============================================================================
// 常量正则
// ============================================================================

/** 匹配 checkbox 行：`- [x] ...`、`- [ ] ...`、`- [-] ...` */
const CHECKBOX_REGEX = /^- \[([x -])\]\s*(.+)/;

/** 从 checkbox 文本中提取步骤编号（如 "1.1", "1.2.3"） */
const STEP_PATTERN = /^(\d+(?:\.\d+)+)/;

/** 从文本中提取标签（如 `[spawn:financial-valuation]` → `spawn:financial-valuation`） */
const TAG_PATTERN = /\[([\w-]+:[\w-]+)\]/;

/** 从文本中提取跳过原因（如 `(数据不可用)` → `数据不可用`） */
const SKIP_REASON_PATTERN = /\(([^)]+)\)/;

// ============================================================================
// parseChecklist（扩展支持 [-]）
// ============================================================================

/**
 * 解析 checklist.md 文本内容，返回 ParsedChecklistStep 数组。
 * 支持 [x]（completed）、[ ]（pending）、[-]（skipped）。
 */
export function parseChecklist(content: string): ParsedChecklistStep[] {
  const lines = content.split("\n");
  const steps: ParsedChecklistStep[] = [];

  for (const line of lines) {
    const match = line.match(CHECKBOX_REGEX);
    if (!match) continue;

    const marker = match[1].trim();
    const text = match[2].trim();

    const stepMatch = text.match(STEP_PATTERN);
    const stepNumber = stepMatch ? stepMatch[1] : undefined;

    // 跳过无步骤编号的 checkbox 行
    if (!stepNumber) continue;

    const tagMatch = text.match(TAG_PATTERN);
    const tag = tagMatch ? tagMatch[1] : undefined;

    let status: StepStatus = "pending";
    if (marker === "x") status = "completed";
    else if (marker === "-") status = "skipped";

    let skipReason: string | undefined;
    if (status === "skipped") {
      const reasonMatch = text.match(SKIP_REASON_PATTERN);
      skipReason = reasonMatch ? reasonMatch[1] : undefined;
    }

    steps.push({ stepNumber, text, status, tag, skipReason });
  }

  return steps;
}

/** parseChecklist 返回的中间结构 */
export interface ParsedChecklistStep {
  stepNumber: string;
  text: string;
  status: StepStatus;
  tag?: string;
  skipReason?: string;
}

// ============================================================================
// markdownToSteps（markdown → 结构化 Step[]）
// ============================================================================

/**
 * 将 markdown checklist 文本转换为结构化 Step 数组。
 * 保留已有步骤的 completed_at（通过 existingSteps 映射）。
 *
 * @param content        markdown checklist 文本
 * @param existingSteps  已有的 steps 数组（用于保留 completed_at）
 */
export function markdownToSteps(content: string, existingSteps?: Step[]): Step[] {
  const parsed = parseChecklist(content);
  const existingMap = new Map<string, Step>();
  if (existingSteps) {
    for (const s of existingSteps) {
      existingMap.set(s.id, s);
    }
  }

  const now = new Date().toISOString();
  return parsed.map(p => {
    const existing = existingMap.get(p.stepNumber);
    const tags: string[] = p.tag ? [p.tag] : [];

    return {
      id: p.stepNumber,
      text: p.text.replace(STEP_PATTERN, "").replace(TAG_PATTERN, "").replace(SKIP_REASON_PATTERN, "").trim(),
      status: p.status,
      completed_at: p.status !== "pending"
        ? (existing?.completed_at ?? now)
        : null,
      tags,
      ...(p.skipReason ? { skip_reason: p.skipReason } : {}),
    };
  });
}

// ============================================================================
// calculateProgressFromSteps
// ============================================================================

/**
 * 从结构化 Step 数组计算进度。
 * 不再依赖 markdown 解析。
 */
export function calculateProgressFromSteps(steps: Step[]): TaskProgress {
  const total = steps.length;
  const completed = steps.filter(s => s.status === "completed").length;
  const skipped = steps.filter(s => s.status === "skipped").length;
  const firstPending = steps.find(s => s.status === "pending");
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { total, completed, skipped, current_step: firstPending?.id ?? "", percentage };
}

// ============================================================================
// syncStepsToStatus
// ============================================================================

/**
 * 同步更新 taskDir 下 status.yaml 中的 steps 和 progress 字段。
 * 读取现有 steps 以保留 completed_at，全量替换 steps 数组。
 * status.yaml 不存在时静默忽略。
 */
export function syncStepsToStatus(taskDir: string, steps: Step[]): void {
  try {
    const statusPath = join(taskDir, "status.yaml");
    if (!existsSync(statusPath)) return;

    const statusContent = readFileSync(statusPath, "utf-8");
    const statusData = YAML.parse(statusContent) ?? {};
    statusData.steps = steps;
    statusData.progress = calculateProgressFromSteps(steps);
    writeFileSync(statusPath, YAML.stringify(statusData), "utf-8");
  } catch {
    // 静默忽略所有错误
  }
}

// ============================================================================
// loadStepsFromStatus
// ============================================================================

/**
 * 从 status.yaml 读取 steps 数组。
 * 返回 null 表示 status.yaml 不存在或 steps 字段不存在。
 */
export function loadStepsFromStatus(taskDir: string): Step[] | null {
  try {
    const statusPath = join(taskDir, "status.yaml");
    if (!existsSync(statusPath)) return null;

    const statusContent = readFileSync(statusPath, "utf-8");
    const statusData = YAML.parse(statusContent) ?? {};
    const steps = statusData.steps;

    if (Array.isArray(steps) && steps.length > 0) return steps;
    return null;
  } catch {
    return null;
  }
}
