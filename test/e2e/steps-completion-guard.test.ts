import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { checkTransitionBlocked, checkVerificationBlocked, checkVerifyFinalizeBlocked } from "../../src/core/steps-utils.js";

/**
 * Steps Completion Guard 集成测试。
 *
 * 测试 before_tool_call hook 的拦截逻辑（index.ts 第83-103行）。
 * 由于 handler 在 definePluginEntry 闭包内无法直接 import，
 * 这里通过模拟 handler 逻辑 + 调用真实的 checkTransitionBlocked 来验证集成行为。
 *
 * 测试策略参考：
 * - Redux Middleware 测试：创建 fake dispatch/getState/next，验证 middleware 行为
 * - NestJS Guard 测试：直接测试 Guard.canActivate 的纯逻辑
 */

describe("Steps Completion Guard Integration (before_tool_call hook)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "guard-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * 模拟 index.ts 中 before_tool_call handler 的拦截逻辑。
   * 这是 handler 核心逻辑的 1:1 复制（不含 project_root 注入）。
   */
  async function simulateHookHandler(event: { toolName: string; params?: Record<string, any> }): Promise<{ block?: boolean; blockReason?: string } | undefined> {
    if (event.toolName === "task_transition" && event.params?.status === "completed") {
      const taskDir = event.params?.task_dir;
      if (taskDir) {
        const blocked = checkTransitionBlocked(taskDir);
        if (blocked) {
          return { block: true, blockReason: blocked.blockReason };
        }
        const verifyBlocked = checkVerificationBlocked(taskDir);
        if (verifyBlocked) {
          return { block: true, blockReason: verifyBlocked.blockReason };
        }
      }
    }
    // ── Verification finalize 空标准拦截 ──
    if (event.toolName === "task_verify" && event.params?.action?.action === "finalize") {
      const taskDir = event.params?.task_dir;
      if (taskDir) {
        const verifyFinalizeBlocked = checkVerifyFinalizeBlocked(taskDir);
        if (verifyFinalizeBlocked) {
          return { block: true, blockReason: verifyFinalizeBlocked.blockReason };
        }
      }
    }
    return undefined; // 不拦截
  }

  function createTaskDirWithSteps(steps: Array<{ id: string; status: string }>, verifStatus?: string, criteria?: Array<{ result: string }>, configYaml?: string): string {
    const taskDir = join(tmpDir, "test-task");
    mkdirSync(taskDir, { recursive: true });
    const statusData = {
      task_id: "test-task",
      status: "running",
      verification: { status: verifStatus ?? "pending", criteria: criteria ?? [], verified_at: null, verified_by: null },
      steps: steps.map(s => ({
        id: s.id,
        summary: { title: `Step ${s.id}`, content: "", approach: "", sources: [] },
        status: s.status,
        completed_at: s.status !== "pending" ? "2026-03-29T12:00:00.000Z" : null,
        tags: [],
      })),
    };
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(statusData), "utf-8");
    if (configYaml) {
      writeFileSync(join(taskDir, "config.yaml"), configYaml, "utf-8");
    }
    return taskDir;
  }

  // ── Task 4.3: steps 为空时 task_transition(completed) 被阻止 ──
  it("should block task_transition(completed) when steps are empty", async () => {
    const taskDir = createTaskDirWithSteps([]);
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toEqual({ block: true, blockReason: expect.stringContaining("没有步骤数据") });
  });

  // ── Task 4.4: steps 部分完成时被阻止并列出未完成步骤 ──
  it("should block task_transition(completed) when steps are partially completed", async () => {
    const taskDir = createTaskDirWithSteps([
      { id: "1.1", status: "completed" },
      { id: "1.2", status: "pending" },
      { id: "2.1", status: "running" },
    ]);
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toEqual({ block: true, blockReason: expect.stringContaining("2 个步骤未完成") });
    expect(result!.blockReason).toContain("1.2");
    expect(result!.blockReason).toContain("2.1");
  });

  // ── Task 4.5: steps 全 skipped 时正常放行 ──
  it("should NOT block task_transition(completed) when all steps are skipped", async () => {
    const taskDir = createTaskDirWithSteps([
      { id: "1.1", status: "skipped" },
      { id: "1.2", status: "skipped" },
    ], "passed", [{ result: "passed" }]);
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toBeUndefined();
  });

  // ── 补充: steps 全 completed 时正常放行 ──
  it("should NOT block task_transition(completed) when all steps are completed", async () => {
    const taskDir = createTaskDirWithSteps([
      { id: "1.1", status: "completed" },
      { id: "1.2", status: "completed" },
    ], "passed", [{ result: "passed" }]);
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toBeUndefined();
  });

  // ── 补充: 非 completed 转换不受影响 ──
  it("should NOT block task_transition(running) regardless of steps", async () => {
    const taskDir = createTaskDirWithSteps([
      { id: "1.1", status: "pending" },
    ], "pending");
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "running" },
    });

    expect(result).toBeUndefined();
  });

  // ── 补充: 非 task_transition 工具不受影响 ──
  it("should NOT block other tools like task_log", async () => {
    const taskDir = createTaskDirWithSteps([], "pending");
    const result = await simulateHookHandler({
      toolName: "task_log",
      params: { task_dir: taskDir },
    });

    expect(result).toBeUndefined();
  });

  // ── 补充: task_dir 不存在时不阻止（让后续逻辑处理） ──
  it("should NOT block when task_dir does not exist", async () => {
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: "/nonexistent/task", status: "completed" },
    });

    expect(result).toBeUndefined();
  });

  // ── 补充: mixed completed+skipped 放行 ──
  it("should NOT block when steps are mixed completed and skipped", async () => {
    const taskDir = createTaskDirWithSteps([
      { id: "1.1", status: "completed" },
      { id: "1.2", status: "skipped" },
    ], "passed", [{ result: "passed" }]);
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════
  // Verification Guard 测试
  // ════════════════════════════════════════════════════════════════

  it("should block task_transition(completed) when verification is pending", async () => {
    const taskDir = createTaskDirWithSteps(
      [{ id: "1.1", status: "completed" }, { id: "1.2", status: "completed" }],
      "pending",
      [{ result: "passed" }, { result: "pending" }],
    );
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toEqual({ block: true, blockReason: expect.stringContaining("pending") });
    expect(result!.blockReason).toContain("1/2");
  });

  it("should NOT block task_transition(completed) when verification is passed", async () => {
    const taskDir = createTaskDirWithSteps(
      [{ id: "1.1", status: "completed" }],
      "passed",
      [{ result: "passed" }],
    );
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toBeUndefined();
  });

  it("should block task_transition(completed) when verification is failed", async () => {
    const taskDir = createTaskDirWithSteps(
      [{ id: "1.1", status: "completed" }],
      "failed",
      [{ result: "passed" }, { result: "failed" }],
    );
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toEqual({ block: true, blockReason: expect.stringContaining("failed") });
    expect(result!.blockReason).toContain("修正失败项");
  });

  it("should NOT block when requires_verification is false", async () => {
    const taskDir = createTaskDirWithSteps(
      [{ id: "1.1", status: "completed" }],
      "pending",
      [],
      "completion:\n  requires_verification: false\n",
    );
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toBeUndefined();
  });

  it("should NOT check verification for non-completed transitions", async () => {
    const taskDir = createTaskDirWithSteps(
      [{ id: "1.1", status: "completed" }],
      "pending",
    );
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "failed" },
    });

    expect(result).toBeUndefined();
  });

  it("should block by steps check, NOT verification, when steps are incomplete", async () => {
    const taskDir = createTaskDirWithSteps(
      [{ id: "1.1", status: "pending" }],
      "pending",
    );
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toEqual({ block: true, blockReason: expect.stringContaining("步骤未完成") });
    // steps check should fire first, NOT verification check
    expect(result!.blockReason).not.toContain("验收");
  });

  it("should NOT block when steps completed + verification pending + requires_verification=false", async () => {
    const taskDir = createTaskDirWithSteps(
      [{ id: "1.1", status: "completed" }],
      "pending",
      [],
      "completion:\n  requires_verification: false\n",
    );
    const result = await simulateHookHandler({
      toolName: "task_transition",
      params: { task_dir: taskDir, status: "completed" },
    });

    expect(result).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════
  // task_verify(finalize) empty criteria guard (功能 B)
  // ════════════════════════════════════════════════════════════════

  describe("task_verify(finalize) empty criteria guard", () => {
    it("should block task_verify(finalize) when no criteria", async () => {
      const taskDir = createTaskDirWithSteps([{ id: "1.1", status: "completed" }], "pending");
      const result = await simulateHookHandler({
        toolName: "task_verify",
        params: { task_dir: taskDir, action: { action: "finalize" } },
      });
      expect(result).toEqual({ block: true, blockReason: expect.stringContaining("尚无验收标准") });
    });

    it("should NOT block task_verify(finalize) when criteria exist", async () => {
      const taskDir = createTaskDirWithSteps([{ id: "1.1", status: "completed" }], "pending", [{ result: "passed" }]);
      const result = await simulateHookHandler({
        toolName: "task_verify",
        params: { task_dir: taskDir, action: { action: "finalize" } },
      });
      expect(result).toBeUndefined();
    });

    it("should NOT block task_verify(get)", async () => {
      const taskDir = createTaskDirWithSteps([]);
      const result = await simulateHookHandler({
        toolName: "task_verify",
        params: { task_dir: taskDir, action: { action: "get" } },
      });
      expect(result).toBeUndefined();
    });

    it("should NOT block task_verify(add-criterion)", async () => {
      const taskDir = createTaskDirWithSteps([]);
      const result = await simulateHookHandler({
        toolName: "task_verify",
        params: { task_dir: taskDir, action: { action: "add-criterion", criterion: "test", result: "passed" } },
      });
      expect(result).toBeUndefined();
    });

    it("should NOT block task_verify(finalize) when task_dir missing", async () => {
      const result = await simulateHookHandler({
        toolName: "task_verify",
        params: { action: { action: "finalize" } },
      });
      expect(result).toBeUndefined();
    });
  });
});
