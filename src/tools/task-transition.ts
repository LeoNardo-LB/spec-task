import type {
  TaskTransitionParams,
  TaskTransitionResult,
  TaskStatusData,
  RevisionType,
} from "../types.js";
import { StatusStore } from "../core/status-store.js";
import { StateMachine } from "../core/state-machine.js";
import { RevisionBuilder } from "../core/revision.js";
import { calculateProgressFromSteps, readCompletionConfig } from "../core/steps-utils.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";
import { VALID_TRANSITIONS } from "../types.js";

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

  if (!sm.isValidTransition(currentData.status, newStatus)) {
    try {
      sm.validate(currentData.status, newStatus);
    } catch (e) {
      return formatError("INVALID_TRANSITION", e instanceof Error ? e.message : String(e));
    }
    return formatError("INVALID_TRANSITION", `Invalid transition: ${currentData.status} → ${newStatus}`);
  }

  // 2. 锁内执行
  try {
    const txResult = await store.transaction(task_dir, async (data) => {
      if (!sm.isValidTransition(data.status, newStatus))
        throw new Error(`CONCURRENT_INVALID_TRANSITION:${data.status} → ${newStatus}`);

      // 兜底校验：completed 前检查 verification 状态
      if (newStatus === "completed") {
        const completionConfig = readCompletionConfig(task_dir);
        if (completionConfig.requires_verification !== false) {
          const verifStatus = data.verification?.status;
          if (verifStatus !== "passed") {
            const criteria = data.verification?.criteria ?? [];
            const passedCount = criteria.filter((c: { result: string }) => c.result === "passed").length;
            throw new Error(
              `Cannot complete task: verification status is '${verifStatus ?? "undefined"}'. ` +
              `Call task_verify(finalize) first. ` +
              `Current verification: ${criteria.length} criteria, ${passedCount} passed.`,
            );
          }
        }
      }

      const oldStatus = data.status;
      data.status = newStatus;

      // 时间戳
      if ((newStatus === "assigned" || newStatus === "running") && !data.started_at)
        data.started_at = new Date().toISOString();
      if (newStatus === "completed" || newStatus === "cancelled")
        data.completed_at = new Date().toISOString();

      // 从 steps 计算进度
      data.progress = calculateProgressFromSteps(data.steps ?? []);

      // Revision（running→running 跳过）
      let revisionId = -1;
      if (!(oldStatus === "running" && newStatus === "running")) {
        const rev = rb.build({
          data, type: (revisionOpts.revision_type as RevisionType) ?? "status_change",
          trigger: revisionOpts.trigger ?? "agent",
          summary: revisionOpts.summary ?? `${oldStatus} → ${newStatus}`,
        });
        data.revisions.push(rev);
        revisionId = rev.id;
      }

      if (revisionOpts.assigned_to) data.assigned_to = revisionOpts.assigned_to;
      return { old_status: oldStatus, new_status: newStatus, progress: data.progress, revision_id: revisionId };
    });

    return formatResult({ success: true, ...txResult } satisfies TaskTransitionResult);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("CONCURRENT_INVALID_TRANSITION:")) {
      const concurrentFrom = e.message.slice(37).split(" → ")[0];
      const allowed = (VALID_TRANSITIONS as Record<string, string[]>)[concurrentFrom];
      const allowedList = allowed ? allowed.join(", ") : "none";
      return formatError(
        "INVALID_TRANSITION",
        `Concurrent modification: task status changed to ${concurrentFrom}. Allowed transitions: [${allowedList}]`,
      );
    }
    return formatError("INTERNAL_ERROR", e instanceof Error ? e.message : String(e));
  }
}
