import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";

// 导出 truncateWithContext 用于单元测试
import { createPromptBuildHandler, truncateWithContext, getToneConfig, buildSubagentCompliance, buildWorkflowOverview, buildDirectoryStructure } from "../../src/hooks/before-prompt-build.js";
import type { ToneConfig } from "../../src/hooks/before-prompt-build.js";
import { Detector } from "../../src/detector.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/**
 * 从步骤数据生成对应的 steps 数组。
 * v0.3.0: steps 使用 summary: { title, content, approach, sources } 格式。
 */
function makeSteps(total: number, completed: number): Array<{ id: string; summary: { title: string; content: string; approach: string; sources: string[] }; status: string; completed_at: string | null; tags: string[] }> {
  const steps: Array<{ id: string; summary: { title: string; content: string; approach: string; sources: string[] }; status: string; completed_at: string | null; tags: string[] }> = [];
  const now = new Date().toISOString();
  for (let i = 1; i <= total; i++) {
    steps.push({
      id: `${i}.1`,
      summary: { title: `步骤 ${i}`, content: "", approach: "", sources: [] },
      status: i <= completed ? "completed" : "pending",
      completed_at: i <= completed ? now : null,
      tags: [],
    });
  }
  return steps;
}

/**
 * 更新 status.yaml 以包含 steps 数组。
 * hook 现在从 status.yaml.steps 读取进度，而不仅仅是从 checklist.md 解析。
 */
function updateStatusWithSteps(taskDir: string, total: number, completed: number): void {
  const statusPath = join(taskDir, "status.yaml");
  const content = readFileSync(statusPath, "utf-8");
  const data = YAML.parse(content) ?? {};
  data.steps = makeSteps(total, completed);
  writeFileSync(statusPath, YAML.stringify(data), "utf-8");
}

