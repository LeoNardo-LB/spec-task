import type { TaskVerifyParams, VerificationCriterion } from "../types.js";
import { SPEC_TASK_ERRORS } from "../types.js";
import { StatusStore } from "../core/status-store.js";
import { StateMachine } from "../core/state-machine.js";
import { RevisionBuilder } from "../core/revision.js";
import { calculateProgressFromSteps } from "../core/checklist-utils.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const TaskVerifyParamsSchema = {
  type: "object",
  required: ["task_dir", "action"],
  properties: {
    task_dir: { type: "string", description: "Task directory path (required)" },
    action: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["add-criterion", "finalize", "get"] },
        criterion: { type: "string" },
        result: { type: "string", enum: ["passed", "failed"] },
        evidence: { type: "string" },
        reason: { type: "string" },
        verified_by: { type: "string" },
      },
    },
  },
};

function typedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * task_verify 工具实现。
 * 3 个子命令：get / add-criterion / finalize。
 * get 为只读操作；add-criterion 和 finalize 在 transaction 内完成。
 * finalize 全部通过 + running 状态时自动完成（auto-complete）。
 */
export async function executeTaskVerify(
  _id: string,
  params: TaskVerifyParams,
): Promise<ToolResponse> {
  const { task_dir, action } = params;
  const store = new StatusStore();

  // ── get：只读，无需事务 ─────────────────────────────────────
  if (action.action === "get") {
    try {
      const data = await store.loadStatus(task_dir);
      return formatResult({ success: true, verification: data.verification });
    } catch {
      return formatError(
        SPEC_TASK_ERRORS.TASK_NOT_FOUND,
        `Task not found at ${task_dir}`,
      );
    }
  }

  // ── 锁外预检：任务是否存在 ─────────────────────────────────
  try {
    await store.loadStatus(task_dir);
  } catch {
    return formatError(
      SPEC_TASK_ERRORS.TASK_NOT_FOUND,
      `Task not found at ${task_dir}`,
    );
  }

  // ── add-criterion ──────────────────────────────────────────
  if (action.action === "add-criterion") {
    if (!action.criterion) {
      return formatError(
        "INVALID_PARAMS",
        "criterion is required for add-criterion action",
      );
    }
    if (action.result !== "passed" && action.result !== "failed") {
      return formatError(
        "INVALID_PARAMS",
        "result must be 'passed' or 'failed'",
      );
    }

    try {
      const result = await store.transaction(task_dir, (data) => {
        // 按 criterion 文本查找已有记录并更新
        const existingIdx = data.verification.criteria.findIndex(
          (c) => c.criterion === action.criterion,
        );
        const criterion: VerificationCriterion = {
          criterion: action.criterion,
          result: action.result,
          evidence: action.evidence ?? "",
          reason: action.reason ?? "",
        };
        if (existingIdx !== -1) {
          data.verification.criteria[existingIdx] = criterion;
        } else {
          data.verification.criteria.push(criterion);
        }
        const totalCriteria = data.verification.criteria.length;
        const passed = data.verification.criteria.filter((c) => c.result === "passed").length;
        const failed = data.verification.criteria.filter((c) => c.result === "failed").length;
        return {
          success: true,
          action: "add-criterion",
          criterion: action.criterion,
          result: action.result,
          total_criteria: totalCriteria,
          passed,
          failed,
        };
      });
      return formatResult(result);
    } catch (e) {
      return formatError(
        "INTERNAL_ERROR",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // ── finalize ───────────────────────────────────────────────
  if (action.action === "finalize") {
    try {
      const result = await store.transaction(task_dir, async (data) => {
        if (data.verification.criteria.length === 0) {
          throw typedError(
            SPEC_TASK_ERRORS.NO_CRITERIA,
            "Cannot finalize: no criteria have been added",
          );
        }

        const allPassed = data.verification.criteria.every(
          (c) => c.result === "passed",
        );
        data.verification.status = allPassed ? "passed" : "failed";
        data.verification.verified_at = new Date().toISOString();
        data.verification.verified_by = action.verified_by ?? null;

        let autoCompleted = false;

        // 全部通过 + running 状态 → 自动完成
        if (allPassed && data.status === "running") {
          const sm = new StateMachine();
          const oldStatus = data.status;
          sm.validate(oldStatus, "completed");

          data.status = "completed";
          data.completed_at = new Date().toISOString();

          // 自动计算 elapsed_minutes
          if (data.started_at) {
            const startMs = new Date(data.started_at).getTime();
            const endMs = Date.now();
            data.timing.elapsed_minutes = Math.round((endMs - startMs) / 60000);
          }

          // 从 steps 计算进度
          data.progress = calculateProgressFromSteps(data.steps ?? []);

          const rb = new RevisionBuilder();
          const rev = rb.build({
            data,
            type: "status_change",
            trigger: action.verified_by ?? "verification",
            summary: "Auto-completed: all verification criteria passed",
          });
          data.revisions.push(rev);
          autoCompleted = true;
        }

        return {
          success: true,
          action: "finalize",
          verification_status: data.verification.status,
          auto_completed: autoCompleted,
        };
      });
      return formatResult(result);
    } catch (e) {
      const code =
        e instanceof Error ? (e as unknown as Record<string, unknown>).code : undefined;
      if (typeof code === "string") {
        return formatError(code, e instanceof Error ? e.message : String(e));
      }
      return formatError(
        "INTERNAL_ERROR",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return formatError("INVALID_ACTION", `Unknown action`);
}
