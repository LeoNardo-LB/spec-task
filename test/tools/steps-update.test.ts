import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeStepsUpdate } from "../../src/tools/steps-update.js";

describe("executeStepsUpdate", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "steps-update-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTaskDir(): string {
    const taskDir = join(tmpDir, "test-task");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({
      task_id: "test-task",
      status: "running",
      steps: [],
      progress: { total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 },
    }), "utf-8");
    return taskDir;
  }

  function makeStep(id: string, status: "pending" | "completed" | "skipped" = "pending") {
    return {
      id,
      summary: { title: `Step ${id}`, content: "content", approach: "approach", sources: ["plan.md#Steps"] },
      status,
      completed_at: status !== "pending" ? "2026-03-29T12:00:00.000Z" : null,
      tags: [],
    };
  }

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  it("should update steps and return progress", async () => {
    const taskDir = createTaskDir();
    const steps = [makeStep("1.1", "completed"), makeStep("1.2", "pending"), makeStep("2.1", "pending")];
    const result = await executeStepsUpdate("t-1", { task_dir: taskDir, steps });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.progress).toEqual({ total: 3, completed: 1, skipped: 0, current_step: "1.2", percentage: 33 });
  });

  it("should return all_steps_completed=false when steps are incomplete", async () => {
    const taskDir = createTaskDir();
    const steps = [makeStep("1.1", "completed"), makeStep("1.2", "pending")];
    const result = await executeStepsUpdate("t-2", { task_dir: taskDir, steps });
    const data = parseResult(result.content[0].text);

    expect(data.all_steps_completed).toBe(false);
    expect(data.suggested_action).toBeUndefined();
    expect(data.next_action_hint).toBeUndefined();
  });

  it("should return all_steps_completed=true and suggested_action=task_verify when all steps completed", async () => {
    const taskDir = createTaskDir();
    const steps = [makeStep("1.1", "completed"), makeStep("1.2", "completed")];
    const result = await executeStepsUpdate("t-3", { task_dir: taskDir, steps });
    const data = parseResult(result.content[0].text);

    expect(data.all_steps_completed).toBe(true);
    expect(data.suggested_action).toBe("task_verify");
    expect(data.next_action_hint).toContain("task_verify");
    expect(data.next_action_hint).toContain("task_transition");
  });

  it("should return all_steps_completed=true when all steps skipped", async () => {
    const taskDir = createTaskDir();
    const steps = [makeStep("1.1", "skipped"), makeStep("1.2", "skipped")];
    const result = await executeStepsUpdate("t-4", { task_dir: taskDir, steps });
    const data = parseResult(result.content[0].text);

    expect(data.all_steps_completed).toBe(true);
    expect(data.suggested_action).toBe("task_verify");
    // percentage 仅统计 completed 步骤，skipped 不计入；全 skipped 时为 0
    expect(data.progress.percentage).toBe(0);
  });

  it("should return all_steps_completed=true for mixed completed+skipped steps", async () => {
    const taskDir = createTaskDir();
    const steps = [makeStep("1.1", "completed"), makeStep("1.2", "skipped")];
    const result = await executeStepsUpdate("t-5", { task_dir: taskDir, steps });
    const data = parseResult(result.content[0].text);

    expect(data.all_steps_completed).toBe(true);
    expect(data.suggested_action).toBe("task_verify");
    expect(data.next_action_hint).toContain("task_verify");
  });

  it("should return error for empty task_dir", async () => {
    const result = await executeStepsUpdate("t-6", { task_dir: "", steps: [makeStep("1.1")] });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should persist steps to status.yaml", async () => {
    const taskDir = createTaskDir();
    const steps = [makeStep("1.1", "completed"), makeStep("2.1", "pending")];
    await executeStepsUpdate("t-7", { task_dir: taskDir, steps });

    const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const status = YAML.parse(content);
    expect(status.steps).toHaveLength(2);
    expect(status.steps[0].id).toBe("1.1");
    expect(status.steps[0].status).toBe("completed");
    expect(status.progress.total).toBe(2);
    expect(status.progress.completed).toBe(1);
  });
});
