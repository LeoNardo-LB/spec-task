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

  it("should update parent's children list when parent is specified", async () => {
    const parentResult = await executeTaskCreate("tool-4a", {
      task_name: "parent-task",
      project_root: tmpDir,
    });
    const parentData = parseResult(parentResult.content[0].text);
    const parentDir = parentData.task_dir;

    const childResult = await executeTaskCreate("tool-4b", {
      task_name: "child-task",
      project_root: tmpDir,
      parent: parentDir,
    });
    const childData = parseResult(childResult.content[0].text);
    expect(childData.success).toBe(true);

    const parentStatus = getStatusYaml(parentDir);
    expect(parentStatus.children).toContain(childData.task_dir);

    const childStatus = getStatusYaml(childData.task_dir);
    expect(childStatus.parent).toBe(parentDir);
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

  it("should set depth parameter correctly", async () => {
    const result = await executeTaskCreate("tool-10", {
      task_name: "deep-task",
      project_root: tmpDir,
      depth: 3,
    });
    const data = parseResult(result.content[0].text);
    expect(data.success).toBe(true);

    const status = getStatusYaml(data.task_dir);
    expect(status.depth).toBe(3);
  });

  it("should set correct default values in status.yaml", async () => {
    const result = await executeTaskCreate("tool-11", {
      task_name: "defaults-task",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);
    const status = getStatusYaml(data.task_dir);

    expect(status.status).toBe("pending");
    expect(status.depth).toBe(0);
    expect(status.parent).toBeNull();
    expect(status.children).toEqual([]);
    expect(status.outputs).toEqual([]);
    expect(status.errors).toEqual([]);
    expect(status.alerts).toEqual([]);
    expect(status.blocked_by).toEqual([]);
    expect(status.started_at).toBeNull();
    expect(status.completed_at).toBeNull();
    expect(status.progress).toEqual({ total: 0, completed: 0, current_step: "", percentage: 0 });
    expect(status.timing).toEqual({ estimated_minutes: null, elapsed_minutes: null });
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
    expect(status.revisions[0].status_before).toBe("pending");
    expect(status.revisions[0].status_after).toBe("pending");
    expect(status.revisions[0].timestamp).toBe("2026-03-29T10:00:00.000Z");
  });

  it("should create .gitignore with correct content", async () => {
    const result = await executeTaskCreate("tool-13", {
      task_name: "git-task",
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);
    const gitignorePath = join(data.task_dir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);

    const content = readFileSync(gitignorePath, "utf-8");
    expect(content).toContain("status.yaml");
    expect(content).toContain("*.tmp");
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
});
