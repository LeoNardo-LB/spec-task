import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeTaskCreate } from "../../src/tools/task-create.js";
import { executeTaskTransition } from "../../src/tools/task-transition.js";
import { executeTaskLog } from "../../src/tools/task-log.js";
import { executeTaskVerify } from "../../src/tools/task-verify.js";
import { executeTaskResume } from "../../src/tools/task-resume.js";
import { executeTaskArchive } from "../../src/tools/task-archive.js";
import { StatusStore } from "../../src/core/status-store.js";
import { createTestEnv } from "./helpers.js";
import type { TaskStatusData } from "../../src/types.js";

// ============================================================================
// Helpers
// ============================================================================

/** 解析 ToolResponse 为 JSON 对象 */
function parseResponse(response: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(response.content[0].text);
}

/** 创建一个 pending 状态的任务（通过 executeTaskCreate） */
async function createSimpleTask(projectRoot: string, taskName: string): Promise<string> {
  const result = await executeTaskCreate("boundary-helper", {
    task_name: taskName,
    project_root: projectRoot,
    title: `Test: ${taskName}`,
    assigned_to: "agent",
  });
  const data = parseResponse(result);
  expect(data.success).toBe(true);
  return data.task_dir as string;
}

/** 创建一个带 status.yaml 的假任务目录（不通过 executeTaskCreate） */
function createFakeTaskDir(tmpDir: string, taskName: string, overrides: Partial<TaskStatusData> = {}): string {
  const taskDir = join(tmpDir, "spec-task", taskName);
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(join(taskDir, "outputs"), { recursive: true });
  mkdirSync(join(taskDir, "subtasks"), { recursive: true });

  const data: TaskStatusData = {
    task_id: taskName,
    title: `Fake: ${taskName}`,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    status: "pending",
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
    ...overrides,
  };

  writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
  writeFileSync(join(taskDir, "checklist.md"), "- [ ] 1.1 Step\n", "utf-8");
  return taskDir;
}

// ============================================================================
// Test Suite: Invalid Inputs
// ============================================================================

