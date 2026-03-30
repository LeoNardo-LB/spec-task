import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { executeChecklistStatus } from "../../src/tools/checklist-status.js";

describe("executeChecklistStatus", () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), "checklist-status-test-"));
    taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "checklist.md"), SAMPLE_CHECKLIST, "utf-8");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return correct progress for a checklist with mixed states", async () => {
    const result = await executeChecklistStatus("cl-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    // 6 numbered + 2 unnumbered = 8 total items
    expect(data.total_steps).toBe(8);
    expect(data.completed_steps).toBe(3); // 1.1, 2.1, plus one unnumbered
    expect(data.progress_percent).toBe(38);
    expect(data.unchecked_steps).toContain("1.2");
    expect(data.unchecked_steps).toContain("1.3");
    expect(data.next_suggested_step).toBeDefined();
    expect(data.checklist_path).toContain("checklist.md");
  });

  it("should return 100% when all steps are completed", async () => {
    const allDoneChecklist = SAMPLE_CHECKLIST.replace(/- \[ \]/g, "- [x]");
    writeFileSync(join(taskDir, "checklist.md"), allDoneChecklist, "utf-8");

    const result = await executeChecklistStatus("cl-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.progress_percent).toBe(100);
    expect(data.unchecked_steps).toEqual([]);
    expect(data.next_suggested_step).toBeNull();
  });

  it("should return CHECKLIST_NOT_FOUND when checklist.md does not exist", async () => {
    const emptyTaskDir = join(tmpDir, "spec-task", "no-checklist");
    mkdirSync(emptyTaskDir, { recursive: true });

    const result = await executeChecklistStatus("cl-1", { task_dir: emptyTaskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("CHECKLIST_NOT_FOUND");
  });

  it("should return CHECKLIST_NOT_FOUND when task_dir does not exist", async () => {
    const result = await executeChecklistStatus("cl-1", { task_dir: "/nonexistent/path" });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("CHECKLIST_NOT_FOUND");
  });

  it("should handle unnumbered steps with index-based identifiers", async () => {
    const unnumberedChecklist = `# 无编号清单
- [ ] 获取数据
- [x] 分析数据
- [ ] 生成报告
`;
    writeFileSync(join(taskDir, "checklist.md"), unnumberedChecklist, "utf-8");

    const result = await executeChecklistStatus("cl-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.total_steps).toBe(3);
    expect(data.completed_steps).toBe(1);
    expect(data.unchecked_steps).toEqual(["#1", "#3"]);
    expect(data.next_suggested_step).toBe("#1");
  });

  it("should return INVALID_PARAMS when task_dir is empty", async () => {
    const result = await executeChecklistStatus("cl-1", { task_dir: "" });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should return zero progress for an empty checklist", async () => {
    writeFileSync(join(taskDir, "checklist.md"), "# Empty\n", "utf-8");

    const result = await executeChecklistStatus("cl-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.total_steps).toBe(0);
    expect(data.progress_percent).toBe(0);
    expect(data.unchecked_steps).toEqual([]);
    expect(data.next_suggested_step).toBeNull();
  });

  it("should handle checklist with only unnumbered items (all counted via index)", async () => {
    const onlyUnnumbered = `- [ ] First item\n- [x] Second item\n- [ ] Third item\n`;
    writeFileSync(join(taskDir, "checklist.md"), onlyUnnumbered, "utf-8");

    const result = await executeChecklistStatus("cl-1", { task_dir: taskDir });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.total_steps).toBe(3);
    expect(data.completed_steps).toBe(1);
    expect(data.progress_percent).toBe(33);
  });
});