describe("createPromptBuildHandler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // L1 (none) — 无 spec-task 目录
  // =========================================================================

  it("should auto-initialize and return ready message for L1 (no spec-task directory)", async () => {
    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    expect(result).toHaveProperty("prependContext");
    // loadMergedConfig 内部会先调用 ensureProjectConfig 创建 spec-task/config.yaml，
    // 导致 detector 检测到 level="empty" 而非 "none"
    // empty 状态现在注入轻量引导（含 task_create 提示）和 prependSystemContext（STEPS_GUIDE）
    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("📋 无活跃任务。");
    expect(ctx).toContain("task_create");
    expect(result).toHaveProperty("prependSystemContext");
    expect((result as any).prependSystemContext).toContain("Steps 进度追踪规则");
    // 验证目录和 config.yaml 已创建
    expect(existsSync(join(tmpDir, "spec-task", "config.yaml"))).toBe(true);
  });

  it("should return empty object when auto-init fails for L1", async () => {
    // 使用一个不可写路径触发错误
    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    // 传入一个非目录路径，ensureProjectConfig 会失败
    const result = await handler({ cwd: "/nonexistent/path/that/does/not/exist" }, {});

    expect(result).toEqual({});
    expect(mockLogger.error).toHaveBeenCalled();
  });

  // =========================================================================
  // L2 (empty) — 空 spec-task 目录
  // =========================================================================

  it("should return no active tasks message for L2 (empty spec-task directory)", async () => {
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    expect(result).toHaveProperty("prependContext");
    // empty 状态现在注入轻量引导和 prependSystemContext
    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("📋 无活跃任务。");
    expect(ctx).toContain("task_create");
    expect(result).toHaveProperty("prependSystemContext");
    expect((result as any).prependSystemContext).toContain("Steps 进度追踪规则");
  });

  // =========================================================================
  // L3 (skeleton) — 有 status.yaml 但缺核心文档
  // =========================================================================

  it("should return skeleton warning for L3 (missing artifacts)", async () => {
    // Set tracking level to medium so brief is required
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
    writeFileSync(join(tmpDir, "spec-task", "config.yaml"), YAML.stringify({
      tracking: { level: "medium" },
    }), "utf-8");

    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "pending" }), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    expect(result).toHaveProperty("prependContext");
    const ctx = (result as any).prependContext;
    expect(ctx).toContain("task-1");
    // At medium tracking level, brief is required → missing brief
    expect(ctx).toContain("brief");
    expect(ctx).toContain("缺少构件文件");
    expect(ctx).toContain("请在下次 task_create 时传入完整内容");
  });

  it("should list all skeleton tasks in warning", async () => {
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
    writeFileSync(join(tmpDir, "spec-task", "config.yaml"), YAML.stringify({
      tracking: { level: "medium" },
    }), "utf-8");

    for (const name of ["task-a", "task-b"]) {
      const taskDir = join(tmpDir, "spec-task", name);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: name, status: "pending" }), "utf-8");
    }

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext;
    expect(ctx).toContain("task-a");
    expect(ctx).toContain("task-b");
  });

  it("should list missing artifact names in skeleton warning", async () => {
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
    writeFileSync(join(tmpDir, "spec-task", "config.yaml"), YAML.stringify({
      tracking: { level: "medium" },
    }), "utf-8");

    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    // Create brief.md → at medium level, brief is required and present → not skeleton
    writeFileSync(join(taskDir, "brief.md"), "# Brief", "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    // Task has brief.md → detected as in_progress (not skeleton)
    // Running task with no steps → no progress summary → returns {} (no prependContext)
    // The important assertion: prependContext should NOT contain "缺少构件文件"
    const ctx = (result as any).prependContext;
    if (ctx) {
      expect(ctx).not.toContain("缺少构件文件");
    }
    // If ctx is undefined (empty result), that's also correct — not skeleton
  });

  it("should include progress summary in L3 when running task has incomplete steps", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    writeFileSync(join(taskDir, "brief.md"), "# Brief", "utf-8");
    // v0.3.0: progress comes from steps in status.yaml, not from checklist.md
    updateStatusWithSteps(taskDir, 5, 2);

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext;
    // Task has brief + steps → in_progress, not skeleton
    expect(ctx).not.toContain("骨架");
    expect(ctx).toContain("当前进度");
    expect(ctx).toContain("2/5");
    expect(ctx).toContain("40%");
  });

  it("should include missing steps alert in L3 when running task has no steps", async () => {
    // 创建一个 running 状态的任务，缺少 steps 数据
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    writeFileSync(join(taskDir, "brief.md"), "# Brief", "utf-8");
    writeFileSync(join(taskDir, "spec.md"), "# Spec", "utf-8");
    writeFileSync(join(taskDir, "plan.md"), "# Plan", "utf-8");
    // v0.3.0: no steps in status.yaml → hasMissingChecklist = true
    // No runs/ directory → trySchemaDrivenStepsInjection returns null → fallback to MISSING_STEPS_ALERT

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    // Running task with no steps → fallback to MISSING_STEPS_ALERT
    expect(result).toBeDefined();
    expect((result as any).prependContext).toContain("steps_update");
    expect((result as any).prependSystemContext).toBeDefined();
  });

  // =========================================================================
  // L4 (in_progress) — 有非终态任务且文档完整
  // =========================================================================

  it("should return progress summary for L4 (in-progress tasks with incomplete steps)", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // v0.3.0: progress from steps in status.yaml
    updateStatusWithSteps(taskDir, 5, 2);

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    expect(result).toHaveProperty("prependContext");
    const ctx = (result as any).prependContext;
    expect(ctx).toContain("当前进度");
    expect(ctx).toContain("task-1");
    expect(ctx).toContain("running");
    expect(ctx).toContain("2/5");
    expect(ctx).toContain("40%");
    expect(ctx).toContain("未完成");
  });

  it("should return empty object for L4 when all steps completed", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // v0.3.0: all steps completed
    updateStatusWithSteps(taskDir, 3, 3);
    // 设置 verification.status = "passed" 以触发收尾指引注入
    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    statusData.verification = { status: "passed", criteria: [{ criterion: "ok", result: "passed", evidence: "", reason: "" }], verified_at: "2026-01-01T00:00:00Z", verified_by: "test" };
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    // steps 全完成 + verification passed → 注入收尾操作指引
    expect(result).toHaveProperty("prependContext");
    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("✅");
    expect(ctx).toContain("task_verify");
    expect(ctx).toContain("task_transition");
  });

  it("should return MISSING_STEPS_ALERT for L4 when running task has no steps data", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // v0.3.0: no steps in status.yaml → hasMissingChecklist=true
    // MISSING_STEPS_ALERT is now a non-empty string → should be injected
    // buildProgressSummary: no steps → hasMissingChecklist=true, summary=null
    // in_progress case: hasMissingChecklist=true → push MISSING_STEPS_ALERT → parts.length > 0

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});
    // No steps → hasMissingChecklist=true → MISSING_STEPS_ALERT injected
    expect(result).toHaveProperty("prependContext");
    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("steps_update");
    expect(ctx).toContain("步骤数据为空");
    expect(result).toHaveProperty("prependSystemContext");
    const sysCtx = (result as any).prependSystemContext as string;
    expect(sysCtx).toContain("Steps 进度追踪规则");
  });

  it("should handle L4 when running task has no steps in status.yaml", async () => {
    // v0.3.0: no checklist.md file, progress comes from status.yaml.steps
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // No steps in status.yaml, no checklist.md file
    // Detector at low level: no required artifacts → in_progress
    // buildProgressSummary: no steps → hasMissingChecklist=true, summary=null
    // No runs/ directory → trySchemaDrivenStepsInjection returns null → fallback to MISSING_STEPS_ALERT

    const detector = new Detector();

    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});
    // No steps → hasMissingChecklist=true → MISSING_STEPS_ALERT injected (non-empty)
    expect(result).toHaveProperty("prependContext");
    expect((result as any).prependContext).toContain("steps_update");
  });

  it("should handle running task with empty steps gracefully", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // v0.3.0: steps array is empty in status.yaml
    const statusPath = join(taskDir, "status.yaml");
    const data = YAML.parse(readFileSync(statusPath, "utf-8"));
    data.steps = [];
    writeFileSync(statusPath, YAML.stringify(data), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});
    // Empty steps → hasMissingChecklist=true → MISSING_STEPS_ALERT injected (non-empty)
    expect(result).toHaveProperty("prependContext");
    expect((result as any).prependContext).toContain("steps_update");
  });

  it("should show progress summary and missing steps alert for assigned tasks with no steps", async () => {
    // assigned 状态的任务现在也会触发 steps 提醒（与 running 一致）
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "assigned" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // No steps in status.yaml → should trigger missing steps alert (like running)

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    expect(result).toHaveProperty("prependContext");
    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("steps_update");
    expect(ctx).toContain("步骤数据为空");
  });

  it("should list all in-progress tasks in progress summary", async () => {
    for (const [name, status] of [["task-a", "running"], ["task-b", "assigned"]] as const) {
      const taskDir = join(tmpDir, "spec-task", name);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: name, status }), "utf-8");
      for (const artifact of ["brief", "spec", "plan"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
    }
    // task-a 是 running，有进度
    updateStatusWithSteps(join(tmpDir, "spec-task", "task-a"), 3, 1);
    // task-b 是 assigned，现在也会出现在进度摘要中
    updateStatusWithSteps(join(tmpDir, "spec-task", "task-b"), 2, 0);

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext;
    // running 状态的 task-a 和 assigned 状态的 task-b 都出现在进度摘要中
    expect(ctx).toContain("task-a");
    expect(ctx).toContain("1/3");
    // assigned 状态的 task-b 现在也会出现在进度摘要中
    expect(ctx).toContain("task-b");
    expect(ctx).toContain("0/2");
  });

  it("should show percentage and unchecked steps in progress summary", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    updateStatusWithSteps(taskDir, 4, 1);

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext;
    expect(ctx).toContain("25%");
    // uncheckedSteps uses label (summary.title) when available, otherwise id
    expect(ctx).toContain("步骤 2");
    expect(ctx).toContain("步骤 3");
    expect(ctx).toContain("步骤 4");
  });

  // =========================================================================
  // nearCompletionTasks 提示 — 步骤完成度 ≥50% 且 <100% 且 verification !== passed
  // =========================================================================

  it("in_progress with 50% steps → nearCompletion hint", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // 2 completed + 2 pending = 50%
    updateStatusWithSteps(taskDir, 4, 2);

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("即将进入验收");
    expect(ctx).toContain("2/4");
  });

  it("in_progress with 30% steps → NO nearCompletion hint", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // 1 completed + 2 pending = 33%
    updateStatusWithSteps(taskDir, 3, 1);

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext as string;
    expect(ctx).not.toContain("即将进入验收");
  });

  it("in_progress with 100% steps + verification=failed → nearCompletion hint", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // All steps completed
    updateStatusWithSteps(taskDir, 3, 3);
    // Set verification.status = "failed"
    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    statusData.verification = { status: "failed" };
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("即将进入验收");
  });

  it("in_progress with 100% steps + verification=passed → completedTasks hint only", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // All steps completed
    updateStatusWithSteps(taskDir, 3, 3);
    // Set verification.status = "passed"
    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    statusData.verification = { status: "passed", criteria: [{ criterion: "ok", result: "passed", evidence: "", reason: "" }], verified_at: "2026-01-01T00:00:00Z", verified_by: "test" };
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("验收通过");
    expect(ctx).not.toContain("即将进入验收");
  });

  // =========================================================================
  // L5 (all_done) — 所有任务已完成
  // =========================================================================

  it("should return empty object for L5 (all tasks completed)", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "completed" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});
    expect(result).toEqual({});
  });

  // =========================================================================
  // 通用行为
  // =========================================================================

  it("should return empty object when enforceOnSubAgents is false", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "pending" }), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, { enforceOnSubAgents: false });
    const result = await handler({ cwd: tmpDir }, {});
    expect(result).toEqual({});
  });

  it("should return empty object when no workspace directory available", async () => {
    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({}, {});
    expect(result).toEqual({});
  });

  it("should record workspaceDir in workspaceDirMap for before_tool_call bridge", async () => {
    const workspaceDirMap = new Map<string, string>();
    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {}, workspaceDirMap);

    // 模拟生产环境：hookCtx 有 workspaceDir、agentId、sessionKey
    const hookCtx = { workspaceDir: tmpDir, agentId: "sa-test-agent", sessionKey: "agent:sa-test-agent:main" };
    await handler({}, hookCtx as any);

    // 验证 Map 中记录了映射
    expect(workspaceDirMap.get("sa-test-agent")).toBe(tmpDir);
    expect(workspaceDirMap.get("agent:sa-test-agent:main")).toBe(tmpDir);
  });

  it("should not crash when workspaceDirMap is not provided", async () => {
    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    // 不传 workspaceDirMap，不应崩溃
    const result = await handler({ cwd: tmpDir }, {});
    expect(result).toHaveProperty("prependContext");
  });

  // =========================================================================
  // 已删除功能验证：不应包含旧文本
  // =========================================================================

  it("should NOT contain intervention-related text (buildInterventionPrompt removed)", async () => {
    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext as string;
    expect(ctx).not.toContain("叶子节点");
    expect(ctx).not.toContain("X.Y.Z");
    expect(ctx).not.toContain("介入级别");
    expect(ctx).not.toContain("阈值");
  });

  it("should contain steps_update reminder in prependContext for in-progress tasks with unchecked steps", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    updateStatusWithSteps(taskDir, 3, 1);

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("steps_update");
    expect(ctx).toContain("当前阶段待完成步骤");
    expect(ctx).toContain("禁止跳过");
  });

  it("should NOT contain steps_update reminder in prependContext when all steps completed", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // 所有步骤都完成 → 不注入打勾提醒，但注入收尾操作指引
    updateStatusWithSteps(taskDir, 3, 3);
    // 设置 verification.status = "passed" 以触发收尾指引注入
    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);
    statusData.verification = { status: "passed", criteria: [{ criterion: "ok", result: "passed", evidence: "", reason: "" }], verified_at: "2026-01-01T00:00:00Z", verified_by: "test" };
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    // 不再返回空对象——现在会注入收尾操作指引
    expect(result).toHaveProperty("prependContext");
    const ctx = (result as any).prependContext as string;
    // 不应有"未完成步骤"的提醒
    expect(ctx).not.toContain("未完成:");
    // 应有收尾操作指引
    expect(ctx).toContain("✅");
    expect(ctx).toContain("task_verify");
    expect(ctx).toContain("task_transition");
  });

  it("should NOT contain buildResumeReminder text (task_resume removed)", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    updateStatusWithSteps(taskDir, 3, 1);

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext as string;
    expect(ctx).not.toContain("task_resume");
    expect(ctx).not.toContain("恢复");
  });

  // =========================================================================
  // prependSystemContext 注入（双层提醒 - System Prompt 层）
  // =========================================================================

  describe("prependSystemContext", () => {
    it("should inject steps guide in prependSystemContext for in_progress tasks", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
      for (const artifact of ["brief", "spec", "plan"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
      updateStatusWithSteps(taskDir, 3, 1);

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      expect(result).toHaveProperty("prependSystemContext");
      const sysCtx = (result as any).prependSystemContext as string;
      expect(sysCtx).toContain("steps_read");
      expect(sysCtx).toContain("steps_update");
      // STEPS_GUIDE contains "禁止跳步" (not "禁止跳过")
      expect(sysCtx).toContain("禁止跳步");
    });

    it("should inject steps guide in prependSystemContext for skeleton tasks", async () => {
      mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
      writeFileSync(join(tmpDir, "spec-task", "config.yaml"), YAML.stringify({
        tracking: { level: "medium" },
      }), "utf-8");

      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
      writeFileSync(join(taskDir, "brief.md"), "# Brief", "utf-8");
      updateStatusWithSteps(taskDir, 3, 1);

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      expect(result).toHaveProperty("prependSystemContext");
      const sysCtx = (result as any).prependSystemContext as string;
      expect(sysCtx).toContain("steps_read");
      expect(sysCtx).toContain("steps_update");
    });

    it("should inject explore-before-write prompt in prependContext for skeleton tasks", async () => {
      mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
      writeFileSync(join(tmpDir, "spec-task", "config.yaml"), YAML.stringify({
        tracking: { level: "medium" },
      }), "utf-8");

      // Create skeleton task: has status.yaml but missing brief.md (required at medium level)
      const taskDir = join(tmpDir, "spec-task", "skeleton-task");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "skeleton-task", status: "pending" }), "utf-8");
      // No brief.md → skeleton at medium level

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      expect(result).toHaveProperty("prependContext");
      const ctx = (result as any).prependContext as string;
      // Verify explore-before-write keywords
      expect(ctx).toContain("探索代码库");
      expect(ctx).toContain("信息收集");
      expect(ctx).toContain("Key Decisions");
      expect(ctx).toContain("文档编写前置条件");
    });

    it("should inject prependSystemContext with STEPS_GUIDE when no active tasks (none)", async () => {
      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      // none → auto-init → empty，现在会注入 prependSystemContext
      expect((result as any).prependSystemContext).toContain("Steps 进度追踪规则");
      expect((result as any).prependSystemContext).toContain("steps_update");
    });

    it("should inject prependSystemContext with STEPS_GUIDE when no active tasks (empty)", async () => {
      mkdirSync(join(tmpDir, "spec-task"), { recursive: true });

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      // empty 状态现在注入 prependSystemContext
      expect((result as any).prependSystemContext).toContain("Steps 进度追踪规则");
      expect((result as any).prependSystemContext).toContain("steps_update");
    });

    it("should NOT inject prependSystemContext when all tasks done (all_done)", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "completed" }), "utf-8");
      for (const artifact of ["brief", "spec", "plan", "checklist"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      expect((result as any).prependSystemContext).toBeUndefined();
    });
  });

  // =========================================================================
  // 集成测试：buildSubagentCompliance / buildWorkflowOverview / buildDirectoryStructure 注入
  // =========================================================================

  describe("hook-based skill injection integration", () => {
    it("should inject subagent compliance + workflow + directory in empty level prependContext", async () => {
      mkdirSync(join(tmpDir, "spec-task"), { recursive: true });

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      // prependContext should contain workflow overview and directory structure
      const ctx = (result as any).prependContext as string;
      expect(ctx).toContain("config_merge");
      expect(ctx).toContain("task_recall");
      expect(ctx).toContain("task_create");
      expect(ctx).toContain("task_transition");
      expect(ctx).toContain("task_archive");
      expect(ctx).toContain("config.yaml");
      expect(ctx).toContain("brief.md");
      expect(ctx).toContain("plan.md");
      expect(ctx).toContain("task_dir");
      // Should also still contain the empty-level guidance
      expect(ctx).toContain("无活跃任务");

      // prependSystemContext should contain subagent compliance + stepsGuide
      const sysCtx = (result as any).prependSystemContext as string;
      expect(sysCtx).toContain("子");
      expect(sysCtx).toContain("config_merge");
      expect(sysCtx).toContain("Steps 进度追踪规则");
    });

    it("should inject subagent compliance in in_progress level prependSystemContext but NOT workflow in prependContext", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
      for (const artifact of ["brief", "spec", "plan"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
      updateStatusWithSteps(taskDir, 3, 1);

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      // prependSystemContext should contain subagent compliance
      const sysCtx = (result as any).prependSystemContext as string;
      expect(sysCtx).toContain("子");
      expect(sysCtx).toContain("config_merge");

      // prependContext should NOT contain workflow overview or directory structure
      const ctx = (result as any).prependContext as string;
      expect(ctx).not.toContain("task_archive");
      expect(ctx).not.toContain("task_dir");
    });

    it("should NOT inject subagent compliance in all_done level", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "completed" }), "utf-8");
      for (const artifact of ["brief", "spec", "plan"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      // all_done returns empty object
      expect(result).toEqual({});
    });

    it("should inject subagent compliance in skeleton level prependSystemContext", async () => {
      mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
      writeFileSync(join(tmpDir, "spec-task", "config.yaml"), YAML.stringify({
        tracking: { level: "medium" },
      }), "utf-8");

      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "pending" }), "utf-8");

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      // prependSystemContext should contain subagent compliance
      const sysCtx = (result as any).prependSystemContext as string;
      expect(sysCtx).toContain("子");
      expect(sysCtx).toContain("config_merge");
    });

    it("should respect high tracking level tone in empty level injections", async () => {
      mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
      writeFileSync(join(tmpDir, "spec-task", "config.yaml"), YAML.stringify({
        tracking: { level: "high" },
      }), "utf-8");

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      const sysCtx = (result as any).prependSystemContext as string;
      expect(sysCtx).toContain("必须");
      expect(sysCtx).toContain("🚫");

      const ctx = (result as any).prependContext as string;
      expect(ctx).toContain("必须");
    });

    it("should respect low tracking level tone in empty level injections", async () => {
      mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
      writeFileSync(join(tmpDir, "spec-task", "config.yaml"), YAML.stringify({
        tracking: { level: "low" },
      }), "utf-8");

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      const sysCtx = (result as any).prependSystemContext as string;
      expect(sysCtx).toContain("建议");
      expect(sysCtx).toContain("💡");
      // Note: buildStepsGuide has hardcoded "必须" for execution discipline (tone-independent)
      // So we verify the subagent compliance section uses "建议" not "必须" by checking
      // the "子 Agent 合规" section specifically
      expect(sysCtx).toContain("子 Agent 合规（建议）");

      const ctx = (result as any).prependContext as string;
      expect(ctx).toContain("建议");
    });
  });

  // =========================================================================
  // prependContext 打勾提醒增强
  // =========================================================================

  describe("prependContext steps reminder", () => {
    it("should append steps reminder when unchecked steps exist", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
      for (const artifact of ["brief", "spec", "plan"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
      updateStatusWithSteps(taskDir, 5, 2);

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      const ctx = (result as any).prependContext as string;
      expect(ctx).toContain("当前进度");
      expect(ctx).toContain("2/5");
      expect(ctx).toContain("当前阶段待完成步骤");
      // uncheckedSteps uses label (summary.title) when available
      expect(ctx).toContain("步骤 3");
      expect(ctx).toContain("禁止跳过");
      expect(ctx).toContain("steps_update");
    });

    it("should NOT append steps reminder when all steps completed", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
      for (const artifact of ["brief", "spec", "plan"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
      updateStatusWithSteps(taskDir, 3, 3);
      // 设置 verification.status = "passed" 以触发收尾指引注入
      const statusContent2 = readFileSync(join(taskDir, "status.yaml"), "utf-8");
      const statusData2 = YAML.parse(statusContent2);
      statusData2.verification = { status: "passed", criteria: [{ criterion: "ok", result: "passed", evidence: "", reason: "" }], verified_at: "2026-01-01T00:00:00Z", verified_by: "test" };
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(statusData2), "utf-8");

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      // 不再返回空对象——现在会注入收尾操作指引
      expect(result).toHaveProperty("prependContext");
      const ctx = (result as any).prependContext as string;
      expect(ctx).not.toContain("未完成:");
      expect(ctx).toContain("✅");
      expect(ctx).toContain("task_verify");
      expect(ctx).toContain("task_transition");
    });
  });

  // =========================================================================
  // normalizeKey 行为
  // =========================================================================

  it("should use custom normalizeKey for workspaceDirMap", async () => {
    const workspaceDirMap = new Map<string, string>();
    const detector = new Detector();
    const customNormalize = (key: string | undefined) => key?.toUpperCase();
    const handler = createPromptBuildHandler(mockLogger, detector, {}, workspaceDirMap, customNormalize);

    const hookCtx = { workspaceDir: tmpDir, agentId: "MyAgent" };
    await handler({}, hookCtx as any);

    // 自定义 normalize 转为大写
    expect(workspaceDirMap.get("MYAGENT")).toBe(tmpDir);
    // 同时保留原始键
    expect(workspaceDirMap.get("MyAgent")).toBe(tmpDir);
  });

  // =========================================================================
  // 文本截断（2000 字符限制）
  // =========================================================================

  describe("truncateWithContext", () => {
    const TRUNCATION_LIMIT = 2000;
    const TRUNCATION_HINT = "⚠️ 指导内容过长，已截断。请调用 `task_instructions` 工具获取完整指导。";

    it("should NOT truncate text when length is under 2000 chars", () => {
      const shortText = "这是一段短文本";
      const result = truncateWithContext(shortText);
      expect(result).toBe(shortText);
      expect(result).not.toContain(TRUNCATION_HINT);
    });

    it("should NOT truncate text when length equals exactly 2000 chars", () => {
      const exactText = "a".repeat(2000);
      const result = truncateWithContext(exactText);
      expect(result).toBe(exactText);
      expect(result.length).toBe(2000);
      expect(result).not.toContain(TRUNCATION_HINT);
    });

    it("should truncate text exceeding 2000 chars and append task_instructions hint", () => {
      const longText = "x".repeat(2500);
      const result = truncateWithContext(longText);
      // 前 2000 字符 + 截断提示
      expect(result.length).toBeGreaterThan(TRUNCATION_LIMIT);
      expect(result.startsWith("x".repeat(2000)));
      expect(result).toContain(TRUNCATION_HINT);
      expect(result).toContain("task_instructions");
      expect(result).toContain("已截断");
    });

    it("should respect custom maxLen parameter", () => {
      const text = "a".repeat(500);
      const result = truncateWithContext(text, 100);
      expect(result).toBe("a".repeat(100) + "\n\n" + TRUNCATION_HINT);
    });

    it("should preserve original content when under custom maxLen", () => {
      const text = "short content";
      const result = truncateWithContext(text, 1000);
      expect(result).toBe(text);
    });

    it("should NOT truncate prependContext when text is under 2000 chars (integration)", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
      for (const artifact of ["brief", "spec", "plan"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
      // 正常步骤数据 → 生成短文本，不会超过 2000 字符
      updateStatusWithSteps(taskDir, 3, 1);

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      const ctx = (result as any).prependContext as string;
      expect(ctx).toBeDefined();
      expect(ctx.length).toBeLessThanOrEqual(TRUNCATION_LIMIT);
      expect(ctx).not.toContain(TRUNCATION_HINT);
    });
  });
});

