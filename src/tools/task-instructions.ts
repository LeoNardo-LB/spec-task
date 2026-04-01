import { join } from "path";
import YAML from "yaml";
import type { TaskInstructionsParams, TaskInstructionsResult } from "../types.js";
import { SchemaReader } from "../core/schema-reader.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const TaskInstructionsParamsSchema = {
  type: "object",
  required: ["task_dir", "artifact_id"],
  properties: {
    task_dir: {
      type: "string",
      description: "任务 run 目录的绝对路径（task_create 返回的 task_dir）",
    },
    artifact_id: {
      type: "string",
      description: "要查询指导的构件 ID（如 brief、plan、spec、checklist）",
    },
  },
};

/**
 * task_instructions 工具实现。
 * 等价于 openspec 的 `openspec instructions <artifact-id> --json`。
 *
 * 返回指定构件的完整指导信息：instruction + template + context + rules + dependencies。
 */
export async function executeTaskInstructions(
  _id: string,
  params: TaskInstructionsParams,
): Promise<ToolResponse> {
  const { task_dir, artifact_id } = params;

  // 1. 参数校验
  if (!task_dir || task_dir.trim() === "") {
    return formatError("INVALID_PARAMS", "task_dir must not be empty");
  }
  if (!artifact_id || artifact_id.trim() === "") {
    return formatError("INVALID_PARAMS", "artifact_id must not be empty");
  }

  // 2. 从 task_dir 推断 spec-task 根目录和 schema 路径
  const parts = task_dir.split(/[/\\]/);
  const specTaskIdx = parts.lastIndexOf("spec-task");
  if (specTaskIdx === -1) {
    return formatError("TASK_NOT_FOUND", `Cannot find spec-task directory from task_dir: ${task_dir}`);
  }

  const taskRoot = (() => {
    const runsIdx = parts.lastIndexOf("runs");
    if (runsIdx !== -1 && runsIdx > specTaskIdx) {
      return parts.slice(0, runsIdx).join("/");
    }
    return parts.slice(0, specTaskIdx + 1).join("/") + "/" + parts[specTaskIdx + 1];
  })();

  // 3. 创建 SchemaReader（不传 schemaPath，让 SchemaReader 自动推断 + fallback）
  const reader = new SchemaReader(null, task_dir);

  // 4. 验证 artifact_id 有效
  await reader.parse();
  const validIds = reader.getArtifactIds();
  if (!validIds.includes(artifact_id)) {
    return formatError(
      "INVALID_PARAMS",
      `Unknown artifact_id: "${artifact_id}". Valid IDs: ${validIds.join(", ")}`
    );
  }

  // 5. 读取 steps 数据（如果存在）用于 checklist 状态推断
  const statusPath = join(task_dir, "status.yaml");
  let stepsData: unknown[] | undefined;
  try {
    const statusContent = await import("fs/promises").then(fs => fs.readFile(statusPath, "utf-8"));
    const statusData = YAML.parse(statusContent);
    if (Array.isArray(statusData?.steps)) {
      stepsData = statusData.steps;
    }
  } catch {
    // status.yaml 不存在或无法解析，忽略
  }

  // 6. 获取指导
  const instructions = await reader.getInstructions(artifact_id, taskRoot, stepsData);
  if (!instructions) {
    return formatError("INTERNAL_ERROR", `Failed to get instructions for artifact: ${artifact_id}`);
  }

  // 7. 添加可用构件列表
  const statusResult = await reader.getStatus(taskRoot, stepsData);

  return formatResult({
    success: true,
    artifact_id: instructions.artifact_id,
    instruction: instructions.instruction,
    template: instructions.template,
    context: instructions.context,
    rules: instructions.rules,
    dependencies: instructions.dependencies,
    available_artifacts: validIds,
  } satisfies TaskInstructionsResult);
}
