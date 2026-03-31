import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeTaskArchive } from "../../src/tools/task-archive.js";
import type { TaskStatusData } from "../../src/types.js";

describe("executeTaskArchive", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "task-archive-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTask(statusData: Partial<TaskStatusData> = {}): string {
    const taskDir = join(tmpDir, "test-task");
    mkdirSync(taskDir, { recursive: true });

    const data: TaskStatusData = {
      task_id: "test-task",
      title: "Test Task",
      created: "2026-03-29T00:00:00.000Z",
      updated: "2026-03-29T12:00:00.000Z",
      status: "completed",
      assigned_to: "agent-1",
      started_at: "2026-03-29T01:00:00.000Z",
      completed_at: "2026-03-29T12:00:00.000Z",
      progress: { total: 5, completed: 5, skipped: 0, current_step: "", percentage: 100 },
      children: [],
      outputs: ["/path/to/output.txt"],
      steps: [],
      timing: { elapsed_minutes: 660 },
      errors: [],
      alerts: [],
      blocked_by: [],
      verification: { status: "passed", criteria: [], verified_at: "2026-03-29T12:00:00.000Z", verified_by: "agent-1" },
      revisions: [],
      ...statusData,
    };

    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
    return taskDir;
  }

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  it("should return plan without writing files in dry_run mode", async () => {
    const taskDir = createTask();
    const result = await executeTaskArchive("t-1", {
      task_dir: taskDir,
      agent_workspace: tmpDir,
      dry_run: true,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.dry_run).toBe(true);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].status).toBe("planned");
    expect(data.results[1].status).toBe("planned");

    // 确认文件未被创建
    expect(existsSync(join(tmpDir, "memory", "task-history", "2026-03-29", "test-task.md"))).toBe(false);
    expect(existsSync(join(tmpDir, "memory", "task-lessons", "test-task.md"))).toBe(false);
  });

  it("should create history and lessons files on full archive", async () => {
    const taskDir = createTask();
    const result = await executeTaskArchive("t-2", {
      task_dir: taskDir,
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.dry_run).toBe(false);
    expect(data.results).toHaveLength(2);

    // 验证历史文件
    const historyFile = join(tmpDir, "memory", "task-history", "2026-03-29", "test-task.md");
    expect(existsSync(historyFile)).toBe(true);
    const historyContent = readFileSync(historyFile, "utf-8");
    expect(historyContent).toContain("test-task");
    expect(historyContent).toContain("completed");
    expect(data.results[0].status).toBe("created");

    // 验证经验教训文件
    const lessonsFile = join(tmpDir, "memory", "task-lessons", "test-task.md");
    expect(existsSync(lessonsFile)).toBe(true);
    const lessonsContent = readFileSync(lessonsFile, "utf-8");
    expect(lessonsContent).toContain("Lessons");
    expect(data.results[1].status).toBe("created");
  });

  it("should skip history file if it already exists", async () => {
    const taskDir = createTask();

    // 预先创建历史文件
    const historyDir = join(tmpDir, "memory", "task-history", "2026-03-29");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, "test-task.md"), "existing content\n", "utf-8");

    const result = await executeTaskArchive("t-3", {
      task_dir: taskDir,
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results[0].status).toBe("already_exists");

    // 原内容不被覆盖
    const content = readFileSync(join(historyDir, "test-task.md"), "utf-8");
    expect(content).toBe("existing content\n");
  });

  it("should append to existing lessons file", async () => {
    const taskDir = createTask();

    // 预先创建 lessons 文件
    const lessonsDir = join(tmpDir, "memory", "task-lessons");
    mkdirSync(lessonsDir, { recursive: true });
    writeFileSync(join(lessonsDir, "test-task.md"), "Previous lessons.\n", "utf-8");

    const result = await executeTaskArchive("t-4", {
      task_dir: taskDir,
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results[1].status).toBe("appended");

    // 验证内容追加
    const content = readFileSync(join(lessonsDir, "test-task.md"), "utf-8");
    expect(content).toContain("Previous lessons");
    expect(content).toContain("---");
    expect(content).toContain("Lessons:");
  });

  it("should allow archiving non-terminal status tasks", async () => {
    // 非终态（running）也应该能归档
    const taskDir = createTask({ status: "running" });
    const result = await executeTaskArchive("t-5", {
      task_dir: taskDir,
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results.length).toBe(2);
    expect(data.results[0].status).toBe("created");

    const historyFile = join(tmpDir, "memory", "task-history", "2026-03-29", "test-task.md");
    const content = readFileSync(historyFile, "utf-8");
    expect(content).toContain("running");
  });

  it("should return TASK_NOT_FOUND for nonexistent task_dir", async () => {
    const result = await executeTaskArchive("t-6", {
      task_dir: "/nonexistent/task",
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("should include task details in history content", async () => {
    const taskDir = createTask({
      assigned_to: "agent-special",
      outputs: ["/out/report.html", "/out/data.json"],
      progress: { total: 10, completed: 8, skipped: 0, current_step: "9.1", percentage: 80 },
    });

    await executeTaskArchive("t-7", {
      task_dir: taskDir,
      agent_workspace: tmpDir,
    });

    const historyFile = join(tmpDir, "memory", "task-history", "2026-03-29", "test-task.md");
    const content = readFileSync(historyFile, "utf-8");

    expect(content).toContain("agent-special");
    expect(content).toContain("/out/report.html");
    expect(content).toContain("/out/data.json");
    expect(content).toContain("10");
    expect(content).toContain("8");
    expect(content).toContain("80%");
  });

  it("should include errors in history content", async () => {
    const taskDir = createTask({
      status: "failed",
      errors: [
        { step: "build", message: "TypeScript compilation error", retry_count: 3, timestamp: "2026-03-29T10:00:00.000Z" },
      ],
    });

    await executeTaskArchive("t-8", {
      task_dir: taskDir,
      agent_workspace: tmpDir,
    });

    const historyFile = join(tmpDir, "memory", "task-history", "2026-03-29", "test-task.md");
    const content = readFileSync(historyFile, "utf-8");

    expect(content).toContain("Errors");
    expect(content).toContain("build");
    expect(content).toContain("TypeScript compilation error");
    expect(content).toContain("retry#3");
  });

  it("should use agent_workspace parameter for output path", async () => {
    const taskDir = createTask();
    const customWorkspace = join(tmpDir, "my-workspace");

    await executeTaskArchive("t-9", {
      task_dir: taskDir,
      agent_workspace: customWorkspace,
    });

    const historyFile = join(customWorkspace, "memory", "task-history", "2026-03-29", "test-task.md");
    expect(existsSync(historyFile)).toBe(true);

    const lessonsFile = join(customWorkspace, "memory", "task-lessons", "test-task.md");
    expect(existsSync(lessonsFile)).toBe(true);
  });

  it("should default agent_workspace to cwd when not provided", async () => {
    const taskDir = createTask();

    // 不传 agent_workspace，默认 cwd
    const result = await executeTaskArchive("t-10", {
      task_dir: taskDir,
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    // cwd 下应该创建了文件（cwd 可能和 tmpDir 不同，但操作不应报错）
    expect(data.results.length).toBe(2);
  });

  it("should use (no brief) when brief.md does not exist", async () => {
    const taskDir = createTask();
    // 不创建 brief.md

    await executeTaskArchive("t-11", {
      task_dir: taskDir,
      agent_workspace: tmpDir,
    });

    const historyFile = join(tmpDir, "memory", "task-history", "2026-03-29", "test-task.md");
    const content = readFileSync(historyFile, "utf-8");

    // 没有 brief 时使用 title
    expect(content).toContain("Test Task");
  });

  it("should generate lessons file without errors section when no errors", async () => {
    const taskDir = createTask({ errors: [], blocked_by: [] });

    await executeTaskArchive("t-12", {
      task_dir: taskDir,
      agent_workspace: tmpDir,
    });

    const lessonsFile = join(tmpDir, "memory", "task-lessons", "test-task.md");
    const content = readFileSync(lessonsFile, "utf-8");

    expect(content).toContain("Lessons:");
    expect(content).toContain("test-task");
    // 没有 errors 时不应包含 "Errors Encountered"
    expect(content).not.toContain("Errors Encountered");
    expect(content).not.toContain("Blockers");
  });
});
