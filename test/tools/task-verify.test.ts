import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeTaskVerify } from "../../src/tools/task-verify.js";
import type { TaskStatus, TaskStatusData } from "../../src/types.js";
import { SPEC_TASK_ERRORS } from "../../src/types.js";

describe("executeTaskVerify", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T10:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "verify-test-"));
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
      started_at: status === "running" ? "2026-03-29T08:00:00.000Z" : null,
      completed_at: null,
      progress: { total: 3, completed: 1, skipped: 0, current_step: "2.1", percentage: 33 },
      children: [],
      outputs: [],
      steps: [],
      timing: { elapsed_minutes: null },
      errors: [],
      alerts: [],
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
  // 1. add-criterion passed
  // ────────────────────────────────────────────────────────────
  it("1. should add passed criterion", async () => {
    const taskDir = createTask("running");
    const result = await executeTaskVerify("v1", {
      task_dir: taskDir,
      action: {
        action: "add-criterion",
        criterion: "All tests pass",
        result: "passed",
      },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.result).toBe("passed");

    const status = readStatus(taskDir);
    expect(status.verification.criteria).toHaveLength(1);
    expect(status.verification.criteria[0].criterion).toBe("All tests pass");
    expect(status.verification.criteria[0].result).toBe("passed");
  });

  // ────────────────────────────────────────────────────────────
  // 2. add-criterion failed
  // ────────────────────────────────────────────────────────────
  it("2. should add failed criterion", async () => {
    const taskDir = createTask("running");
    const result = await executeTaskVerify("v2", {
      task_dir: taskDir,
      action: {
        action: "add-criterion",
        criterion: "Performance check",
        result: "failed",
      },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const status = readStatus(taskDir);
    expect(status.verification.criteria[0].result).toBe("failed");
  });

  // ────────────────────────────────────────────────────────────
  // 3. add-criterion multiple
  // ────────────────────────────────────────────────────────────
  it("3. should add multiple criteria", async () => {
    const taskDir = createTask("running");
    await executeTaskVerify("v3a", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test 1", result: "passed" },
    });
    await executeTaskVerify("v3b", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test 2", result: "passed" },
    });
    await executeTaskVerify("v3c", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test 3", result: "failed" },
    });

    const status = readStatus(taskDir);
    expect(status.verification.criteria).toHaveLength(3);
    expect(status.verification.criteria[0].criterion).toBe("Test 1");
    expect(status.verification.criteria[1].criterion).toBe("Test 2");
    expect(status.verification.criteria[2].criterion).toBe("Test 3");
  });

  // ────────────────────────────────────────────────────────────
  // 4. evidence/reason optional defaults
  // ────────────────────────────────────────────────────────────
  it("4. should default evidence and reason to empty strings", async () => {
    const taskDir = createTask("running");
    await executeTaskVerify("v4", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test", result: "passed" },
    });

    const status = readStatus(taskDir);
    expect(status.verification.criteria[0].evidence).toBe("");
    expect(status.verification.criteria[0].reason).toBe("");
  });

  // ────────────────────────────────────────────────────────────
  // 5. get returns verification
  // ────────────────────────────────────────────────────────────
  it("5. should return verification status on get", async () => {
    const taskDir = createTask("running", {
      verification: {
        status: "pending",
        criteria: [
          {
            criterion: "Test",
            result: "passed",
            evidence: "logs",
            reason: "",
          },
        ],
        verified_at: null,
        verified_by: null,
      },
    });
    const result = await executeTaskVerify("v5", {
      task_dir: taskDir,
      action: { action: "get" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.verification.status).toBe("pending");
    expect(data.verification.criteria).toHaveLength(1);
    expect(data.verification.criteria[0].criterion).toBe("Test");
    expect(data.verification.criteria[0].evidence).toBe("logs");
  });

  // ────────────────────────────────────────────────────────────
  // 6. get TASK_NOT_FOUND
  // ────────────────────────────────────────────────────────────
  it("6. should return TASK_NOT_FOUND for get on nonexistent task", async () => {
    const result = await executeTaskVerify("v6", {
      task_dir: "/nonexistent/task",
      action: { action: "get" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe(SPEC_TASK_ERRORS.TASK_NOT_FOUND);
  });

  // ────────────────────────────────────────────────────────────
  // 7. finalize all passed
  // ────────────────────────────────────────────────────────────
  it("7. should finalize with all criteria passed", async () => {
    const taskDir = createTask("pending");
    await executeTaskVerify("v7a", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test 1", result: "passed" },
    });
    await executeTaskVerify("v7b", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test 2", result: "passed" },
    });
    const result = await executeTaskVerify("v7c", {
      task_dir: taskDir,
      action: { action: "finalize" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.verification_status).toBe("passed");

    const status = readStatus(taskDir);
    expect(status.verification.status).toBe("passed");
  });

  // ────────────────────────────────────────────────────────────
  // 8. finalize has failed
  // ────────────────────────────────────────────────────────────
  it("8. should finalize with failed criteria", async () => {
    const taskDir = createTask("running");
    await executeTaskVerify("v8a", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test 1", result: "passed" },
    });
    await executeTaskVerify("v8b", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test 2", result: "failed" },
    });
    const result = await executeTaskVerify("v8c", {
      task_dir: taskDir,
      action: { action: "finalize" },
    });
    const data = parseResult(result);
    expect(data.verification_status).toBe("failed");

    const status = readStatus(taskDir);
    expect(status.verification.status).toBe("failed");
    // 有失败项 → 不触发自动完成，状态不变
    expect(status.status).toBe("running");
  });

  // ────────────────────────────────────────────────────────────
  // 9. finalize empty → NO_CRITERIA
  // ────────────────────────────────────────────────────────────
  it("9. should reject finalize with no criteria (NO_CRITERIA)", async () => {
    const taskDir = createTask("running");
    const result = await executeTaskVerify("v9", {
      task_dir: taskDir,
      action: { action: "finalize" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe(SPEC_TASK_ERRORS.NO_CRITERIA);
  });

  // ────────────────────────────────────────────────────────────
  // 10. finalize all passed + running → auto completed
  // ────────────────────────────────────────────────────────────
  it("10. should auto-complete when all passed and status is running", async () => {
    const taskDir = createTask("running");
    await executeTaskVerify("v10a", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test 1", result: "passed" },
    });
    const result = await executeTaskVerify("v10b", {
      task_dir: taskDir,
      action: { action: "finalize" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.auto_completed).toBe(true);

    const status = readStatus(taskDir);
    expect(status.status).toBe("completed");
    expect(status.completed_at).toBe("2026-03-29T10:00:00.000Z");
  });

  // ────────────────────────────────────────────────────────────
  // 11. finalize all passed + non-running → no auto
  // ────────────────────────────────────────────────────────────
  it("11. should not auto-complete when all passed but status is not running", async () => {
    const taskDir = createTask("pending");
    await executeTaskVerify("v11a", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test 1", result: "passed" },
    });
    const result = await executeTaskVerify("v11b", {
      task_dir: taskDir,
      action: { action: "finalize" },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.auto_completed).toBe(false);

    const status = readStatus(taskDir);
    expect(status.status).toBe("pending");
    expect(status.completed_at).toBeNull();
  });

  // ────────────────────────────────────────────────────────────
  // 12. finalize sets verified_at/by
  // ────────────────────────────────────────────────────────────
  it("12. should set verified_at and verified_by on finalize", async () => {
    const taskDir = createTask("pending");
    await executeTaskVerify("v12a", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test", result: "passed" },
    });
    await executeTaskVerify("v12b", {
      task_dir: taskDir,
      action: { action: "finalize", verified_by: "agent-001" },
    });

    const status = readStatus(taskDir);
    expect(status.verification.verified_at).toBe("2026-03-29T10:00:00.000Z");
    expect(status.verification.verified_by).toBe("agent-001");
  });

  // ────────────────────────────────────────────────────────────
  // 13. finalize auto-complete creates revision
  // ────────────────────────────────────────────────────────────
  it("13. should create revision on auto-complete", async () => {
    const taskDir = createTask("running");
    await executeTaskVerify("v13a", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Test", result: "passed" },
    });
    await executeTaskVerify("v13b", {
      task_dir: taskDir,
      action: { action: "finalize", verified_by: "agent-001" },
    });

    const status = readStatus(taskDir);
    expect(status.revisions.length).toBeGreaterThanOrEqual(1);
    const rev = status.revisions[status.revisions.length - 1];
    expect(rev.type).toBe("status_change");
    expect(rev.trigger).toBe("agent-001");
    expect(rev.summary).toContain("Auto-completed");
  });

  // ────────────────────────────────────────────────────────────
  // 14. criterion required
  // ────────────────────────────────────────────────────────────
  it("14. should reject add-criterion without criterion (INVALID_PARAMS)", async () => {
    const taskDir = createTask("running");
    const result = await executeTaskVerify("v14", {
      task_dir: taskDir,
      action: {
        action: "add-criterion",
        criterion: "",
        result: "passed",
      } as any,
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
    expect(data.message).toContain("criterion");
  });

  // ────────────────────────────────────────────────────────────
  // 15. result must be passed/failed
  // ────────────────────────────────────────────────────────────
  it("15. should reject add-criterion with invalid result (INVALID_PARAMS)", async () => {
    const taskDir = createTask("running");
    const result = await executeTaskVerify("v15", {
      task_dir: taskDir,
      action: {
        action: "add-criterion",
        criterion: "Test",
        result: "invalid" as any,
      },
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
    expect(data.message).toContain("result");
  });

  // ────────────────────────────────────────────────────────────
  // 17. finalize idempotent on terminal state
  // ────────────────────────────────────────────────────────────
  it("17. should allow repeated finalize on already completed task without error (idempotent)", async () => {
    const taskDir = createTask("running");
    // Add a passed criterion and finalize (auto-completes)
    await executeTaskVerify("v17a", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "All tests pass", result: "passed" },
    });
    const firstResult = await executeTaskVerify("v17b", {
      task_dir: taskDir,
      action: { action: "finalize" },
    });
    const firstData = parseResult(firstResult);
    expect(firstData.success).toBe(true);
    expect(firstData.auto_completed).toBe(true);
    expect(firstData.verification_status).toBe("passed");

    // Verify task is now completed
    const afterFirst = readStatus(taskDir);
    expect(afterFirst.status).toBe("completed");

    // Finalize AGAIN — should succeed (idempotent)
    const secondResult = await executeTaskVerify("v17c", {
      task_dir: taskDir,
      action: { action: "finalize" },
    });
    const secondData = parseResult(secondResult);
    expect(secondData.success).toBe(true);
    expect(secondData.verification_status).toBe("passed");
    // No auto-complete on second call (already completed)
    expect(secondData.auto_completed).toBe(false);

    // Task status should remain completed
    const afterSecond = readStatus(taskDir);
    expect(afterSecond.status).toBe("completed");
  });
});

// ────────────────────────────────────────────────────────────────
// 并发安全测试（不使用 fake timers，proper-lockfile 内部依赖 setTimeout）
// ────────────────────────────────────────────────────────────────
describe("executeTaskVerify - concurrent safety", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "verify-concurrent-"));
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
      started_at: status === "running" ? new Date().toISOString() : null,
      completed_at: null,
      progress: { total: 3, completed: 1, skipped: 0, current_step: "2.1", percentage: 33 },
      children: [],
      outputs: [],
      steps: [],
      timing: { elapsed_minutes: null },
      errors: [],
      alerts: [],
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

  it("16. should handle concurrent add-criterion safely", async () => {
    const taskDir = createTask("running");
    // 3 并发足够验证锁安全，proper-lockfile 重试机制在高并发下较慢
    const promises = Array.from({ length: 3 }, (_, i) =>
      executeTaskVerify(`v16-${i}`, {
        task_dir: taskDir,
        action: {
          action: "add-criterion",
          criterion: `Criterion ${i}`,
          result: "passed",
        },
      }),
    );
    const results = await Promise.all(promises);

    for (const result of results) {
      const data = parseResult(result);
      expect(data.success).toBe(true);
    }

    const status = readStatus(taskDir);
    expect(status.verification.criteria).toHaveLength(3);
  }, 30_000);
});
