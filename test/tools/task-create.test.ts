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
    // v0.3.0: task_dir points to runs/001/, status.yaml is directly there
    const content = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    return YAML.parse(content);
  }

  it("should create task with default parameters", async () => {
    const result = await executeTaskCreate("tool-1", {
      task_name: "my-task",
      project_root: tmpDir,
      brief: "## 目标\n默认参数测试",
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
      brief: "## 目标\n自定义标题测试",
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
      brief: "## 目标\nassigned_to 测试",
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
      brief: "## 目标\nUnicode 测试",
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.task_id).toBe("数据分析-任务");
  });

  it("should create a new run when task already exists and all runs are terminal", async () => {
    // First create: task with run 001
    const result1 = await executeTaskCreate("tool-6a", {
      task_name: "dup-task",
      project_root: tmpDir,
      brief: "## 目标\n测试重复创建",
    });
    const data1 = parseResult(result1.content[0].text);
    expect(data1.success).toBe(true);
    expect(data1.run_id).toBe("001");

    // Second create: should create run 002 (first run is still pending = non-terminal)
    // But pending is NOT terminal, so this should fail with TASK_HAS_ACTIVE_RUNS
    const result2 = await executeTaskCreate("tool-6b", {
      task_name: "dup-task",
      project_root: tmpDir,
    });
    const data2 = parseResult(result2.content[0].text);
    expect(data2.success).toBe(false);
    expect(data2.error).toBe("TASK_HAS_ACTIVE_RUNS");
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
      brief: "## 目标\n默认值测试",
    });
    const data = parseResult(result.content[0].text);
    const status = getStatusYaml(data.task_dir);

    expect(status.status).toBe("pending");
    expect(status.outputs).toEqual([]);
    expect(status.steps).toEqual([]);
    expect(status.errors).toEqual([]);
    expect(status.blocked_by).toEqual([]);
    expect(status.started_at).toBeNull();
    expect(status.completed_at).toBeNull();
    expect(status.progress).toEqual({ total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 });
    expect(status.verification.status).toBe("pending");
    expect(status.verification.criteria).toEqual([]);
  });

  it("should create a revision with type 'created'", async () => {
    const result = await executeTaskCreate("tool-12", {
      task_name: "rev-task",
      project_root: tmpDir,
      assigned_to: "agent-1",
      brief: "## 目标\nrevision 测试",
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
      brief: "## 目标\ngitignore 测试",
    });
    const data = parseResult(result.content[0].text);
    const gitignorePath = join(data.task_dir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(false);
  });

  it("should return complete TaskCreateResult structure", async () => {
    const result = await executeTaskCreate("tool-14", {
      task_name: "struct-task",
      project_root: tmpDir,
      brief: "## 目标\n结构测试",
    });
    const data = parseResult(result.content[0].text);

    expect(data).toHaveProperty("success", true);
    expect(data).toHaveProperty("task_dir");
    expect(data).toHaveProperty("task_id", "struct-task");
    expect(data).toHaveProperty("status", "pending");
    expect(data).toHaveProperty("run_id");
    expect(data).toHaveProperty("created_dirs");
    expect(data.created_dirs).toHaveLength(2); // task root + run dir
    expect(data.created_dirs[0]).toContain("struct-task");
  });

  it("should use cwd when project_root is not specified", async () => {
    // 在 tmpDir 中模拟 cwd 行为，不依赖实际 cwd
    const result = await executeTaskCreate("tool-15", {
      task_name: "cwd-task",
      project_root: tmpDir,
      brief: "## 目标\ncwd 测试",
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.task_dir).toContain("spec-task");
    expect(data.task_dir).toContain("cwd-task");
  });
});
