import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeTaskResume } from "../../src/tools/task-resume.js";
import type { TaskStatus, TaskStatusData } from "../../src/types.js";

describe("executeTaskResume", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "task-resume-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTaskWithStatus(status: TaskStatus, overrides: Partial<TaskStatusData> = {}): string {
    const taskDir = join(tmpDir, "test-task");
    mkdirSync(taskDir, { recursive: true });

    const data: TaskStatusData = {
      task_id: "test-task",
      title: "Test Task",
      created: "2026-03-29T00:00:00.000Z",
      updated: "2026-03-29T00:00:00.000Z",
      status,
      assigned_to: "agent-1",
      started_at: null,
      completed_at: null,
      progress: { total: 5, completed: 2, skipped: 0, current_step: "3.1", percentage: 40 },
      children: [],
      outputs: ["/path/to/output.txt"],
      steps: [],
      timing: { elapsed_minutes: null },
      errors: [],
      alerts: [],
      blocked_by: [],
      verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
      revisions: [],
      ...overrides,
    };

    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
    return taskDir;
  }

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  it("should return correct next_action for 'pending' status", async () => {
    const taskDir = createTaskWithStatus("pending");
    const result = await executeTaskResume("t-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.status).toBe("pending");
    expect(data.next_action).toContain("等待分配");
    expect(data.next_action).toContain("assigned");
  });

  it("should return correct next_action for 'assigned' status", async () => {
    const taskDir = createTaskWithStatus("assigned");
    const result = await executeTaskResume("t-2", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.status).toBe("assigned");
    expect(data.next_action).toContain("等待开始");
    expect(data.next_action).toContain("running");
  });

  it("should return correct next_action for 'running' status with current_step", async () => {
    const taskDir = createTaskWithStatus("running");
    const result = await executeTaskResume("t-3", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.status).toBe("running");
    expect(data.next_action).toContain("继续执行");
    expect(data.next_action).toContain("3.1");
    expect(data.next_action).toContain("40%");
  });

  it("should return correct next_action for 'running' status with errors", async () => {
    const taskDir = createTaskWithStatus("running", {
      errors: [
        { step: "build", message: "Compilation failed", retry_count: 2, timestamp: "2026-03-29T10:00:00.000Z" },
      ],
    });
    const result = await executeTaskResume("t-4", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.next_action).toContain("修复错误");
    expect(data.next_action).toContain("build");
    expect(data.next_action).toContain("Compilation failed");
    expect(data.next_action).toContain("retry#2");
  });

  it("should return correct next_action for 'running' status with blocked_by", async () => {
    const taskDir = createTaskWithStatus("running", {
      blocked_by: [{ task: "task-A", reason: "waiting" }],
    });
    const result = await executeTaskResume("t-5", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.next_action).toContain("阻塞中");
    expect(data.next_action).toContain("task-A");
  });

  it("should return correct next_action for 'completed' status", async () => {
    const taskDir = createTaskWithStatus("completed", {
      completed_at: "2026-03-29T12:00:00.000Z",
    });
    const result = await executeTaskResume("t-6", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.status).toBe("completed");
    expect(data.next_action).toContain("已完成");
    expect(data.next_action).toContain("task_archive");
  });

  it("should return correct next_action for 'failed' status", async () => {
    const taskDir = createTaskWithStatus("failed");
    const result = await executeTaskResume("t-7", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.status).toBe("failed");
    expect(data.next_action).toContain("需要重试");
    expect(data.next_action).toContain("running");
  });

  it("should return correct next_action for 'blocked' status", async () => {
    const taskDir = createTaskWithStatus("blocked", {
      blocked_by: [
        { task: "task-B", reason: "dependency" },
        { task: "task-C", reason: "resource" },
      ],
    });
    const result = await executeTaskResume("t-8", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.status).toBe("blocked");
    expect(data.next_action).toContain("等待阻塞解除");
    expect(data.next_action).toContain("task-B(dependency)");
    expect(data.next_action).toContain("task-C(resource)");
  });

  it("should return correct next_action for 'cancelled' status", async () => {
    const taskDir = createTaskWithStatus("cancelled");
    const result = await executeTaskResume("t-9", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.status).toBe("cancelled");
    expect(data.next_action).toContain("已取消");
    expect(data.next_action).toContain("无法恢复");
  });

  it("should return correct next_action for 'revised' status", async () => {
    const taskDir = createTaskWithStatus("revised");
    const result = await executeTaskResume("t-10", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.status).toBe("revised");
    expect(data.next_action).toContain("需要重新规划");
    expect(data.next_action).toContain("task_transition running");
  });

  it("should return TASK_NOT_FOUND for nonexistent task_dir", async () => {
    const result = await executeTaskResume("t-11", {
      task_dir: "/nonexistent/task",
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
    expect(data.message).toContain("not found");
  });

  it("should return complete details object", async () => {
    const taskDir = createTaskWithStatus("running", {
      started_at: "2026-03-29T08:00:00.000Z",
      completed_at: null,
    });
    const result = await executeTaskResume("t-12", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.details).toBeDefined();
    expect(data.details.task_id).toBe("test-task");
    expect(data.details.title).toBe("Test Task");
    expect(data.details.created).toBe("2026-03-29T00:00:00.000Z");
    expect(data.details.updated).toBe("2026-03-29T00:00:00.000Z");
    expect(data.details.assigned_to).toBe("agent-1");
    expect(data.details.started_at).toBe("2026-03-29T08:00:00.000Z");
  });

  it("should include revisions array in result", async () => {
    const revisions = [
      {
        id: 1,
        type: "created" as const,
        timestamp: "2026-03-29T00:00:00.000Z",
        trigger: "agent-1",
        summary: "Task created",
        block_type: null,
        block_reason: null,
      },
    ];
    const taskDir = createTaskWithStatus("running", { revisions });
    const result = await executeTaskResume("t-13", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.revisions).toBeDefined();
    expect(data.revisions).toHaveLength(1);
    expect(data.revisions[0].id).toBe(1);
    expect(data.revisions[0].type).toBe("created");
  });

  it("should include children list in result", async () => {
    const childDir = join(tmpDir, "child-task");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(childDir, "status.yaml"),
      YAML.stringify({
        task_id: "child-task",
        title: "Child",
        created: "2026-03-29T00:00:00.000Z",
        updated: "2026-03-29T00:00:00.000Z",
        status: "pending",
        assigned_to: "agent-1",
        started_at: null,
        completed_at: null,
        progress: { total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 },
        children: [],
        outputs: [],
        steps: [],
        timing: { elapsed_minutes: null },
        errors: [],
        alerts: [],
        blocked_by: [],
        verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
        revisions: [],
      }),
      "utf-8",
    );

    const taskDir = createTaskWithStatus("running", {
      children: [childDir],
    });
    const result = await executeTaskResume("t-14", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.children).toBeDefined();
    expect(data.children).toHaveLength(1);
    expect(data.children[0]).toContain("child-task");
  });

  it("should prioritize errors over blocks when both exist", async () => {
    const taskDir = createTaskWithStatus("running", {
      errors: [
        { step: "build", message: "Compilation failed", retry_count: 2, timestamp: "2026-03-29T10:00:00.000Z" },
      ],
      blocked_by: [{ task: "task-A", reason: "waiting for dependency" }],
      progress: { total: 5, completed: 2, skipped: 0, current_step: "3.1", percentage: 40 },
    });
    const result = await executeTaskResume("t-priority", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    // next_action should mention error/retry, NOT block or step
    expect(data.next_action).toContain("修复错误");
    expect(data.next_action).toContain("build");
    expect(data.next_action).toContain("Compilation failed");
    // Should NOT mention block-related content
    expect(data.next_action).not.toContain("阻塞");
  });
});
