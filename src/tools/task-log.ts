import type { TaskLogParams, ErrorRecord, AlertRecord, BlockRecord } from "../types.js";
import { SPEC_TASK_ERRORS } from "../types.js";
import { StatusStore } from "../core/status-store.js";
import { resolve } from "path";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const TaskLogParamsSchema = {
  type: "object",
  required: ["task_dir", "action"],
  properties: {
    task_dir: { type: "string", description: "Task directory path (required)" },
    action: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["error", "alert", "add-block", "remove-block", "output", "retry"] },
        step: { type: "string" },
        message: { type: "string" },
        type: { type: "string" },
        task: { type: "string" },
        reason: { type: "string" },
        path: { type: "string" },
      },
    },
  },
};

function typedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * task_log 工具实现。
 * 6 个子命令：error / alert / add-block / remove-block / output / retry。
 * 所有写操作在 transaction 内完成，保证并发安全。
 */
export async function executeTaskLog(
  _id: string,
  params: TaskLogParams,
): Promise<ToolResponse> {
  const { task_dir, action } = params;
  const store = new StatusStore();

  // 锁外预检：任务是否存在
  try {
    await store.loadStatus(task_dir);
  } catch {
    return formatError(SPEC_TASK_ERRORS.TASK_NOT_FOUND, `Task not found at ${task_dir}`);
  }

  try {
    const result = await store.transaction(task_dir, (data) => {
      switch (action.action) {
        // ── error ──────────────────────────────────────────────
        case "error": {
          // 始终追加新记录（等价于 v1.0 log_error 行为）
          const record: ErrorRecord = {
            step: action.step,
            message: action.message,
            retry_count: 0,
            timestamp: new Date().toISOString(),
          };
          data.errors.push(record);
          return { success: true, action: "error", step: action.step, total_errors: data.errors.length };
        }

        // ── alert ──────────────────────────────────────────────
        case "alert": {
          const record: AlertRecord = {
            type: action.type,
            message: action.message,
            timestamp: new Date().toISOString(),
          };
          data.alerts.push(record);
          return { success: true, action: "alert", type: action.type };
        }

        // ── add-block ──────────────────────────────────────────
        case "add-block": {
          if (data.blocked_by.find((b) => b.task === action.task)) {
            throw typedError(
              SPEC_TASK_ERRORS.DUPLICATE_BLOCK,
              `Block for task '${action.task}' already exists`,
            );
          }
          const record: BlockRecord = { task: action.task, reason: action.reason };
          data.blocked_by.push(record);
          return { success: true, action: "add-block", task: action.task };
        }

        // ── remove-block ───────────────────────────────────────
        case "remove-block": {
          const idx = data.blocked_by.findIndex((b) => b.task === action.task);
          if (idx === -1) {
            throw typedError(
              SPEC_TASK_ERRORS.BLOCK_NOT_FOUND,
              `Block for task '${action.task}' not found`,
            );
          }
          data.blocked_by.splice(idx, 1);
          return { success: true, action: "remove-block", task: action.task };
        }

        // ── output ─────────────────────────────────────────────
        case "output": {
          // 解析相对路径为绝对路径（等价于 v1.0 add_output 行为）
          // 如果 path 未提供，自动生成基于时间戳的默认路径
          let outputPath = action.path;
          if (!outputPath) {
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            outputPath = `output-${ts}.md`;
          }
          let resolvedPath = outputPath;
          if (!outputPath.startsWith("/")) {
            resolvedPath = resolve(task_dir, outputPath);
          }
          if (data.outputs.includes(resolvedPath)) {
            throw typedError(
              SPEC_TASK_ERRORS.DUPLICATE_OUTPUT,
              `Output '${outputPath}' already exists`,
            );
          }
          data.outputs.push(resolvedPath);
          return { success: true, action: "output", path: resolvedPath, total_outputs: data.outputs.length };
        }

        // ── retry ──────────────────────────────────────────────
        case "retry": {
          const existing = data.errors.find((e) => e.step === action.step);
          if (!existing) {
            // v1.0 fallback: 无对应 error 时创建新记录
            const record: ErrorRecord = {
              step: action.step,
              message: `Retry initiated for step '${action.step}'`,
              retry_count: 1,
              timestamp: new Date().toISOString(),
            };
            data.errors.push(record);
            return {
              success: true,
              action: "retry",
              step: action.step,
              retry_count: 1,
              created: true,
            };
          }
          existing.retry_count++;
          existing.timestamp = new Date().toISOString();
          return {
            success: true,
            action: "retry",
            step: action.step,
            retry_count: existing.retry_count,
          };
        }
      }
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
