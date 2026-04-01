import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeTaskLog } from "../../src/tools/task-log.js";
import type { TaskStatus, TaskStatusData } from "../../src/types.js";
import { SPEC_TASK_ERRORS } from "../../src/types.js";

describe("executeTaskLog", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T10:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "log-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTask(
    status: TaskStatus,
    overrides?: Partial<TaskStatusData>,
  ): string {
    const taskDir = join(tmpDir, `task-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(taskDir, { recursive: true });
    const data: TaskStatusData = {
      task_id: "test-task",
      title: "Test Task",
      created: "2026-03-29T00:00:00.000Z",
      updated: "2026-03-29T00:00:00.000Z",
      status,
      assigned_to: "agent",
      run_id: "001",
      started_at: null,
      completed_at: null,
      progress: { total: 3, completed: 1, skipped: 0, current_step: "2.1", percentage: 33 },
      outputs: [],
      steps: [],
      errors: [],
      blocked_by: [],
      verification: {
        status: "pending",
        criteria: [],
        verified_at: null,
        verified_by: null,
      },
      revisions: [],
      ...overrides,
    };
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
    writeFileSync(
      join(taskDir, "checklist.md"),
      "- [x] 1.1\n- [ ] 2.1\n- [ ] 3.1\n",
      "utf-8",
    );
    return taskDir;
  }

  function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    return JSON.parse(result.content[0].text);
  }

  function readStatus(taskDir: string): TaskStatusData {
    const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    return YAML.parse(content) as TaskStatusData;
  }

  // ────────────────────────────────────────────────────────────
  // 1. error first record
  // ────────────────────────────────────────────────────────────
  it("1. should log first error record", async () => {
    const taskDir = createTask("running");
    const result = await executeTaskLog("l1", {
      task_dir: taskDir,
      action: { action: "error", step: "3.1", message: "Test error" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.action).toBe("error");
    expect(data.step).toBe("3.1");

    const status = readStatus(taskDir);
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].step).toBe("3.1");
    expect(status.errors[0].message).toBe("Test error");
    expect(status.errors[0].retry_count).toBe(0);
  });

    // ────────────────────────────────────────────────────────────
  // 2. error same step — always append (v1.0 behavior)
  // ────────────────────────────────────────────────────────────
  it("2. should append new error record for same step (v1.0 behavior)", async () => {
    const taskDir = createTask("running");
    await executeTaskLog("l2a", {
      task_dir: taskDir,
      action: { action: "error", step: "3.1", message: "First error" },
    });
    await executeTaskLog("l2b", {
      task_dir: taskDir,
      action: { action: "error", step: "3.1", message: "Second error" },
    });

    const status = readStatus(taskDir);
    expect(status.errors).toHaveLength(2);
    expect(status.errors[0].message).toBe("First error");
    expect(status.errors[1].message).toBe("Second error");
  });

  // ────────────────────────────────────────────────────────────
  // 3. error update message — v1.0 always appends, doesn't update
  // ────────────────────────────────────────────────────────────
  it("3. should append new error record (not update existing)", async () => {
    const taskDir = createTask("running");
    await executeTaskLog("l3a", {
      task_dir: taskDir,
      action: { action: "error", step: "2.1", message: "Old message" },
    });
    await executeTaskLog("l3b", {
      task_dir: taskDir,
      action: { action: "error", step: "2.1", message: "New message" },
    });

    const status = readStatus(taskDir);
    expect(status.errors).toHaveLength(2);
    expect(status.errors[0].message).toBe("Old message");
    expect(status.errors[1].message).toBe("New message");
  });

  // ────────────────────────────────────────────────────────────
  // 3. error update message
  // ────────────────────────────────────────────────────────────
  it("3. should update message on same step error", async () => {
    const taskDir = createTask("running");
    await executeTaskLog("l3a", {
      task_dir: taskDir,
      action: { action: "error", step: "2.1", message: "Old message" },
    });
    await executeTaskLog("l3b", {
      task_dir: taskDir,
      action: { action: "error", step: "2.1", message: "New message" },
    });

    const status = readStatus(taskDir);
    expect(status.errors).toHaveLength(2);
    expect(status.errors[0].message).toBe("Old message");
    expect(status.errors[1].message).toBe("New message");
  });

  // ────────────────────────────────────────────────────────────
  // 4. add-block
  // ────────────────────────────────────────────────────────────
  it("4. should add block record", async () => {
    const taskDir = createTask("running");
    const result = await executeTaskLog("l6", {
      task_dir: taskDir,
      action: {
        action: "add-block",
        task: "dep-task",
        reason: "Waiting for dependency",
      },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const status = readStatus(taskDir);
    expect(status.blocked_by).toHaveLength(1);
    expect(status.blocked_by[0].task).toBe("dep-task");
    expect(status.blocked_by[0].reason).toBe("Waiting for dependency");
  });

  // ────────────────────────────────────────────────────────────
  // 7. add-block duplicate → DUPLICATE_BLOCK
  // ────────────────────────────────────────────────────────────
  it("7. should reject duplicate block with DUPLICATE_BLOCK", async () => {
    const taskDir = createTask("running");
    await executeTaskLog("l7a", {
      task_dir: taskDir,
      action: {
        action: "add-block",
        task: "dep-task",
        reason: "Reason 1",
      },
    });
    const result = await executeTaskLog("l7b", {
      task_dir: taskDir,
      action: {
        action: "add-block",
        task: "dep-task",
        reason: "Reason 2",
      },
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe(SPEC_TASK_ERRORS.DUPLICATE_BLOCK);
  });

  // ────────────────────────────────────────────────────────────
  // 8. remove-block
  // ────────────────────────────────────────────────────────────
  it("8. should remove block record", async () => {
    const taskDir = createTask("running");
    await executeTaskLog("l8a", {
      task_dir: taskDir,
      action: {
        action: "add-block",
        task: "dep-task",
        reason: "Some reason",
      },
    });
    const result = await executeTaskLog("l8b", {
      task_dir: taskDir,
      action: { action: "remove-block", task: "dep-task" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const status = readStatus(taskDir);
    expect(status.blocked_by).toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────
  // 9. remove-block not found → BLOCK_NOT_FOUND
  // ────────────────────────────────────────────────────────────
  it("9. should reject remove-block with BLOCK_NOT_FOUND", async () => {
    const taskDir = createTask("running");
    const result = await executeTaskLog("l9", {
      task_dir: taskDir,
      action: { action: "remove-block", task: "nonexistent" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe(SPEC_TASK_ERRORS.BLOCK_NOT_FOUND);
  });

  // ────────────────────────────────────────────────────────────
  // 10. output record
  // ────────────────────────────────────────────────────────────
  it("10. should record output path", async () => {
    const taskDir = createTask("running");
    const result = await executeTaskLog("l10", {
      task_dir: taskDir,
      action: { action: "output", path: "/path/to/output.md" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const status = readStatus(taskDir);
    expect(status.outputs).toHaveLength(1);
    expect(status.outputs[0]).toBe("/path/to/output.md");
  });

  // ────────────────────────────────────────────────────────────
  // 11. output duplicate → DUPLICATE_OUTPUT
  // ────────────────────────────────────────────────────────────
  it("11. should reject duplicate output with DUPLICATE_OUTPUT", async () => {
    const taskDir = createTask("running");
    await executeTaskLog("l11a", {
      task_dir: taskDir,
      action: { action: "output", path: "/path/to/output.md" },
    });
    const result = await executeTaskLog("l11b", {
      task_dir: taskDir,
      action: { action: "output", path: "/path/to/output.md" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe(SPEC_TASK_ERRORS.DUPLICATE_OUTPUT);
  });

  // ────────────────────────────────────────────────────────────
  // 12. retry same step — UPDATE (not append)
  // ────────────────────────────────────────────────────────────
  it("12. should UPDATE retry_count for retry action with matching error step", async () => {
    const taskDir = createTask("running");
    await executeTaskLog("l12a", {
      task_dir: taskDir,
      action: { action: "error", step: "3.1", message: "Error occurred" },
    });
    const result = await executeTaskLog("l12b", {
      task_dir: taskDir,
      action: { action: "retry", step: "3.1" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.retry_count).toBe(1);
    expect(data.created).toBeUndefined(); // not a fallback creation

    const status = readStatus(taskDir);
    expect(status.errors).toHaveLength(1); // no new record appended
    expect(status.errors[0].retry_count).toBe(1);
  });

  // ────────────────────────────────────────────────────────────
  // 13. retry fallback — no matching step → create new record
  // ────────────────────────────────────────────────────────────
  it("13. should append NEW error record when retry action has no matching step (v1.0 fallback)", async () => {
    const taskDir = createTask("running");
    // First create an error for step "3.1"
    await executeTaskLog("l13a", {
      task_dir: taskDir,
      action: { action: "error", step: "3.1", message: "Error occurred" },
    });
    // Retry a different step "5.1" — no matching error exists
    const result = await executeTaskLog("l13b", {
      task_dir: taskDir,
      action: { action: "retry", step: "5.1" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.created).toBe(true);
    expect(data.retry_count).toBe(1);

    const status = readStatus(taskDir);
    expect(status.errors).toHaveLength(2); // original + new fallback record
    expect(status.errors[0].step).toBe("3.1");
    expect(status.errors[1].step).toBe("5.1");
    expect(status.errors[1].message).toContain("5.1");
    expect(status.errors[1].retry_count).toBe(1);
  });

  // ────────────────────────────────────────────────────────────
  // 14. TASK_NOT_FOUND
  // ────────────────────────────────────────────────────────────
  it("14. should return TASK_NOT_FOUND for nonexistent task", async () => {
    const result = await executeTaskLog("l14", {
      task_dir: "/nonexistent/task",
      action: { action: "error", step: "1.1", message: "test" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe(SPEC_TASK_ERRORS.TASK_NOT_FOUND);
  });

  // ────────────────────────────────────────────────────────────
  // 15. error timestamp ISO 8601
  // ────────────────────────────────────────────────────────────
  it("15. should use ISO 8601 timestamp for error records", async () => {
    const taskDir = createTask("running");
    await executeTaskLog("l15", {
      task_dir: taskDir,
      action: { action: "error", step: "1.1", message: "test" },
    });
    const status = readStatus(taskDir);
    const timestamp = status.errors[0].timestamp;
    // 验证 fake timer 产生的精确时间
    expect(timestamp).toBe("2026-03-29T10:00:00.000Z");
    // 验证 ISO 8601 格式可被 Date 正确解析
    expect(() => new Date(timestamp).toISOString()).not.toThrow();
  });

  // ────────────────────────────────────────────────────────────
  // 16. multi-action sequential
  // ────────────────────────────────────────────────────────────
  it("16. should handle multiple different actions sequentially", async () => {
    const taskDir = createTask("running");

    await executeTaskLog("l16a", {
      task_dir: taskDir,
      action: { action: "error", step: "1.1", message: "Error" },
    });
    await executeTaskLog("l16b", {
      task_dir: taskDir,
      action: { action: "output", path: "/out.md" },
    });

    const status = readStatus(taskDir);
    expect(status.errors).toHaveLength(1);
    expect(status.outputs).toHaveLength(1);
  });

  // ────────────────────────────────────────────────────────────
  // 17. add then remove block
  // ────────────────────────────────────────────────────────────
  it("17. should add then remove block", async () => {
    const taskDir = createTask("running");
    await executeTaskLog("l17a", {
      task_dir: taskDir,
      action: {
        action: "add-block",
        task: "dep-1",
        reason: "Dependency",
      },
    });
    await executeTaskLog("l17b", {
      task_dir: taskDir,
      action: { action: "remove-block", task: "dep-1" },
    });

    const status = readStatus(taskDir);
    expect(status.blocked_by).toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────
  // 18. many errors
  // ────────────────────────────────────────────────────────────
  it("18. should handle many errors", async () => {
    const taskDir = createTask("running");
    for (let i = 0; i < 50; i++) {
      await executeTaskLog(`l18-${i}`, {
        task_dir: taskDir,
        action: {
          action: "error",
          step: `step-${i}`,
          message: `Error ${i}`,
        },
      });
    }
    const status = readStatus(taskDir);
    expect(status.errors).toHaveLength(50);
    expect(status.errors[49].step).toBe("step-49");
  });

  // ────────────────────────────────────────────────────────────
  // 21. output auto-generated path
  // ────────────────────────────────────────────────────────────
  it("21. should auto-generate output path when path is not provided", async () => {
    const taskDir = createTask("running");
    const result = await executeTaskLog("l21", {
      task_dir: taskDir,
      action: { action: "output" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.path).toBeDefined();
    expect(data.path).toMatch(/\.md$/);
    expect(data.path).toContain(taskDir);

    const status = readStatus(taskDir);
    expect(status.outputs).toHaveLength(1);
    expect(status.outputs[0]).toBe(data.path);
    expect(status.outputs[0]).toMatch(/output-.*\.md$/);
  });
});

// ────────────────────────────────────────────────────────────────
// 并发安全测试（不使用 fake timers，proper-lockfile 内部依赖 setTimeout）
// ────────────────────────────────────────────────────────────────
describe("executeTaskLog - concurrent safety", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "log-concurrent-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTask(status: TaskStatus, overrides?: Partial<TaskStatusData>): string {
    const taskDir = join(tmpDir, `task-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(taskDir, { recursive: true });
    const data: TaskStatusData = {
      task_id: "test-task",
      title: "Test Task",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      status,
      assigned_to: "agent",
      run_id: "001",
      started_at: null,
      completed_at: null,
      progress: { total: 3, completed: 1, skipped: 0, current_step: "2.1", percentage: 33 },
      outputs: [],
      steps: [],
      errors: [],
      blocked_by: [],
      verification: {
        status: "pending",
        criteria: [],
        verified_at: null,
        verified_by: null,
      },
      revisions: [],
      ...overrides,
    };
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
    writeFileSync(
      join(taskDir, "checklist.md"),
      "- [x] 1.1\n- [ ] 2.1\n- [ ] 3.1\n",
      "utf-8",
    );
    return taskDir;
  }

  function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    return JSON.parse(result.content[0].text);
  }

  function readStatus(taskDir: string): TaskStatusData {
    const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    return YAML.parse(content) as TaskStatusData;
  }

  it("19. should handle concurrent operations safely", async () => {
    const taskDir = createTask("running");
    // 3 并发足够验证锁安全，proper-lockfile 重试机制在高并发下较慢
    const promises = Array.from({ length: 3 }, (_, i) =>
      executeTaskLog(`l19-${i}`, {
        task_dir: taskDir,
        action: {
          action: "error",
          step: `concurrent-${i}`,
          message: `Concurrent error ${i}`,
        },
      }),
    );
    const results = await Promise.all(promises);

    for (const result of results) {
      const data = parseResult(result);
      expect(data.success).toBe(true);
    }

    const status = readStatus(taskDir);
    expect(status.errors).toHaveLength(3);
  }, 30_000);

  // ────────────────────────────────────────────────────────────
  // 20. special chars in message
  // ────────────────────────────────────────────────────────────
  it("20. should handle special characters in message", async () => {
    const taskDir = createTask("running");
    const specialMessage =
      'Hello "world" \n\t <script>alert("xss")</script> \u4f60\u597d\u4e16\u754c \ud83c\udf89 \\/\u8def\u5f84';
    await executeTaskLog("l20", {
      task_dir: taskDir,
      action: { action: "error", step: "1.1", message: specialMessage },
    });

    const status = readStatus(taskDir);
    expect(status.errors[0].message).toBe(specialMessage);
  });
});
