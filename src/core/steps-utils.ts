/**
 * Checklist 操作工具函数。
 *
 * 核心职责：步骤进度计算、steps 与 status.yaml 的同步。
 * status.yaml.steps 是步骤状态的唯一权威数据源。
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { Step, TaskProgress, VerificationStatus } from "../types.js";

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
// validateStepsForCompletion
// ============================================================================

export interface StepsCompletionValidation {
  valid: boolean;
  reason?: string;
  incompleteStepIds?: string[];
}

/**
 * 校验 steps 是否满足完成条件（所有步骤 completed 或 skipped）。
 * 用于 task_transition(completed) 前置检查和 task_verify finalize 前置检查。
 */
export function validateStepsForCompletion(steps: Step[]): StepsCompletionValidation {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { valid: false, reason: "任务没有步骤数据（steps: []），无法标记为完成。请先调用 steps_update 填充步骤。" };
  }

  const incomplete = steps.filter(
    (s) => s.status !== "completed" && s.status !== "skipped"
  );

  if (incomplete.length > 0) {
    return {
      valid: false,
      reason: `还有 ${incomplete.length} 个步骤未完成: ${incomplete.map((s) => s.id).join(", ")}。请先完成所有步骤。`,
      incompleteStepIds: incomplete.map((s) => s.id),
    };
  }

  return { valid: true };
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
// checkTransitionBlocked
// ============================================================================

/**
 * 检查 task_transition(completed) 是否应该被阻止。
 * 读取 taskDir/status.yaml 的 steps 字段并校验完整性。
 *
 * 返回值：
 * - null：不阻止（steps 完整或 status.yaml 不存在/不可读）
 * - { blockReason: string }：应该阻止，附带原因
 *
 * 设计决策：status.yaml 不存在或不可读时不阻止，
 * 让后续 task_transition 内部的状态机逻辑处理（TASK_NOT_FOUND 等错误）。
 */
export function checkTransitionBlocked(taskDir: string): { blockReason: string } | null {
  try {
    const statusPath = join(taskDir, "status.yaml");
    if (!existsSync(statusPath)) return null;

    const statusContent = readFileSync(statusPath, "utf-8");
    const statusData = YAML.parse(statusContent) ?? {};
    const steps: Step[] = statusData.steps ?? [];
    const validation = validateStepsForCompletion(steps);

    if (!validation.valid) {
      return { blockReason: validation.reason! };
    }
    return null;
  } catch {
    // 读取/解析失败时不阻止，让后续逻辑处理
    return null;
  }
}

// ============================================================================
// readCompletionConfig / checkVerificationBlocked
// ============================================================================

/**
 * 读取 per-agent completion 配置。
 * 返回 requires_verification 的值，默认 true（字段缺失/config 不存在时）。
 */
export function readCompletionConfig(taskDir: string): { requires_verification: boolean } {
  try {
    const configPath = join(taskDir, "config.yaml");
    if (!existsSync(configPath)) return { requires_verification: true };

    const configContent = readFileSync(configPath, "utf-8");
    const configData = YAML.parse(configContent) ?? {};
    const rv = configData?.completion?.requires_verification;
    return { requires_verification: rv === false ? false : true };
  } catch {
    return { requires_verification: true };
  }
}

/**
 * 检查 task_transition(completed) 是否因 verification 未通过而应该被阻止。
 * 与 checkTransitionBlocked 并行，构成完成前置条件的双重检查。
 *
 * 返回值：
 * - null：不阻止（requires_verification=false 或 verification.status=passed）
 * - { blockReason: string }：应该阻止，附带原因和下一步指引
 */
export function checkVerificationBlocked(taskDir: string): { blockReason: string } | null {
  try {
    const config = readCompletionConfig(taskDir);
    if (!config.requires_verification) return null;

    const statusPath = join(taskDir, "status.yaml");
    if (!existsSync(statusPath)) return null;

    const statusContent = readFileSync(statusPath, "utf-8");
    const statusData = YAML.parse(statusContent) ?? {};
    const verifStatus: VerificationStatus = statusData.verification?.status;
    const criteria = statusData.verification?.criteria ?? [];
    const passedCount = criteria.filter((c: { result: string }) => c.result === "passed").length;

    if (verifStatus === "passed") return null;

    if (verifStatus === "failed") {
      return {
        blockReason: `任务验收未通过（status: failed，${passedCount}/${criteria.length} criteria passed）。` +
          `请修正失败项后重新调用 task_verify(finalize)。`,
      };
    }

    // pending 或其他状态
    if (criteria.length === 0) {
      return {
        blockReason: `任务尚未通过验收（status: ${verifStatus ?? "undefined"}，无验收条件）。` +
          `请先调用 task_verify 添加验收条件并 finalize，或设置 completion.requires_verification: false 跳过验收。`,
      };
    }

    return {
      blockReason: `任务尚未通过验收（status: ${verifStatus ?? "undefined"}，${passedCount}/${criteria.length} criteria passed）。` +
        `请先调用 task_verify(finalize) 完成验收流程，或设置 completion.requires_verification: false 跳过验收。`,
    };
  } catch {
    return null;
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

// ============================================================================
// checkVerifyFinalizeBlocked
// ============================================================================

/**
 * 检查 task_verify(finalize) 是否应该被阻止。
 * 当 verification.criteria 为空时，finalize 无意义，应提示用户先添加验收标准。
 *
 * 返回值：
 * - null：不阻止（criteria 非空 或 status.yaml 不存在/不可读）
 * - { blockReason: string }：应该阻止，附带原因和下一步指引
 */
export function checkVerifyFinalizeBlocked(taskDir: string): { blockReason: string } | null {
  try {
    const statusPath = join(taskDir, "status.yaml");
    if (!existsSync(statusPath)) return null;

    const statusContent = readFileSync(statusPath, "utf-8");
    const statusData = YAML.parse(statusContent) ?? {};
    const criteria = statusData.verification?.criteria ?? [];

    if (criteria.length === 0) {
      return {
        blockReason:
          "尚无验收标准，无法 finalize。" +
          "请先调用 task_verify(action: { action: 'add-criterion', criterion: '验收标准描述', result: 'passed'|'failed' }) 添加至少一条验收标准。",
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// suggestVerificationCriteria
// ============================================================================

/**
 * 根据 steps 和已有 criteria，建议尚未被覆盖的验收标准。
 * 匹配策略：检查 step.summary.title 是否作为子串出现在任何 criterion.criterion 中。
 */
export function suggestVerificationCriteria(
  steps: Step[],
  existingCriteria: Array<{ criterion: string }>,
): string[] {
  if (!Array.isArray(steps) || steps.length === 0) return [];

  const suggestions: string[] = [];

  for (const step of steps) {
    if (step.status === "skipped") continue;

    const title = step.summary?.title ?? step.id;

    const isCovered = existingCriteria.some(
      (c) => c.criterion.includes(title) || title.includes(c.criterion),
    );

    if (!isCovered) {
      suggestions.push(`验证步骤 ${step.id}: ${title}`);
    }
  }

  return suggestions;
}
