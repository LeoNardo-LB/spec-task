import type { StepsUpdateParams, StepsUpdateResult, Step, TaskProgress } from "../types.js";
import { calculateProgressFromSteps, syncStepsToStatus, loadStepsFromStatus } from "../core/steps-utils.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const StepsUpdateParamsSchema = {
  type: "object",
  required: ["task_dir", "steps"],
  properties: {
    task_dir: {
      type: "string",
      description: "任务 run 目录的绝对路径（task_create 返回的 task_dir）",
    },
    steps: {
      type: "array",
      description: "完整的步骤数组，全量替换 status.yaml 中的 steps。每个步骤必须提供自包含的执行上下文（无需回头翻 brief/plan）。",
      items: {
        type: "object",
        required: ["id", "summary", "status"],
        properties: {
          id: { type: "string", description: "步骤编号，如 '1.1', '2.3'。按顶级编号分组表示阶段。" },
          summary: {
            type: "object",
            required: ["title", "content", "approach", "sources"],
            description: "步骤摘要——提供自包含的执行上下文",
            properties: {
              title: {
                type: "string",
                description: "步骤标题。要求：动宾结构 + 具体对象，说明步骤作用。示例：'在 run-utils.ts 中实现 getNextRunId() 目录编号分配'。禁止笼统如 '实现工具'。",
              },
              content: {
                type: "string",
                description: "步骤内容。要求包含：① 做什么（目标）② 关键参数/输入 ③ 实现思路概述 ④ 验证方式。应引用具体文件路径和函数名。示例：'在 src/core/ 新建 run-utils.ts，实现 getNextRunId(taskDir) 扫描 runs/ 子目录获取下一个递增编号。使用 fs.readdir + 正则 /^\\d{3}$/ 过滤。完成后运行 npm test 验证。'",
              },
              approach: {
                type: "string",
                description: "实施方式。要求具体技术策略，包含工具/库/算法选择。示例：'fs.readdir 扫描 → 过滤 \\d{3} 目录名 → Math.max(...ids) + 1 → padStart(3, \"0\")'",
              },
              sources: {
                type: "array",
                items: { type: "string" },
                description: "信息来源引用（必须填写）。格式：'文件名.md#标题文本'（标题文本必须与文档中 ## 后的内容完全一致）。引用 brief.md 或 plan.md 中的章节。每步至少引用 1 个来源。示例：[\"brief.md#Scope\", \"plan.md#Steps Overview\"]（如文档用中文标题则为 [\"brief.md#范围\", \"plan.md#步骤概览\"]）",
              },
            },
          },
          status: { type: "string", enum: ["pending", "completed", "skipped"] },
          tags: { type: "array", items: { type: "string" }, description: "步骤标签，如 ['core', 'testing']" },
        },
      },
    },
  },
};

/**
 * steps_update 工具实现。
 *
 * 接收结构化 Step[] 数组，全量替换 status.yaml 中的 steps。
 * 保留已有步骤的 completed_at 时间戳。
 */
export async function executeStepsUpdate(
  _id: string,
  params: StepsUpdateParams,
): Promise<ToolResponse> {
  const { task_dir, steps } = params;

  // 1. 参数校验
  if (!task_dir || task_dir.trim() === "") {
    return formatError("INVALID_PARAMS", "task_dir must not be empty");
  }
  if (!steps || !Array.isArray(steps)) {
    return formatError("INVALID_PARAMS", "steps must be a non-empty array");
  }

  // 2. 读取已有步骤（保留 completed_at）
  const existingSteps = loadStepsFromStatus(task_dir);
  const existingMap = new Map<string, Step>();
  if (existingSteps) {
    for (const s of existingSteps) {
      existingMap.set(s.id, s);
    }
  }

  // 3. 合并：为新步骤填充 completed_at
  // Use "completed_at" in step to distinguish "not provided" (undefined) from
  // "explicitly set to null" (user wants to reset the timestamp).
  const now = new Date().toISOString();
  const mergedSteps: Step[] = steps.map((rawStep) => {
    const step = rawStep as unknown as Record<string, unknown>;
    const existing = existingMap.get(rawStep.id);
    const hasCompletedAt = "completed_at" in step;
    const completedAtValue = hasCompletedAt ? (step.completed_at as string | null) : undefined;

    // User explicitly provided a non-null completed_at → use it directly
    if (completedAtValue) {
      return rawStep;
    }

    // completed_at not provided, step is completed/skipped → preserve from existing
    if (!hasCompletedAt && rawStep.status !== "pending" && existing?.completed_at) {
      return { ...rawStep, completed_at: existing.completed_at };
    }

    // Completed/skipped step without completed_at → set new timestamp
    if ((rawStep.status === "completed" || rawStep.status === "skipped") && !completedAtValue) {
      return { ...rawStep, completed_at: now };
    }

    // Default: pending or explicitly null → null
    return { ...rawStep, completed_at: null };
  });

  // 4. 同步到 status.yaml
  syncStepsToStatus(task_dir, mergedSteps);

  // 5. 计算进度
  const progress: TaskProgress = calculateProgressFromSteps(mergedSteps);

  // 6. 判断所有步骤是否完成，提供后续操作建议
  const allCompleted = progress.total > 0 && progress.completed + progress.skipped === progress.total;

  return formatResult({
    success: true,
    task_dir,
    progress,
    all_steps_completed: allCompleted,
    suggested_action: allCompleted ? "task_verify" : undefined,
    next_action_hint: allCompleted
      ? "✅ 所有步骤已完成。请调用 task_verify 添加验收标准并 finalize，然后 task_transition({ status: \"completed\" }) 完成任务。"
      : undefined,
  } satisfies StepsUpdateResult);
}
