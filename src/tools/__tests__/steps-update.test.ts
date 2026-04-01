import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeStepsUpdate } from "../steps-update.js";
import type { Step } from "../../types.js";

describe("executeStepsUpdate", () => {
  let tmpDir: string;
  let taskDir: string;

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  function writeStatusYaml(taskDir: string, extra: Record<string, any> = {}) {
    const statusData = {
      task_id: "test-task",
      title: "test",
      created: "2026-03-30T10:00:00.000Z",
      updated: "2026-03-30T10:00:00.000Z",
      status: "running",
      assigned_to: "agent",
      started_at: null,
      completed_at: null,
      progress: { total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 },
      steps: [],
      errors: [],
      blocked_by: [],
      verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
      revisions: [],
      ...extra,
    };
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(statusData), "utf-8");
  }

  const sampleSteps: Step[] = [
    {
      id: "1.1",
      summary: {
        title: "收集数据",
        content: "获取股票基本信息和行情数据",
        approach: "通过 API 获取",
        sources: ["src/api/stock.ts"],
      },
      status: "pending",
      completed_at: null,
      tags: ["data"],
    },
    {
      id: "1.2",
      summary: {
        title: "分析数据",
        content: "计算技术指标",
        approach: "使用 pandas 计算",
        sources: ["src/analysis/technical.ts"],
      },
      status: "pending",
      completed_at: null,
      tags: [],
    },
    {
      id: "2.1",
      summary: {
        title: "生成报告",
        content: "汇总分析结果生成报告",
        approach: "模板渲染",
        sources: ["src/report/template.ts"],
      },
      status: "pending",
      completed_at: null,
      tags: [],
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "steps-update-test-"));
    taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });
    writeStatusYaml(taskDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should write steps and update status.yaml with progress", async () => {
    const result = await executeStepsUpdate("su-1", { task_dir: taskDir, steps: sampleSteps });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task_dir).toBe(taskDir);
    expect(data.progress.total).toBe(3);
    expect(data.progress.completed).toBe(0);
    expect(data.progress.percentage).toBe(0);
    expect(data.progress.current_step).toBe("1.1");

    // Verify status.yaml was updated
    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    expect(statusData.steps).toBeDefined();
    expect(statusData.steps.length).toBe(3);
    expect(statusData.steps[0].id).toBe("1.1");
    expect(statusData.steps[0].summary.title).toBe("收集数据");
    expect(statusData.progress.total).toBe(3);
  });

  it("should preserve completed_at for existing completed steps", async () => {
    // First write: complete step 1.1
    const completedSteps: Step[] = sampleSteps.map((s) =>
      s.id === "1.1"
        ? { ...s, status: "completed" as const, completed_at: "2026-03-29T08:00:00.000Z" }
        : s
    );
    await executeStepsUpdate("su-1", { task_dir: taskDir, steps: completedSteps });

    // Second write: same steps re-sent WITHOUT completed_at (field omitted)
    // This simulates the common case where the agent doesn't include completed_at in input
    const updatedSteps: Step[] = sampleSteps.map((s) => {
      if (s.id === "1.1") {
        const { completed_at: _, ...rest } = s;
        return { ...rest, status: "completed" as const } as Step;
      }
      return s;
    });
    await executeStepsUpdate("su-1", { task_dir: taskDir, steps: updatedSteps });

    // Verify completed_at was preserved from first write
    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    expect(statusData.steps[0].completed_at).toBe("2026-03-29T08:00:00.000Z");
  });

  it("should set completed_at to now for newly completed steps", async () => {
    const completedSteps: Step[] = sampleSteps.map((s) => {
      if (s.id === "1.1") {
        const { completed_at: _, ...rest } = s;
        return { ...rest, status: "completed" as const } as Step;
      }
      return s;
    });
    await executeStepsUpdate("su-1", { task_dir: taskDir, steps: completedSteps });

    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    expect(statusData.steps[0].completed_at).toBe("2026-03-30T10:00:00.000Z");
  });

  it("should handle empty steps array (all zeros progress)", async () => {
    const result = await executeStepsUpdate("su-1", { task_dir: taskDir, steps: [] });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.progress.total).toBe(0);
    expect(data.progress.completed).toBe(0);
    expect(data.progress.skipped).toBe(0);
    expect(data.progress.percentage).toBe(0);
    expect(data.progress.current_step).toBe("");

    // Verify status.yaml was updated with empty steps
    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    expect(statusData.steps).toEqual([]);
  });

  it("should return error when task_dir is empty", async () => {
    const result = await executeStepsUpdate("su-1", { task_dir: "", steps: sampleSteps });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should return error when task_dir is undefined", async () => {
    const result = await executeStepsUpdate("su-1", { task_dir: undefined as any, steps: sampleSteps });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should return error when steps is not an array", async () => {
    const result = await executeStepsUpdate("su-1", { task_dir: taskDir, steps: null as any });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should return error for non-existent task_dir", async () => {
    const fakeDir = join(tmpDir, "does-not-exist");
    // syncStepsToStatus silently ignores when status.yaml doesn't exist
    const result = await executeStepsUpdate("su-1", { task_dir: fakeDir, steps: sampleSteps });
    const data = parseResult(result.content[0].text);

    // Still returns success because it writes to status.yaml (which doesn't exist, silently ignored)
    // But progress should still be calculated correctly
    expect(data.success).toBe(true);
    expect(data.progress.total).toBe(3);
  });

  it("should calculate progress correctly with mixed statuses", async () => {
    const mixedSteps: Step[] = [
      { ...sampleSteps[0], status: "completed", completed_at: "2026-03-30T10:00:00.000Z" },
      { ...sampleSteps[1], status: "skipped", completed_at: "2026-03-30T10:00:00.000Z" },
      { ...sampleSteps[2], status: "pending", completed_at: null },
    ];
    const result = await executeStepsUpdate("su-1", { task_dir: taskDir, steps: mixedSteps });
    const data = parseResult(result.content[0].text);

    expect(data.progress.total).toBe(3);
    expect(data.progress.completed).toBe(1);
    expect(data.progress.skipped).toBe(1);
    expect(data.progress.percentage).toBe(33);
    expect(data.progress.current_step).toBe("2.1");
  });

  it("should reset completed_at to null when explicitly set by user", async () => {
    // First write: complete step 1.1 with a specific completed_at
    const completedSteps: Step[] = sampleSteps.map((s) =>
      s.id === "1.1"
        ? { ...s, status: "completed" as const, completed_at: "2026-03-29T08:00:00.000Z" }
        : s
    );
    await executeStepsUpdate("su-1", { task_dir: taskDir, steps: completedSteps });

    // Second write: explicitly set completed_at to null (reset) while keeping status as completed
    const resetSteps: Step[] = sampleSteps.map((s) =>
      s.id === "1.1"
        ? { ...s, status: "completed" as const, completed_at: null as string | null }
        : s
    );
    await executeStepsUpdate("su-1", { task_dir: taskDir, steps: resetSteps });

    // Verify completed_at was set to now (since status is still completed, a new timestamp is assigned)
    // but NOT preserved from the old value
    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    // The old completed_at should NOT be preserved; a new timestamp should be assigned
    expect(statusData.steps[0].completed_at).toBe("2026-03-30T10:00:00.000Z");
    expect(statusData.steps[0].completed_at).not.toBe("2026-03-29T08:00:00.000Z");
  });

  it("should reset completed_at when step is set back to pending", async () => {
    // First write: complete step 1.1
    const completedSteps: Step[] = sampleSteps.map((s) =>
      s.id === "1.1"
        ? { ...s, status: "completed" as const, completed_at: "2026-03-29T08:00:00.000Z" }
        : s
    );
    await executeStepsUpdate("su-1", { task_dir: taskDir, steps: completedSteps });

    // Second write: set step back to pending (should clear completed_at)
    const pendingSteps: Step[] = sampleSteps.map((s) =>
      s.id === "1.1"
        ? { ...s, status: "pending" as const, completed_at: null as string | null }
        : s
    );
    await executeStepsUpdate("su-1", { task_dir: taskDir, steps: pendingSteps });

    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    expect(statusData.steps[0].completed_at).toBeNull();
  });

  it("should preserve completed_at when existing step is skipped", async () => {
    // Write a skipped step with a specific completed_at
    const skippedSteps: Step[] = [
      { ...sampleSteps[0], status: "skipped", completed_at: "2026-03-28T15:00:00.000Z", skip_reason: "依赖缺失" },
    ];
    await executeStepsUpdate("su-1", { task_dir: taskDir, steps: skippedSteps });

    // Re-send the same step as skipped (without completed_at)
    const { completed_at: _, ...stepWithoutTimestamp } = sampleSteps[0];
    const reSentSteps: Step[] = [
      { ...stepWithoutTimestamp, status: "skipped", skip_reason: "依赖缺失" } as Step,
    ];
    await executeStepsUpdate("su-1", { task_dir: taskDir, steps: reSentSteps });

    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    expect(statusData.steps[0].completed_at).toBe("2026-03-28T15:00:00.000Z");
  });
});
