import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeTaskTransition } from "../../src/tools/task-transition.js";
import type { TaskStatus, TaskStatusData } from "../../src/types.js";

describe("executeTaskTransition", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "transition-test-"));
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
      title: "Test",
      created: "2026-03-29T00:00:00.000Z",
      updated: "2026-03-29T00:00:00.000Z",
      status,
      assigned_to: "agent",
      started_at: null,
      completed_at: null,
      progress: { total: 5, completed: 2, current_step: "3.1", percentage: 40 },
      parent: null,
      depth: 0,
      children: [],
      outputs: [],
      timing: { estimated_minutes: 30, elapsed_minutes: null },
      errors: [],
      alerts: [],
      blocked_by: [],
      verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
      revisions: [],
      ...overrides,
    };

    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
    writeFileSync(join(taskDir, "checklist.md"),
      "- [x] 1.1 Done\n- [x] 1.2 Done\n- [ ] 2.1 Todo\n- [ ] 2.2 Todo\n- [ ] 2.3 Todo\n",
      "utf-8"
    );

    return taskDir;
  }

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  describe("14 valid transitions", () => {
    const validCases: Array<{ from: TaskStatus; to: TaskStatus }> = [
      { from: "pending", to: "assigned" },
      { from: "pending", to: "cancelled" },
      { from: "assigned", to: "running" },
      { from: "assigned", to: "cancelled" },
      { from: "running", to: "completed" },
      { from: "running", to: "failed" },
      { from: "running", to: "blocked" },
      { from: "running", to: "cancelled" },
      { from: "running", to: "revised" },
      { from: "running", to: "running" },
      { from: "failed", to: "running" },
      { from: "blocked", to: "pending" },
      { from: "revised", to: "running" },
      { from: "revised", to: "pending" },
    ];

    it.each(validCases)("$from → $to should succeed", async ({ from, to }) => {
      const taskDir = createTaskWithStatus(from);
      const result = await executeTaskTransition("t-1", { task_dir: taskDir, status: to });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.old_status).toBe(from);
      expect(data.new_status).toBe(to);

      const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
      const status = YAML.parse(content);
      if (from === "running" && to === "running") {
        expect(status.revisions).toHaveLength(0);
      } else {
        expect(status.revisions.length).toBeGreaterThanOrEqual(1);
        const rev = status.revisions[status.revisions.length - 1];
        expect(rev.status_before).toBe(from);
        expect(rev.status_after).toBe(to);
      }
    });
  });

  describe("14 invalid transitions", () => {
    const invalidCases: Array<{ from: TaskStatus; to: TaskStatus }> = [
      { from: "completed", to: "running" },
      { from: "completed", to: "pending" },
      { from: "completed", to: "failed" },
      { from: "cancelled", to: "running" },
      { from: "cancelled", to: "pending" },
      { from: "cancelled", to: "assigned" },
      { from: "pending", to: "running" },
      { from: "pending", to: "completed" },
      { from: "pending", to: "failed" },
      { from: "assigned", to: "assigned" },
      { from: "failed", to: "failed" },
      { from: "failed", to: "completed" },
      { from: "blocked", to: "running" },
      { from: "revised", to: "revised" },
    ];

    it.each(invalidCases)("$from → $to should return INVALID_TRANSITION", async ({ from, to }) => {
      const taskDir = createTaskWithStatus(from);
      const result = await executeTaskTransition("t-2", { task_dir: taskDir, status: to });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_TRANSITION");

      const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
      const status = YAML.parse(content);
      expect(status.status).toBe(from);
    });
  });

  it("running→running should refresh progress without creating revision", async () => {
    const taskDir = createTaskWithStatus("running");
    const result = await executeTaskTransition("t-3", {
      task_dir: taskDir,
      status: "running",
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.revision_id).toBe(-1);

    const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const status = YAML.parse(content);
    expect(status.progress.total).toBe(5);
    expect(status.progress.completed).toBe(2);
    expect(status.progress.percentage).toBe(40);
    expect(status.revisions).toHaveLength(0);
  });

  it("should auto-calculate progress from checklist.md on transition", async () => {
    const taskDir = createTaskWithStatus("pending");
    await executeTaskTransition("t-4", { task_dir: taskDir, status: "assigned" });

    const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const status = YAML.parse(content);

    expect(status.progress.total).toBe(5);
    expect(status.progress.completed).toBe(2);
    expect(status.progress.percentage).toBe(40);
  });

  it("should set started_at on first assigned transition", async () => {
    const taskDir = createTaskWithStatus("pending");
    await executeTaskTransition("t-5", { task_dir: taskDir, status: "assigned" });

    const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const status = YAML.parse(content);
    expect(status.started_at).toBe("2026-03-29T12:00:00.000Z");
  });

  it("should return TASK_NOT_FOUND for nonexistent task_dir", async () => {
    const result = await executeTaskTransition("t-8", {
      task_dir: "/nonexistent/task",
      status: "running",
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });
});
