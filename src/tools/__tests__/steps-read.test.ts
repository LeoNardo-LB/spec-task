import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeStepsRead } from "../steps-read.js";
import type { Step } from "../../types.js";

describe("executeStepsRead", () => {
  let tmpDir: string;
  let taskDir: string;

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  function writeStatusYaml(taskDir: string, steps: Step[] = []) {
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
      steps,
      errors: [],
      blocked_by: [],
      verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
      revisions: [],
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
      status: "completed",
      completed_at: "2026-03-30T10:00:00.000Z",
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
    tmpDir = mkdtempSync(join(tmpdir(), "steps-read-test-"));
    taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });
    writeStatusYaml(taskDir, sampleSteps);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return steps and progress from status.yaml", async () => {
    const result = await executeStepsRead("sr-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task_dir).toBe(taskDir);
    expect(data.steps).toBeDefined();
    expect(data.steps.length).toBe(3);
    expect(data.steps[0].id).toBe("1.1");
    expect(data.steps[0].summary.title).toBe("收集数据");
    expect(data.steps[0].status).toBe("completed");
    expect(data.steps[0].completed_at).toBe("2026-03-30T10:00:00.000Z");

    expect(data.progress.total).toBe(3);
    expect(data.progress.completed).toBe(1);
    expect(data.progress.skipped).toBe(0);
    expect(data.progress.percentage).toBe(33);
    expect(data.progress.current_step).toBe("1.2");
  });

  it("should return error when status.yaml does not exist", async () => {
    const fakeDir = join(tmpDir, "no-status-here");
    mkdirSync(fakeDir, { recursive: true });
    const result = await executeStepsRead("sr-1", { task_dir: fakeDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("STEPS_NOT_FOUND");
  });

  it("should return error when steps is empty in status.yaml", async () => {
    writeStatusYaml(taskDir, []);
    const result = await executeStepsRead("sr-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("STEPS_NOT_FOUND");
  });

  it("should return error when task_dir is empty", async () => {
    const result = await executeStepsRead("sr-1", { task_dir: "" });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should return error when task_dir is undefined", async () => {
    const result = await executeStepsRead("sr-1", { task_dir: undefined as any });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should calculate progress correctly for all completed steps", async () => {
    const allCompletedSteps: Step[] = sampleSteps.map((s) => ({
      ...s,
      status: "completed" as const,
      completed_at: "2026-03-30T10:00:00.000Z",
    }));
    writeStatusYaml(taskDir, allCompletedSteps);

    const result = await executeStepsRead("sr-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.progress.total).toBe(3);
    expect(data.progress.completed).toBe(3);
    expect(data.progress.skipped).toBe(0);
    expect(data.progress.percentage).toBe(100);
    expect(data.progress.current_step).toBe("");
  });

  it("should calculate progress correctly for mixed statuses", async () => {
    const mixedSteps: Step[] = [
      { ...sampleSteps[0], status: "completed", completed_at: "2026-03-30T10:00:00.000Z" },
      { ...sampleSteps[1], status: "skipped", completed_at: "2026-03-30T10:00:00.000Z", skip_reason: "依赖缺失" },
      { ...sampleSteps[2], status: "pending", completed_at: null },
    ];
    writeStatusYaml(taskDir, mixedSteps);

    const result = await executeStepsRead("sr-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.progress.total).toBe(3);
    expect(data.progress.completed).toBe(1);
    expect(data.progress.skipped).toBe(1);
    expect(data.progress.percentage).toBe(33);
    expect(data.progress.current_step).toBe("2.1");
  });

  it("should return full step data including tags and sources", async () => {
    const result = await executeStepsRead("sr-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.steps[0].tags).toEqual(["data"]);
    expect(data.steps[0].summary.sources).toEqual(["src/api/stock.ts"]);
    expect(data.steps[0].summary.content).toBe("获取股票基本信息和行情数据");
    expect(data.steps[0].summary.approach).toBe("通过 API 获取");
  });
});