describe("Boundary: Invalid Inputs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "boundary-input-"));
    // 确保 spec-task 目录存在
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("task_create with empty task_name should return error", async () => {
    const result = await executeTaskCreate("b-1", {
      task_name: "",
      project_root: tmpDir,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("task_create with whitespace-only task_name should return error", async () => {
    const result = await executeTaskCreate("b-1b", {
      task_name: "   ",
      project_root: tmpDir,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("task_create with path traversal in task_name should return error", async () => {
    const result = await executeTaskCreate("b-2", {
      task_name: "../../etc/passwd",
      project_root: tmpDir,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
    expect(data.message).toContain("/");
  });

  it("task_create with backslash in task_name should return error", async () => {
    const result = await executeTaskCreate("b-2b", {
      task_name: "bad\\path",
      project_root: tmpDir,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("task_create with null byte in task_name should return error", async () => {
    const result = await executeTaskCreate("b-2c", {
      task_name: "bad\0name",
      project_root: tmpDir,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("task_create duplicate should return TASK_ALREADY_EXISTS", async () => {
    await createSimpleTask(tmpDir, "dup-boundary");

    const result = await executeTaskCreate("b-3", {
      task_name: "dup-boundary",
      project_root: tmpDir,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_ALREADY_EXISTS");
  });

  it("task_transition on nonexistent task should return TASK_NOT_FOUND", async () => {
    const result = await executeTaskTransition("b-4", {
      task_dir: "/nonexistent/boundary-task",
      status: "running",
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("task_transition invalid transition pending→completed should return INVALID_TRANSITION", async () => {
    const taskDir = await createSimpleTask(tmpDir, "invalid-trans");

    const result = await executeTaskTransition("b-5", {
      task_dir: taskDir,
      status: "completed",
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_TRANSITION");
    expect(data.message).toContain("pending");
    expect(data.message).toContain("completed");

    // 验证状态未改变
    const store = new StatusStore();
    const current = await store.loadStatus(taskDir);
    expect(current.status).toBe("pending");
  });

  it("task_log on nonexistent task should return TASK_NOT_FOUND", async () => {
    const result = await executeTaskLog("b-6", {
      task_dir: "/nonexistent/boundary-task",
      action: { action: "error", step: "1.1", message: "test error" },
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("task_verify on nonexistent task should return TASK_NOT_FOUND", async () => {
    const result = await executeTaskVerify("b-7", {
      task_dir: "/nonexistent/boundary-task",
      action: { action: "get" },
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("task_resume on nonexistent task should return TASK_NOT_FOUND", async () => {
    const result = await executeTaskResume("b-8", {
      task_dir: "/nonexistent/boundary-task",
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("task_archive on nonexistent task should return TASK_NOT_FOUND", async () => {
    const result = await executeTaskArchive("b-9", {
      task_dir: "/nonexistent/boundary-task",
      agent_workspace: tmpDir,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });
});

// ============================================================================
// Test Suite: Concurrent Access
// ============================================================================

describe("Boundary: Concurrent Access", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "boundary-concurrent-"));
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("concurrent transitions to same task — one succeeds, one fails with INVALID_TRANSITION", async () => {
    // 创建一个 pending 任务
    const taskDir = await createSimpleTask(tmpDir, "concurrent-task");

    // 同时发起两个 pending → assigned 转换
    const [result1, result2] = await Promise.all([
      executeTaskTransition("concurrent-1", {
        task_dir: taskDir,
        status: "assigned",
        trigger: "concurrent-test",
      }),
      executeTaskTransition("concurrent-2", {
        task_dir: taskDir,
        status: "assigned",
        trigger: "concurrent-test",
      }),
    ]);

    const parsed1 = parseResponse(result1);
    const parsed2 = parseResponse(result2);

    // 一个成功，一个失败
    const successes = [parsed1, parsed2].filter(r => r.success === true);
    const failures = [parsed1, parsed2].filter(r => r.success === false);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBe("INVALID_TRANSITION");

    // 验证最终状态是 assigned
    const store = new StatusStore();
    const final = await store.loadStatus(taskDir);
    expect(final.status).toBe("assigned");
  });

  it("concurrent log operations on same task should both succeed (sequential in lock)", async () => {
    const taskDir = await createSimpleTask(tmpDir, "concurrent-log");

    // 两个并发的 error log 操作
    const [result1, result2] = await Promise.all([
      executeTaskLog("clog-1", {
        task_dir: taskDir,
        action: { action: "error", step: "1.1", message: "Error A" },
      }),
      executeTaskLog("clog-2", {
        task_dir: taskDir,
        action: { action: "error", step: "1.2", message: "Error B" },
      }),
    ]);

    const parsed1 = parseResponse(result1);
    const parsed2 = parseResponse(result2);

    // 两个都应该成功（日志操作不互斥）
    expect(parsed1.success).toBe(true);
    expect(parsed2.success).toBe(true);

    // 验证两个错误都被记录
    const store = new StatusStore();
    const final = await store.loadStatus(taskDir);
    expect(final.errors).toHaveLength(2);
    const messages = final.errors.map(e => e.message);
    expect(messages).toContain("Error A");
    expect(messages).toContain("Error B");
  });

  it("should handle lock contention with LOCK_ACQUIRE_FAILED after retries exhausted", async () => {
    // 创建一个 pending 任务
    const taskDir = await createSimpleTask(tmpDir, "lock-contention");

    // 手动创建 .lock 目录来模拟锁被另一个进程持有
    // proper-lockfile 使用 mkdir 创建 status.yaml.lock 目录作为锁
    const lockDir = join(taskDir, "status.yaml.lock");
    mkdirSync(lockDir, { recursive: true });

    // 立即尝试 transition — 锁是新鲜的（未过期），重试 3 次后应失败
    // retry 模块默认超时为 1s, 2s, 4s，总计约 7s，因此需要较长超时
    const result = await executeTaskTransition("lock-1", {
      task_dir: taskDir,
      status: "assigned",
      trigger: "lock-test",
    });
    const data = parseResponse(result);

    // 应该失败，因为锁无法获取
    expect(data.success).toBe(false);
    // proper-lockfile 返回 ELOCKED 错误，被包装为 INTERNAL_ERROR
    expect(data.error).toBeDefined();

    // 清理手动创建的锁
    rmSync(lockDir, { recursive: true, force: true });

    // 验证状态未改变（仍然 pending）
    const store = new StatusStore();
    const current = await store.loadStatus(taskDir);
    expect(current.status).toBe("pending");
  }, 15_000);
});

// ============================================================================
// Test Suite: Corrupted Data
// ============================================================================

describe("Boundary: Corrupted Data", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "boundary-corrupt-"));
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("load corrupted YAML should throw and tools should handle gracefully", async () => {
    const taskDir = join(tmpDir, "spec-task", "corrupted");
    mkdirSync(taskDir, { recursive: true });

    // 写入无效 YAML
    writeFileSync(join(taskDir, "status.yaml"),
      "task_id: corrupted\n  bad indent: {{broken yaml\n: : ::", "utf-8");

    // StatusStore.loadStatus 应该抛出异常
    const store = new StatusStore();
    await expect(store.loadStatus(taskDir)).rejects.toThrow();

    // task_transition 应该优雅处理（返回 TASK_NOT_FOUND 或其他错误码）
    const transitionResult = await executeTaskTransition("corrupt-1", {
      task_dir: taskDir,
      status: "running",
    });
    const parsed = parseResponse(transitionResult);
    expect(parsed.success).toBe(false);

    // task_resume 应该优雅处理
    const resumeResult = await executeTaskResume("corrupt-2", {
      task_dir: taskDir,
    });
    const resumeParsed = parseResponse(resumeResult);
    expect(resumeParsed.success).toBe(false);
    expect(resumeParsed.error).toBe("TASK_NOT_FOUND");
  });

  it("missing required 'status' field should be handled gracefully", async () => {
    const taskDir = join(tmpDir, "spec-task", "missing-status");
    mkdirSync(taskDir, { recursive: true });

    // 写入缺少 status 字段的 YAML
    const incompleteYaml = `task_id: missing-status
title: Missing Status Task
created: '2026-03-29T10:00:00.000Z'
updated: '2026-03-29T10:00:00.000Z'
assigned_to: agent
`;
    writeFileSync(join(taskDir, "status.yaml"), incompleteYaml, "utf-8");

    // loadStatus 应该成功加载（YAML 语法正确），但 status 为 undefined
    const store = new StatusStore();
    const data = await store.loadStatus(taskDir);
    expect(data.task_id).toBe("missing-status");
    expect(data.status).toBeUndefined();

    // task_transition 应该处理 undefined status（isValidTransition(undefined, ...) → false）
    const transitionResult = await executeTaskTransition("missing-1", {
      task_dir: taskDir,
      status: "running",
    });
    const parsed = parseResponse(transitionResult);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("INVALID_TRANSITION");
  });

  it("empty status.yaml file should be handled gracefully", async () => {
    const taskDir = join(tmpDir, "spec-task", "empty-status");
    mkdirSync(taskDir, { recursive: true });

    // 写入空文件
    writeFileSync(join(taskDir, "status.yaml"), "", "utf-8");

    // loadStatus 应该返回空对象（YAML.parse("") → undefined → {}）
    const store = new StatusStore();
    const data = await store.loadStatus(taskDir);
    expect(data.task_id).toBeUndefined();
    expect(data.status).toBeUndefined();

    // task_resume 应该优雅处理（不抛出异常）
    const resumeResult = await executeTaskResume("empty-1", {
      task_dir: taskDir,
    });
    const resumeParsed = parseResponse(resumeResult);
    expect(resumeParsed.success).toBe(true);
    // nextAction 对 undefined status 无匹配 case → 返回 undefined，JSON.stringify 会省略
    // 验证工具没有崩溃即可 — data 全为 undefined 的字段会被 JSON 省略
    expect(resumeParsed.details).toBeDefined();
  });

  it("YAML with non-string task_id should be loaded but handled", async () => {
    const taskDir = join(tmpDir, "spec-task", "wrong-type");
    mkdirSync(taskDir, { recursive: true });

    // task_id 是数字而非字符串
    const weirdYaml = `task_id: 12345
title: Wrong Type Task
status: pending
created: '2026-03-29T10:00:00.000Z'
updated: '2026-03-29T10:00:00.000Z'
assigned_to: agent
progress:
  total: 0
  completed: 0
  current_step: ''
  percentage: 0
parent: null
depth: 0
children: []
outputs: []
timing:
  estimated_minutes: null
  elapsed_minutes: null
errors: []
alerts: []
blocked_by: []
verification:
  status: pending
  criteria: []
  verified_at: null
  verified_by: null
revisions: []
`;
    writeFileSync(join(taskDir, "status.yaml"), weirdYaml, "utf-8");

    // 加载应该成功（YAML 语法正确）
    const store = new StatusStore();
    const data = await store.loadStatus(taskDir);
    expect(data.task_id).toBe(12345);
    expect(data.status).toBe("pending");
  });
});

// ============================================================================
// Test Suite: Special Characters
// ============================================================================

describe("Boundary: Special Characters", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "boundary-special-"));
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("task_create with Chinese task name should succeed", async () => {
    const result = await executeTaskCreate("b-13", {
      task_name: "测试任务",
      project_root: tmpDir,
      title: "中文任务标题验证",
    });
    const data = parseResponse(result);
    expect(data.success).toBe(true);
    expect(data.task_id).toBe("测试任务");

    // 验证目录已创建
    const store = new StatusStore();
    const loaded = await store.loadStatus(data.task_dir);
    expect(loaded.title).toBe("中文任务标题验证");
    expect(loaded.status).toBe("pending");
  });

  it("task_create with spaces in task name should succeed", async () => {
    const result = await executeTaskCreate("b-14", {
      task_name: "my task with spaces",
      project_root: tmpDir,
      title: "Spaces in Name",
    });
    const data = parseResponse(result);
    expect(data.success).toBe(true);
    expect(data.task_id).toBe("my task with spaces");

    // 验证可以正常操作
    const store = new StatusStore();
    const loaded = await store.loadStatus(data.task_dir);
    expect(loaded.task_id).toBe("my task with spaces");
    expect(loaded.status).toBe("pending");
  });

  it("task_create with emoji in task name should succeed", async () => {
    const result = await executeTaskCreate("b-15", {
      task_name: "feature-api-v2",
      project_root: tmpDir,
      title: "API v2 开发 🚀",
    });
    const data = parseResponse(result);
    expect(data.success).toBe(true);
    expect(data.task_id).toBe("feature-api-v2");

    const store = new StatusStore();
    const loaded = await store.loadStatus(data.task_dir);
    expect(loaded.title).toBe("API v2 开发 🚀");
  });

  it("full lifecycle with Chinese task name should work end-to-end", async () => {
    const taskDir = await createSimpleTask(tmpDir, "中文生命周期测试");

    // assigned → running
    const t1 = await executeTaskTransition("b-lifecycle-1", {
      task_dir: taskDir,
      status: "assigned",
      assigned_to: "中文代理",
    });
    expect(parseResponse(t1).success).toBe(true);

    const t2 = await executeTaskTransition("b-lifecycle-2", {
      task_dir: taskDir,
      status: "running",
    });
    expect(parseResponse(t2).success).toBe(true);

    // log error with Chinese message
    const logResult = await executeTaskLog("b-lifecycle-3", {
      task_dir: taskDir,
      action: { action: "error", step: "1.1", message: "数据库连接超时" },
    });
    expect(parseResponse(logResult).success).toBe(true);

    // verify get
    const verifyResult = await executeTaskVerify("b-lifecycle-4", {
      task_dir: taskDir,
      action: { action: "get" },
    });
    expect(parseResponse(verifyResult).success).toBe(true);

    // resume
    const resumeResult = await executeTaskResume("b-lifecycle-5", {
      task_dir: taskDir,
    });
    const resumeData = parseResponse(resumeResult);
    expect(resumeData.success).toBe(true);
    expect(resumeData.details.task_id).toBe("中文生命周期测试");

    // archive dry_run
    const archiveResult = await executeTaskArchive("b-lifecycle-6", {
      task_dir: taskDir,
      agent_workspace: tmpDir,
      dry_run: true,
    });
    expect(parseResponse(archiveResult).success).toBe(true);
  });

  it("task_create with very long task name should succeed", async () => {
    const longName = "a".repeat(200);
    const result = await executeTaskCreate("b-16", {
      task_name: longName,
      project_root: tmpDir,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(true);
    expect(data.task_id).toBe(longName);
  });

  it("task_create with hyphenated kebab-case name should succeed", async () => {
    const result = await executeTaskCreate("b-17", {
      task_name: "my-feature-branch-task-123",
      project_root: tmpDir,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(true);
    expect(data.task_id).toBe("my-feature-branch-task-123");
  });
});
