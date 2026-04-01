import type { StepsReadParams, StepsReadResult, Step, TaskProgress } from "../types.js";
import { calculateProgressFromSteps, loadStepsFromStatus } from "../core/steps-utils.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const StepsReadParamsSchema = {
  type: "object",
  required: ["task_dir"],
  properties: {
    task_dir: {
      type: "string",
      description: "任务 run 目录的绝对路径（task_create 返回的 task_dir）",
    },
  },
};

/**
 * steps_read 工具实现。
 *
 * 从 status.yaml.steps 读取结构化步骤数据。
 * 如果 steps 不存在或为空，返回错误。
 */
export async function executeStepsRead(
  _id: string,
  params: StepsReadParams,
): Promise<ToolResponse> {
  const { task_dir } = params;

  // 1. 参数校验
  if (!task_dir || task_dir.trim() === "") {
    return formatError("INVALID_PARAMS", "task_dir must not be empty");
  }

  // 2. 从 status.yaml.steps 读取
  const steps = loadStepsFromStatus(task_dir);

  // 3. 不存在或为空
  if (!steps || steps.length === 0) {
    return formatError("STEPS_NOT_FOUND", `No steps found in status.yaml at ${task_dir}`);
  }

  // 4. 计算进度
  const progress: TaskProgress = calculateProgressFromSteps(steps);

  return formatResult({
    success: true,
    steps,
    progress,
    task_dir,
  } satisfies StepsReadResult);
}
