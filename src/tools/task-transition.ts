import type {
  TaskTransitionParams,
  TaskTransitionResult,
  TaskStatusData,
  RevisionType,
} from "../types.js";
import { StatusStore } from "../core/status-store.js";
import { StateMachine } from "../core/state-machine.js";
import { RevisionBuilder } from "../core/revision.js";
import { calculateProgressFromSteps } from "../core/checklist-utils.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const TaskTransitionParamsSchema = {
  type: "object",
  required: ["task_dir", "status"],
  properties: {
    task_dir: { type: "string", description: "Task directory path (required)" },
    status: {
      type: "string",
      enum: ["pending", "assigned", "running", "completed", "failed", "blocked", "cancelled", "revised"],
      description: "Target status (required)",
    },
    revision_type: { type: "string", description: "Revision type (default: 'status_change')" },
    trigger: { type: "string", description: "Who triggered the transition" },
    summary: { type: "string", description: "Transition summary" },
    block_type: { type: "string", enum: ["soft_block", "hard_block"], description: "Block type" },
    block_reason: { type: "string", description: "Block reason" },
    assigned_to: { type: "string", description: "Reassign to agent" },
  },
};

/**
 * task_transition 工具实现。
 * 双重验证：锁外预检 + 锁内重检。running→running 不创建 revision。
 */
export async function executeTaskTransition(
  _id: string,
  params: TaskTransitionParams
): Promise<ToolResponse> {
  const { task_dir, status: newStatus, ...revisionOpts } = params;
  const store = new StatusStore();
  const sm = new StateMachine();
  const rb = new RevisionBuilder();

  // 1. 锁外预检
  let currentData: TaskStatusData;
  try { currentData = await store.loadStatus(task_dir); }
  catch { return formatError("TASK_NOT_FOUND", `Task not found at ${task_dir}`); }

  if (!sm.isValidTransition(currentData.status, newStatus))
    return formatError("INVALID_TRANSITION", `Invalid transition: ${currentData.status} → ${newStatus}`);

  // 2. 锁内执行
  try {
    const txResult = await store.transaction(task_dir, async (data) => {
      if (!sm.isValidTransition(data.status, newStatus))
        throw new Error(`CONCURRENT_INVALID_TRANSITION:${data.status} → ${newStatus}`);

      const oldStatus = data.status;
      data.status = newStatus;

      // 时间戳
      if ((newStatus === "assigned" || newStatus === "running") && !data.started_at)
        data.started_at = new Date().toISOString();
      if (newStatus === "completed" || newStatus === "cancelled")
        data.completed_at = new Date().toISOString();

      // 自动计算 elapsed_minutes
      if ((newStatus === "completed" || newStatus === "cancelled") && data.started_at) {
        const startMs = new Date(data.started_at).getTime();
        const endMs = Date.now();
        data.timing.elapsed_minutes = Math.round((endMs - startMs) / 60000);
      }

      // 从 steps 计算进度
      data.progress = calculateProgressFromSteps(data.steps ?? []);

      // Revision（running→running 跳过）
      let revisionId = -1;
      if (!(oldStatus === "running" && newStatus === "running")) {
        const rev = rb.build({
          data, type: (revisionOpts.revision_type as RevisionType) ?? "status_change",
          trigger: revisionOpts.trigger ?? "agent",
          summary: revisionOpts.summary ?? `${oldStatus} → ${newStatus}`,
          blockType: revisionOpts.block_type, blockReason: revisionOpts.block_reason,
        });
        data.revisions.push(rev);
        revisionId = rev.id;
      }

      if (revisionOpts.assigned_to) data.assigned_to = revisionOpts.assigned_to;
      return { old_status: oldStatus, new_status: newStatus, progress: data.progress, revision_id: revisionId };
    });

    return formatResult({ success: true, ...txResult } satisfies TaskTransitionResult);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("CONCURRENT_INVALID_TRANSITION:"))
      return formatError("INVALID_TRANSITION", `Concurrent modification: ${e.message.slice(37)}`);
    return formatError("INTERNAL_ERROR", e instanceof Error ? e.message : String(e));
  }
}