// =========================================================================
// buildSubagentCompliance() 纯函数测试
// =========================================================================

describe("buildSubagentCompliance", () => {
  it("should return a string with compliance rules", () => {
    const tone = getToneConfig("medium");
    const result = buildSubagentCompliance(tone);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should use '必须' verb and '🚫' icon for high tracking level", () => {
    const tone = getToneConfig("high");
    const result = buildSubagentCompliance(tone);
    expect(result).toContain("必须");
    expect(result).toContain("🚫");
    expect(result).toContain("config_merge");
    expect(result).toContain("task_recall");
    expect(result).toContain("task_create");
  });

  it("should use '强烈建议' verb and '⚠️' icon for medium tracking level", () => {
    const tone = getToneConfig("medium");
    const result = buildSubagentCompliance(tone);
    expect(result).toContain("强烈建议");
    expect(result).toContain("⚠️");
    expect(result).toContain("config_merge");
    expect(result).toContain("task_recall");
    expect(result).toContain("task_create");
  });

  it("should use '建议' verb and '💡' icon for low tracking level", () => {
    const tone = getToneConfig("low");
    const result = buildSubagentCompliance(tone);
    expect(result).toContain("建议");
    expect(result).toContain("💡");
    expect(result).toContain("config_merge");
    expect(result).toContain("task_recall");
    expect(result).toContain("task_create");
  });

  it("should mention subagent mandatory use with no exceptions", () => {
    const tone = getToneConfig("high");
    const result = buildSubagentCompliance(tone);
    expect(result).toContain("子");
    expect(result).toContain("例外");
  });

  it("should recommend passing brief and plan in task_create", () => {
    const tone = getToneConfig("medium");
    const result = buildSubagentCompliance(tone);
    expect(result).toContain("brief");
    expect(result).toContain("plan");
  });
});

