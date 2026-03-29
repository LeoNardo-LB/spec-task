import type { TaskResumeParams, TaskStatusData } from "../types.js";
import { SPEC_TASK_ERRORS } from "../types.js";
import { StatusStore } from "../core/status-store.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const TaskResumeParamsSchema = {
  type: "object",
  required: ["task_dir"],
  properties: {
    task_dir: { type: "string", description: "Task directory path (required)" },
  },
};

/**
 * 根据任务状态数据计算下一步操作建议。
 */
function nextAction(d: TaskStatusData): string {
  switch (d.status) {
    case "pending":
      return "等待分配: 使用 task_transition assigned";
    case "assigned":
      return "等待开始: 使用 task_transition running";
    case "running":
      if (d.errors.length) {
        const e = d.errors.at(-1)!;
        return `修复错误: [${e.step}] ${e.message} (retry#${e.retry_count})`;
      }
      if (d.blocked_by.length) {
        return `阻塞中: ${d.blocked_by.map((b) => b.task).join(", ")}`;
      }
      return d.progress.current_step
        ? `继续执行: 步骤 ${d.progress.current_step} (${d.progress.percentage}%)`
        : "继续执行: 检查 checklist.md";
    case "completed":
      return "已完成: 考虑使用 task_archive 归档";
    case "failed":
      return "需要重试: 使用 task_transition running";
    case "blocked":
      return `等待阻塞解除: ${d.blocked_by.map((b) => `${b.task}(${b.reason})`).join(", ")}`;
    case "cancelled":
      return "已取消: 无法恢复";
    case "revised": {
      // 查找最近的 user_request revision 获取 resume_from（等价于 v1.0）
      const userRevs = d.revisions.filter(
        (r) => r.type === "user_request" && r.resume_from,
      );
      if (userRevs.length > 0) {
        const last = userRevs[userRevs.length - 1];
        return `需要重新规划: 从步骤 ${last.resume_from} 恢复 (${last.summary})`;
      }
      return "需要重新规划: 更新文档后 task_transition running";
    }
  }
}

export async function executeTaskResume(
  _id: string,
  params: TaskResumeParams
): Promise<ToolResponse> {
  const { task_dir } = params;
  const store = new StatusStore();

  let data: TaskStatusData;
  try {
    data = await store.loadStatus(task_dir);
  } catch {
    return formatError(
      SPEC_TASK_ERRORS.TASK_NOT_FOUND,
      `Task not found at ${task_dir}`,
    );
  }

  return formatResult({
    success: true,
    status: data.status,
    next_action: nextAction(data),
    details: {
      task_id: data.task_id,
      title: data.title,
      created: data.created,
      updated: data.updated,
      assigned_to: data.assigned_to,
      started_at: data.started_at,
      completed_at: data.completed_at,
    },
    progress: data.progress,
    outputs: data.outputs,
    children: data.children,
    errors: data.errors,
    alerts: data.alerts,
    blocked_by: data.blocked_by,
    revisions: data.revisions,
  });
}
