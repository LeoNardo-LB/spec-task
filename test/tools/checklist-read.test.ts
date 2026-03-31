import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeChecklistRead } from "../../src/tools/checklist-read.js";

describe("executeChecklistRead", () => {
  let tmpDir: string;
  let taskDir: string;

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  const SAMPLE_CHECKLIST = `# 执行清单

## 数据收集
- [x] 1.1 获取股票基本信息
- [ ] 1.2 下载历史行情数据
- [ ] 1.3 获取财务报表数据

## 数据分析
- [x] 2.1 计算技术指标
- [ ] 2.2 执行基本面分析
- [ ] 2.3 生成分析报告

## 非编号项（不应被统计）
- [ ] 这是一个没有编号的项
- [x] 另一个没有编号的项
`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "checklist-read-test-"));
    taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "checklist.md"), SAMPLE_CHECKLIST, "utf-8");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return full content and progress stats", async () => {
    const result = await executeChecklistRead("cl-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.content).toBe(SAMPLE_CHECKLIST);
    expect(data.checklist_path).toContain("checklist.md");
    expect(data.steps).toBeDefined();
    expect(Array.isArray(data.steps)).toBe(true);

    // 进度统计：只计算有编号的步骤（6个）
    expect(data.progress.total).toBe(6);
    expect(data.progress.completed).toBe(2);
    expect(data.progress.skipped).toBe(0);
    expect(data.progress.percentage).toBe(33);
    expect(data.progress.current_step).toBe("1.2");
  });

  it("should return error when checklist.md does not exist", async () => {
    rmSync(join(taskDir, "checklist.md"));
    const result = await executeChecklistRead("cl-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("CHECKLIST_NOT_FOUND");
  });

  it("should return error when task_dir is empty", async () => {
    const result = await executeChecklistRead("cl-1", { task_dir: "" });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should return error when task_dir is undefined", async () => {
    const result = await executeChecklistRead("cl-1", { task_dir: undefined } as any);
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should handle empty checklist (zero steps)", async () => {
    writeFileSync(join(taskDir, "checklist.md"), "# Just a header\nNo steps here\n", "utf-8");
    const result = await executeChecklistRead("cl-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    // steps 不存在或为空 → CHECKLIST_NOT_FOUND
    expect(data.success).toBe(false);
    expect(data.error).toBe("CHECKLIST_NOT_FOUND");
  });

  it("should handle all steps completed", async () => {
    const allDone = "- [x] 1.1 Step 1\n- [x] 1.2 Step 2\n- [x] 2.1 Step 3\n";
    writeFileSync(join(taskDir, "checklist.md"), allDone, "utf-8");
    const result = await executeChecklistRead("cl-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.progress.total).toBe(3);
    expect(data.progress.completed).toBe(3);
    expect(data.progress.skipped).toBe(0);
    expect(data.progress.percentage).toBe(100);
    expect(data.progress.current_step).toBe("");
  });

  it("should auto-migrate when status.yaml has no steps but checklist.md exists", async () => {
    // Create a minimal status.yaml without steps field
    const minimalStatus = {
      task_id: "test-task",
      title: "test",
      created: "2026-03-30T10:00:00.000Z",
      updated: "2026-03-30T10:00:00.000Z",
      status: "running",
      assigned_to: "agent",
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
    };
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(minimalStatus), "utf-8");

    // checklist.md should still exist from beforeEach
    const result = await executeChecklistRead("cl-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.steps).toBeDefined();
    expect(data.steps.length).toBeGreaterThan(0);

    // Verify migration: status.yaml should now have steps populated from checklist.md
    const updatedStatus = YAML.parse(readFileSync(join(taskDir, "status.yaml"), "utf-8"));
    expect(updatedStatus.steps).toBeDefined();
    expect(updatedStatus.steps.length).toBeGreaterThan(0);
    expect(updatedStatus.progress.total).toBe(updatedStatus.steps.length);
  });
});