// =========================================================================
// buildWorkflowOverview() 纯函数测试
// =========================================================================

describe("buildWorkflowOverview", () => {
  it("should return a string with workflow steps", () => {
    const tone = getToneConfig("medium");
    const result = buildWorkflowOverview(tone);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should contain all 8 workflow steps in correct order", () => {
    const tone = getToneConfig("medium");
    const result = buildWorkflowOverview(tone);
    // Verify all 8 steps are mentioned
    expect(result).toContain("config_merge");
    expect(result).toContain("task_recall");
    expect(result).toContain("task_create");
    expect(result).toContain("探索");
    expect(result).toContain("填充");
    expect(result).toContain("task_transition");
    expect(result).toContain("执行");
    expect(result).toContain("task_verify");
    expect(result).toContain("task_archive");
  });

  it("should respect tone config for high level", () => {
    const tone = getToneConfig("high");
    const result = buildWorkflowOverview(tone);
    expect(result).toContain("必须");
    expect(result).toContain("🚫");
  });

  it("should respect tone config for low level", () => {
    const tone = getToneConfig("low");
    const result = buildWorkflowOverview(tone);
    expect(result).toContain("建议");
    expect(result).toContain("💡");
  });

  it("should produce compact output (~300 chars)", () => {
    const tone = getToneConfig("medium");
    const result = buildWorkflowOverview(tone);
    // Should be compact - under 500 chars
    expect(result.length).toBeLessThan(500);
  });
});

// =========================================================================
// buildDirectoryStructure() 纯函数测试
// =========================================================================

describe("buildDirectoryStructure", () => {
  it("should return a string with directory layout", () => {
    const result = buildDirectoryStructure();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should contain config.yaml path", () => {
    const result = buildDirectoryStructure();
    expect(result).toContain("config.yaml");
  });

  it("should contain brief.md and plan.md paths", () => {
    const result = buildDirectoryStructure();
    expect(result).toContain("brief.md");
    expect(result).toContain("plan.md");
  });

  it("should contain runs/001/status.yaml path", () => {
    const result = buildDirectoryStructure();
    expect(result).toContain("runs");
    expect(result).toContain("status.yaml");
  });

  it("should mention task_dir points to run directory", () => {
    const result = buildDirectoryStructure();
    expect(result).toContain("task_dir");
    expect(result).toContain("run");
  });

  it("should produce compact output (~200 chars)", () => {
    const result = buildDirectoryStructure();
    expect(result.length).toBeLessThan(400);
  });

  it("should not require ToneConfig parameter", () => {
    // Should work with no arguments (no tone dependency)
    const result = buildDirectoryStructure();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
