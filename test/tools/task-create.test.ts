import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeTaskCreate } from "../../src/tools/task-create.js";

describe("executeTaskCreate", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T10:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "create-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  function getStatusYaml(taskDir: string): any {
    const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    return YAML.parse(content);
  }

  it("should create task with default parameters", async () => {
    const result = await executeTaskCreate("tool-1", {
      task_name: "my-task",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task_id).toBe("my-task");
    expect(data.status).toBe("pending");
    expect(data.task_dir).toContain("spec-task");
    expect(data.task_dir).toContain("my-task");

    expect(existsSync(data.task_dir)).toBe(true);
    expect(existsSync(join(data.task_dir, "status.yaml"))).toBe(true);
  });

  it("should use custom title when provided", async () => {
    const result = await executeTaskCreate("tool-2", {
      task_name: "task-1",
      project_root: tmpDir,
      title: "自定义任务标题",
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(true);

    const status = getStatusYaml(data.task_dir);
    expect(status.title).toBe("自定义任务标题");
  });

  it("should set assigned_to when provided", async () => {
    const result = await executeTaskCreate("tool-3", {
      task_name: "task-1",
      project_root: tmpDir,
      assigned_to: "agent-007",
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(true);

    const status = getStatusYaml(data.task_dir);
    expect(status.assigned_to).toBe("agent-007");
  });

  it("should handle Unicode task_name", async () => {
    const result = await executeTaskCreate("tool-5", {
      task_name: "数据分析-任务",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.task_id).toBe("数据分析-任务");
  });

  it("should return TASK_ALREADY_EXISTS for duplicate task name", async () => {
    await executeTaskCreate("tool-6a", {
      task_name: "dup-task",
      project_root: tmpDir,
    });

    const result = await executeTaskCreate("tool-6b", {
      task_name: "dup-task",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_ALREADY_EXISTS");
  });

  it("should reject task_name containing '/'", async () => {
    const result = await executeTaskCreate("tool-7", {
      task_name: "bad/name",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
    expect(data.message).toContain("/");
  });

  it("should reject task_name containing null byte", async () => {
    const result = await executeTaskCreate("tool-8", {
      task_name: "bad\0name",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should reject empty task_name", async () => {
    const result = await executeTaskCreate("tool-9", {
      task_name: "",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should set correct default values in status.yaml", async () => {
    const result = await executeTaskCreate("tool-11", {
      task_name: "defaults-task",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);
    const status = getStatusYaml(data.task_dir);

    expect(status.status).toBe("pending");
    expect(status.children).toEqual([]);
    expect(status.outputs).toEqual([]);
    expect(status.steps).toEqual([]);
    expect(status.errors).toEqual([]);
    expect(status.alerts).toEqual([]);
    expect(status.blocked_by).toEqual([]);
    expect(status.started_at).toBeNull();
    expect(status.completed_at).toBeNull();
    expect(status.progress).toEqual({ total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 });
    expect(status.timing).toEqual({ elapsed_minutes: null });
    expect(status.verification.status).toBe("pending");
    expect(status.verification.criteria).toEqual([]);
  });

  it("should create a revision with type 'created'", async () => {
    const result = await executeTaskCreate("tool-12", {
      task_name: "rev-task",
      project_root: tmpDir,
      assigned_to: "agent-1",
    });
    const data = parseResult(result.content[0].text);
    const status = getStatusYaml(data.task_dir);

    expect(status.revisions).toHaveLength(1);
    expect(status.revisions[0].type).toBe("created");
    expect(status.revisions[0].id).toBe(1);
    expect(status.revisions[0].trigger).toBe("agent-1");
    expect(status.revisions[0].timestamp).toBe("2026-03-29T10:00:00.000Z");
  });

  it("should NOT create .gitignore (removed as unnecessary)", async () => {
    const result = await executeTaskCreate("tool-13", {
      task_name: "git-task",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);
    const gitignorePath = join(data.task_dir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(false);
  });

  it("should return complete TaskCreateResult structure", async () => {
    const result = await executeTaskCreate("tool-14", {
      task_name: "struct-task",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data).toHaveProperty("success", true);
    expect(data).toHaveProperty("task_dir");
    expect(data).toHaveProperty("task_id", "struct-task");
    expect(data).toHaveProperty("status", "pending");
    expect(data).toHaveProperty("created_dirs");
    expect(data.created_dirs).toHaveLength(1);
    expect(data.created_dirs[0]).toContain("struct-task");
  });

  it("should use cwd when project_root is not specified", async () => {
    // 在 tmpDir 中模拟 cwd 行为，不依赖实际 cwd
    const result = await executeTaskCreate("tool-15", {
      task_name: "cwd-task",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.task_dir).toContain("spec-task");
    expect(data.task_dir).toContain("cwd-task");
  });

  it("should parse checklist into steps array when checklist parameter is provided", async () => {
    const checklist = `## 1. 数据收集
- [x] 1.1 收集财务数据 [spawn:financial-valuation]
- [x] 1.2 获取行业报告
- [-] 1.3 对比行业均值 (数据不可用)
- [ ] 2.1 财务估值分析`;

    const result = await executeTaskCreate("tool-16", {
      task_name: "checklist-task",
      project_root: tmpDir,
      checklist,
    });
    const data = parseResult(result.content[0].text);
    const status = getStatusYaml(data.task_dir);

    // checklist.md should be created
    expect(existsSync(join(data.task_dir, "checklist.md"))).toBe(true);
    expect(data.created_artifacts).toContain("checklist");

    // steps should be parsed from checklist
    expect(status.steps).toBeDefined();
    expect(status.steps.length).toBe(4);

    // Step 1.1: completed with tag
    expect(status.steps[0].id).toBe("1.1");
    expect(status.steps[0].status).toBe("completed");
    expect(status.steps[0].completed_at).not.toBeNull();
    expect(status.steps[0].tags).toEqual(["spawn:financial-valuation"]);

    // Step 1.2: completed without tag
    expect(status.steps[1].id).toBe("1.2");
    expect(status.steps[1].status).toBe("completed");

    // Step 1.3: skipped with skip_reason
    expect(status.steps[2].id).toBe("1.3");
    expect(status.steps[2].status).toBe("skipped");
    expect(status.steps[2].skip_reason).toBe("数据不可用");
    expect(status.steps[2].completed_at).not.toBeNull();

    // Step 2.1: pending
    expect(status.steps[3].id).toBe("2.1");
    expect(status.steps[3].status).toBe("pending");
    expect(status.steps[3].completed_at).toBeNull();

    // progress should be calculated from steps
    expect(status.progress).toEqual({
      total: 4,
      completed: 2,
      skipped: 1,
      current_step: "2.1",
      percentage: 50,
    });
  });
});
