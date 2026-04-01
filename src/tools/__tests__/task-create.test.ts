import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeTaskCreate } from "../task-create.js";
import { resolveTaskRoot } from "../../core/run-utils.js";

describe("executeTaskCreate", () => {
  let tmpDir: string;

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  function writeTerminalRunStatus(taskRoot: string, runId: string, status: string) {
    const runPath = join(taskRoot, "runs", runId);
    mkdirSync(runPath, { recursive: true });
    const statusData = {
      task_id: "test-task",
      title: "Test",
      created: "2026-03-30T10:00:00.000Z",
      updated: "2026-03-30T10:00:00.000Z",
      status,
      assigned_to: "agent",
      run_id: runId,
      started_at: null,
      completed_at: null,
      progress: { total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 },
      steps: [],
      outputs: [],
      errors: [],
      blocked_by: [],
      verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
      revisions: [],
    };
    writeFileSync(join(runPath, "status.yaml"), YAML.stringify(statusData), "utf-8");
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "task-create-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // 场景 1：创建新任务
  // ============================================================================

  describe("creating a new task", () => {
    it("should create task root with brief.md and plan.md, and runs/001/ with status.yaml", async () => {
      const result = await executeTaskCreate("tc-1", {
        task_name: "test-task",
        project_root: tmpDir,
        title: "Test Task",
        assigned_to: "agent-1",
        brief: "## 目标\n完成测试",
        plan: "## 步骤\n1. 做事",
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.task_id).toBe("test-task");
      expect(data.status).toBe("pending");
      expect(data.run_id).toBe("001");
      expect(data.created_artifacts).toContain("brief");
      expect(data.created_artifacts).toContain("plan");

      // task_dir should point to the run directory
      const expectedRunDir = join(tmpDir, "spec-task", "test-task", "runs", "001");
      expect(data.task_dir).toBe(expectedRunDir);

      // Task root should have brief.md and plan.md
      const taskRoot = join(tmpDir, "spec-task", "test-task");
      expect(existsSync(join(taskRoot, "brief.md"))).toBe(true);
      expect(existsSync(join(taskRoot, "plan.md"))).toBe(true);

      // Run directory should have status.yaml
      expect(existsSync(join(expectedRunDir, "status.yaml"))).toBe(true);

      // Verify status.yaml content
      const statusContent = readFileSync(join(expectedRunDir, "status.yaml"), "utf-8");
      const statusData = YAML.parse(statusContent);
      expect(statusData.task_id).toBe("test-task");
      expect(statusData.title).toBe("Test Task");
      expect(statusData.assigned_to).toBe("agent-1");
      expect(statusData.status).toBe("pending");
      expect(statusData.run_id).toBe("001");
      expect(statusData.steps).toEqual([]);
      expect(statusData.revisions).toHaveLength(1);
      expect(statusData.revisions[0].type).toBe("created");
    });

    it("should create task with only brief (no plan)", async () => {
      const result = await executeTaskCreate("tc-2", {
        task_name: "test-task-2",
        project_root: tmpDir,
        brief: "## 目标\n简要目标",
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.created_artifacts).toContain("brief");
      expect(data.created_artifacts).not.toContain("plan");

      const taskRoot = resolveTaskRoot("test-task-2", tmpDir);
      expect(existsSync(join(taskRoot, "brief.md"))).toBe(true);
      expect(existsSync(join(taskRoot, "plan.md"))).toBe(false);
    });

    it("should default title to task_name when not provided", async () => {
      const result = await executeTaskCreate("tc-3", {
        task_name: "my-feature",
        project_root: tmpDir,
        brief: "## 目标\n完成功能",
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);

      const runDir = join(tmpDir, "spec-task", "my-feature", "runs", "001");
      const statusContent = readFileSync(join(runDir, "status.yaml"), "utf-8");
      const statusData = YAML.parse(statusContent);
      expect(statusData.title).toBe("my-feature");
    });
  });

  // ============================================================================
  // 场景 4：新任务无 brief → 错误
  // ============================================================================

  describe("error: no brief for new task", () => {
    it("should return error when creating new task without brief", async () => {
      const result = await executeTaskCreate("tc-4", {
        task_name: "test-task-no-brief",
        project_root: tmpDir,
        plan: "## 步骤\n1. 做事",
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_PARAMS");
      expect(data.message).toContain("brief is required for new task");

      // Nothing should be created
      expect(existsSync(join(tmpDir, "spec-task", "test-task-no-brief"))).toBe(false);
    });
  });

  // ============================================================================
  // 场景 2：任务存在 + 所有 runs 终态 → 创建新 run
  // ============================================================================

  describe("creating a new run for existing task", () => {
    it("should create runs/002/ when runs/001/ is terminal", async () => {
      // Setup: existing task with terminal run
      const taskRoot = resolveTaskRoot("test-task-recreate", tmpDir);
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "brief.md"), "## 旧目标", "utf-8");
      writeFileSync(join(taskRoot, "plan.md"), "## 旧计划", "utf-8");
      writeTerminalRunStatus(taskRoot, "001", "completed");

      const result = await executeTaskCreate("tc-5", {
        task_name: "test-task-recreate",
        project_root: tmpDir,
        brief: "## 新目标\n更新后的目标",
        plan: "## 新计划\n更新后的计划",
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.run_id).toBe("002");
      expect(data.created_artifacts).toContain("brief");
      expect(data.created_artifacts).toContain("plan");

      // task_dir should point to runs/002/
      const expectedRunDir = join(taskRoot, "runs", "002");
      expect(data.task_dir).toBe(expectedRunDir);

      // Both run directories should exist
      expect(existsSync(join(taskRoot, "runs", "001", "status.yaml"))).toBe(true);
      expect(existsSync(join(taskRoot, "runs", "002", "status.yaml"))).toBe(true);

      // brief.md and plan.md should be updated in task root
      const briefContent = readFileSync(join(taskRoot, "brief.md"), "utf-8");
      expect(briefContent).toContain("新目标");

      const planContent = readFileSync(join(taskRoot, "plan.md"), "utf-8");
      expect(planContent).toContain("新计划");

      // New run status.yaml should have correct data
      const statusContent = readFileSync(join(expectedRunDir, "status.yaml"), "utf-8");
      const statusData = YAML.parse(statusContent);
      expect(statusData.run_id).toBe("002");
      expect(statusData.status).toBe("pending");
      expect(statusData.revisions[0].summary).toContain("New run 002");
    });

    it("should allow re-creating without brief/plan (keep existing artifacts)", async () => {
      const taskRoot = resolveTaskRoot("test-task-no-update", tmpDir);
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "brief.md"), "## 原始目标", "utf-8");
      writeTerminalRunStatus(taskRoot, "001", "failed");

      const result = await executeTaskCreate("tc-6", {
        task_name: "test-task-no-update",
        project_root: tmpDir,
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.run_id).toBe("002");
      expect(data.created_artifacts).toEqual([]);

      // brief.md should remain unchanged
      const briefContent = readFileSync(join(taskRoot, "brief.md"), "utf-8");
      expect(briefContent).toContain("原始目标");
    });

    it("should handle multiple terminal runs and create next sequential ID", async () => {
      const taskRoot = resolveTaskRoot("test-task-multi", tmpDir);
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "brief.md"), "## 目标", "utf-8");
      writeTerminalRunStatus(taskRoot, "001", "completed");
      writeTerminalRunStatus(taskRoot, "002", "failed");

      const result = await executeTaskCreate("tc-7", {
        task_name: "test-task-multi",
        project_root: tmpDir,
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.run_id).toBe("003");
      expect(existsSync(join(taskRoot, "runs", "003", "status.yaml"))).toBe(true);
    });
  });

  // ============================================================================
  // 场景 3：任务存在 + 有活跃 runs → 错误
  // ============================================================================

  describe("error: task has active runs", () => {
    it("should return error when task has active runs", async () => {
      const taskRoot = resolveTaskRoot("test-task-active", tmpDir);
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "brief.md"), "## 目标", "utf-8");
      writeTerminalRunStatus(taskRoot, "001", "running");

      const result = await executeTaskCreate("tc-8", {
        task_name: "test-task-active",
        project_root: tmpDir,
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(false);
      expect(data.error).toBe("TASK_HAS_ACTIVE_RUNS");
      expect(data.message).toContain("active");
      expect(data.message).toContain("001");

      // No new run should be created
      expect(existsSync(join(taskRoot, "runs", "002"))).toBe(false);
    });

    it("should return error when task has pending run", async () => {
      const taskRoot = resolveTaskRoot("test-task-pending", tmpDir);
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "brief.md"), "## 目标", "utf-8");
      writeTerminalRunStatus(taskRoot, "001", "pending");

      const result = await executeTaskCreate("tc-9", {
        task_name: "test-task-pending",
        project_root: tmpDir,
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(false);
      expect(data.error).toBe("TASK_HAS_ACTIVE_RUNS");
    });

    it("should list all active runs in error message", async () => {
      const taskRoot = resolveTaskRoot("test-task-multi-active", tmpDir);
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "brief.md"), "## 目标", "utf-8");
      writeTerminalRunStatus(taskRoot, "001", "running");
      writeTerminalRunStatus(taskRoot, "002", "blocked");

      const result = await executeTaskCreate("tc-10", {
        task_name: "test-task-multi-active",
        project_root: tmpDir,
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(false);
      expect(data.message).toContain("001");
      expect(data.message).toContain("002");
    });
  });

  // ============================================================================
  // 参数校验
  // ============================================================================

  describe("parameter validation", () => {
    it("should return error for empty task_name", async () => {
      const result = await executeTaskCreate("tc-11", {
        task_name: "",
        project_root: tmpDir,
        brief: "## 目标",
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_PARAMS");
    });

    it("should return error for task_name with illegal characters", async () => {
      const result = await executeTaskCreate("tc-12", {
        task_name: "task/name",
        project_root: tmpDir,
        brief: "## 目标",
      });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_PARAMS");
    });
  });
});
