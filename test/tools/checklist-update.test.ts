import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeChecklistUpdate } from "../../src/tools/checklist-update.js";
import { executeTaskCreate } from "../../src/tools/task-create.js";

describe("executeChecklistUpdate", () => {
  let tmpDir: string;
  let taskDir: string;

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  const SAMPLE_CHECKLIST = `# 执行清单

## 数据收集
- [ ] 1.1 获取股票基本信息
- [ ] 1.2 下载历史行情数据
- [ ] 1.3 获取财务报表数据

## 数据分析
- [ ] 2.1 计算技术指标
- [ ] 2.2 执行基本面分析
- [ ] 2.3 生成分析报告

## 非编号项（不应被统计）
- [ ] 这是一个没有编号的项
- [ ] 另一个没有编号的项
`;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "checklist-test-"));

    // 创建任务并写入 checklist.md
    const createResult = await executeTaskCreate("cl-1", {
      task_name: "test-task",
      project_root: tmpDir,
    });
    const createData = parseResult(createResult.content[0].text);
    taskDir = createData.task_dir;
    writeFileSync(join(taskDir, "checklist.md"), SAMPLE_CHECKLIST, "utf-8");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readChecklist(): string {
    return readFileSync(join(taskDir, "checklist.md"), "utf-8");
  }

  function getStatusYaml(): any {
    const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    return YAML.parse(content);
  }

  // ── 正常场景 ──────────────────────────────────────────────

  describe("normal scenarios", () => {
    it("should check a step (mark as completed)", async () => {
      const result = await executeChecklistUpdate("cl-2", {
        task_dir: taskDir,
        step_number: "1.1",
        checked: true,
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.step_number).toBe("1.1");
      expect(data.checked).toBe(true);
      expect(data.line_before).toContain("- [ ] 1.1");
      expect(data.line_after).toContain("- [x] 1.1");

      // 验证文件确实被修改
      const checklist = readChecklist();
      expect(checklist).toContain("- [x] 1.1 获取股票基本信息");
      expect(checklist).toContain("- [ ] 1.2 下载历史行情数据");

      // 验证 status.yaml 进度更新
      const status = getStatusYaml();
      expect(status.progress.total).toBe(6);
      expect(status.progress.completed).toBe(1);
      expect(status.progress.percentage).toBe(17);
    });

    it("should uncheck a step (mark as not completed)", async () => {
      // 先勾选
      await executeChecklistUpdate("cl-3a", {
        task_dir: taskDir,
        step_number: "1.1",
        checked: true,
      });

      // 再取消勾选
      const result = await executeChecklistUpdate("cl-3b", {
        task_dir: taskDir,
        step_number: "1.1",
        checked: false,
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.checked).toBe(false);
      expect(data.line_before).toContain("- [x] 1.1");
      expect(data.line_after).toContain("- [ ] 1.1");

      const status = getStatusYaml();
      expect(status.progress.completed).toBe(0);
      expect(status.progress.percentage).toBe(0);
    });

    it("should update multiple steps sequentially", async () => {
      for (const step of ["1.1", "1.2", "1.3"]) {
        const result = await executeChecklistUpdate(`cl-4-${step}`, {
          task_dir: taskDir,
          step_number: step,
          checked: true,
        });
        expect(parseResult(result.content[0].text).success).toBe(true);
      }

      const status = getStatusYaml();
      expect(status.progress.total).toBe(6);
      expect(status.progress.completed).toBe(3);
      expect(status.progress.percentage).toBe(50);
      expect(status.progress.current_step).toBe("2.1");
    });

    it("should complete all steps and show 100%", async () => {
      for (const step of ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3"]) {
        await executeChecklistUpdate(`cl-5-${step}`, {
          task_dir: taskDir,
          step_number: step,
          checked: true,
        });
      }

      const status = getStatusYaml();
      expect(status.progress.total).toBe(6);
      expect(status.progress.completed).toBe(6);
      expect(status.progress.percentage).toBe(100);
      expect(status.progress.current_step).toBe("");
    });

    it("should not count unnumbered checkboxes in progress", async () => {
      await executeChecklistUpdate("cl-6", {
        task_dir: taskDir,
        step_number: "1.1",
        checked: true,
      });

      const status = getStatusYaml();
      // total=6（只有编号的 checkbox），不包括底部的无编号项
      expect(status.progress.total).toBe(6);
      expect(status.progress.completed).toBe(1);
    });

    it("should return success with progress_note when step is already in desired state", async () => {
      await executeChecklistUpdate("cl-7a", {
        task_dir: taskDir,
        step_number: "1.1",
        checked: true,
      });

      const result = await executeChecklistUpdate("cl-7b", {
        task_dir: taskDir,
        step_number: "1.1",
        checked: true,
      });
      const data = parseResult(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.progress_note).toContain("already");
    });
  });

  // ── 参数校验 ──────────────────────────────────────────────

  describe("parameter validation", () => {
    it("should reject empty task_dir", async () => {
      const result = await executeChecklistUpdate("cl-8", {
        task_dir: "",
        step_number: "1.1",
        checked: true,
      });
      const data = parseResult(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_PARAMS");
    });

    it("should reject empty step_number", async () => {
      const result = await executeChecklistUpdate("cl-9", {
        task_dir: taskDir,
        step_number: "",
        checked: true,
      });
      const data = parseResult(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_PARAMS");
    });

    it("should reject invalid step_number format", async () => {
      const result = await executeChecklistUpdate("cl-10", {
        task_dir: taskDir,
        step_number: "abc",
        checked: true,
      });
      const data = parseResult(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_PARAMS");
      expect(data.message).toContain("Invalid step_number format");
    });

    it("should reject non-boolean checked", async () => {
      const result = await executeChecklistUpdate("cl-11", {
        task_dir: taskDir,
        step_number: "1.1",
        checked: "yes" as any,
      });
      const data = parseResult(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_PARAMS");
    });
  });

  // ── 错误场景 ──────────────────────────────────────────────

  describe("error scenarios", () => {
    it("should return TASK_NOT_FOUND when checklist.md does not exist", async () => {
      const noChecklistDir = join(tmpDir, "spec-task", "no-checklist");
      mkdirSync(noChecklistDir, { recursive: true });

      const result = await executeChecklistUpdate("cl-12", {
        task_dir: noChecklistDir,
        step_number: "1.1",
        checked: true,
      });
      const data = parseResult(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error).toBe("TASK_NOT_FOUND");
    });

    it("should return error when step_number not found in checklist", async () => {
      const result = await executeChecklistUpdate("cl-13", {
        task_dir: taskDir,
        step_number: "9.9",
        checked: true,
      });
      const data = parseResult(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_PARAMS");
      expect(data.message).toContain("not found");
    });
  });

  // ── 边界场景 ──────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle deep nested step numbers (1.1.2)", async () => {
      const deepChecklist = `- [ ] 1.1.1 子步骤 A
- [ ] 1.1.2 子步骤 B
- [ ] 1.1.3 子步骤 C
`;
      writeFileSync(join(taskDir, "checklist.md"), deepChecklist, "utf-8");

      const result = await executeChecklistUpdate("cl-14", {
        task_dir: taskDir,
        step_number: "1.1.2",
        checked: true,
      });
      const data = parseResult(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.line_after).toContain("- [x] 1.1.2 子步骤 B");
    });

    it("should succeed even if status.yaml update fails", async () => {
      // 删除 status.yaml 模拟更新失败
      rmSync(join(taskDir, "status.yaml"));

      const result = await executeChecklistUpdate("cl-15", {
        task_dir: taskDir,
        step_number: "1.1",
        checked: true,
      });
      const data = parseResult(result.content[0].text);

      // checklist.md 本身应该已经被更新
      expect(data.success).toBe(true);
      expect(data.line_after).toContain("- [x] 1.1");
      expect(data.warning).toContain("status.yaml progress update failed");

      const checklist = readChecklist();
      expect(checklist).toContain("- [x] 1.1 获取股票基本信息");
    });

    it("should return complete ChecklistUpdateResult structure", async () => {
      const result = await executeChecklistUpdate("cl-16", {
        task_dir: taskDir,
        step_number: "2.1",
        checked: true,
      });
      const data = parseResult(result.content[0].text);

      expect(data).toHaveProperty("success", true);
      expect(data).toHaveProperty("task_dir", taskDir);
      expect(data).toHaveProperty("step_number", "2.1");
      expect(data).toHaveProperty("checked", true);
      expect(data).toHaveProperty("line_before");
      expect(data).toHaveProperty("line_after");
      expect(data).toHaveProperty("progress");
      expect(data.progress).toHaveProperty("total");
      expect(data.progress).toHaveProperty("completed");
      expect(data.progress).toHaveProperty("current_step");
      expect(data.progress).toHaveProperty("percentage");
    });
  });
});
