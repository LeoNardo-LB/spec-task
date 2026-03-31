import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { createPromptBuildHandler } from "../../src/hooks/before-prompt-build.js";
import { Detector } from "../../src/detector.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/**
 * 创建一个带有部分已完成 checkbox 的 checklist 内容。
 */
function makeChecklist(total: number, completed: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= total; i++) {
    const checked = i <= completed ? "x" : " ";
    lines.push(`- [${checked}] ${i}.1 步骤 ${i}`);
  }
  return lines.join("\n");
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
    expect((result as any).prependContext).toBe("📋 无活跃任务。");
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
    expect((result as any).prependContext).toBe("📋 无活跃任务。");
  });

  // =========================================================================
  // L3 (skeleton) — 有 status.yaml 但缺核心文档
  // =========================================================================

  it("should return skeleton warning for L3 (missing artifacts)", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "pending" }), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    expect(result).toHaveProperty("prependContext");
    const ctx = (result as any).prependContext;
    expect(ctx).toContain("task-1");
    // 默认 requiredArtifacts=["checklist"]，只有 checklist 在缺失列表中
    expect(ctx).toContain("checklist");
    expect(ctx).toContain("缺少构件文件");
    expect(ctx).toContain("请在下次 task_create 时传入完整内容");
  });

  it("should list all skeleton tasks in warning", async () => {
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
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    writeFileSync(join(taskDir, "brief.md"), "# Brief", "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext;
    // 默认 requiredArtifacts=["checklist"]，只有 checklist 在缺失列表中
    expect(ctx).toContain("checklist");
    // 缺失列表中只有 checklist（"缺少 checklist"），不应有 "缺少 brief"
    expect(ctx).not.toContain("缺少 brief");
  });

  it("should include progress summary in L3 when running task has incomplete checklist", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    writeFileSync(join(taskDir, "brief.md"), "# Brief", "utf-8");
    // 默认 requiredArtifacts=["checklist"]，checklist.md 存在 → 任务归类为 in_progress
    writeFileSync(join(taskDir, "checklist.md"), makeChecklist(5, 2), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext;
    // 任务有 checklist → in_progress，不触发骨架警告
    expect(ctx).not.toContain("骨架");
    expect(ctx).toContain("当前进度");
    expect(ctx).toContain("2/5");
    expect(ctx).toContain("40%");
  });

  it("should include missing checklist alert in L3 when running task has no checklist", async () => {
    // 创建一个 running 状态的骨架任务，缺少 checklist.md
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    writeFileSync(join(taskDir, "brief.md"), "# Brief", "utf-8");
    writeFileSync(join(taskDir, "spec.md"), "# Spec", "utf-8");
    writeFileSync(join(taskDir, "plan.md"), "# Plan", "utf-8");
    // 没有 checklist.md → 该任务会被 detector 归类为 skeleton（缺少 checklist artifact）

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext;
    expect(ctx).toContain("缺少 checklist.md");
    expect(ctx).toContain("请立即创建进度追踪清单");
  });

  // =========================================================================
  // L4 (in_progress) — 有非终态任务且文档完整
  // =========================================================================

  it("should return progress summary for L4 (in-progress tasks with incomplete checklist)", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan", "checklist"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // 覆盖 checklist 为有未完成项的内容
    writeFileSync(join(taskDir, "checklist.md"), makeChecklist(5, 2), "utf-8");

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

  it("should return empty object for L4 when all checklist steps completed", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // 所有步骤都完成
    writeFileSync(join(taskDir, "checklist.md"), makeChecklist(3, 3), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});
    expect(result).toEqual({});
  });

  it("should return empty object for L4 when running task has no checkbox lines", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // checklist.md 存在但没有 checkbox 行
    writeFileSync(join(taskDir, "checklist.md"), "# Checklist\n\nNo steps yet.", "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});
    expect(result).toEqual({});
  });

  it("should return missing checklist alert for L4 when running task has no checklist file", async () => {
    // 这个场景比较特殊：detector 认为是 in_progress（4个 artifact 都存在），
    // 但 checklist.md 文件在 detector 检测后被删除。
    // 在正常流程中不会发生，但 buildProgressSummary 应该能处理。
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan", "checklist"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }

    // 先创建 handler 让 detector 正常检测
    const detector = new Detector();

    // 删除 checklist.md 后调用 handler
    const checklistPath = join(taskDir, "checklist.md");
    const handler = createPromptBuildHandler(mockLogger, detector, {});

    // 注意：detector.detect() 在 handler 内部调用时 checklist.md 已被删除
    // 但因为 4 个 artifact 文件都是先创建再删除 checklist.md，
    // detector 会将其归类为 skeleton 而非 in_progress
    // 所以这里我们测试的是 detector 视角下的 skeleton + missing checklist 场景
    rmSync(checklistPath);

    const result = await handler({ cwd: tmpDir }, {});
    const ctx = (result as any).prependContext;
    expect(ctx).toContain("缺少 checklist.md");
  });

  it("should list all in-progress tasks in progress summary", async () => {
    for (const [name, status] of [["task-a", "running"], ["task-b", "assigned"]] as const) {
      const taskDir = join(tmpDir, "spec-task", name);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: name, status }), "utf-8");
      for (const artifact of ["brief", "spec", "plan", "checklist"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
    }
    // task-a 是 running，有进度
    writeFileSync(join(tmpDir, "spec-task", "task-a", "checklist.md"), makeChecklist(3, 1), "utf-8");
    // task-b 是 assigned，不是 running → 不会出现在进度摘要中

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext;
    // 只有 running 状态的 task-a 出现在进度摘要中
    expect(ctx).toContain("task-a");
    expect(ctx).toContain("1/3");
    // assigned 状态的 task-b 不在进度摘要中
    expect(ctx).not.toContain("task-b");
  });

  it("should show percentage and unchecked steps in progress summary", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    writeFileSync(join(taskDir, "checklist.md"), makeChecklist(4, 1), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext;
    expect(ctx).toContain("25%");
    expect(ctx).toContain("2.1");
    expect(ctx).toContain("3.1");
    expect(ctx).toContain("4.1");
  });

  // =========================================================================
  // L5 (all_done) — 所有任务已完成
  // =========================================================================

  it("should return empty object for L5 (all tasks completed)", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "completed" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan", "checklist"]) {
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

  it("should contain checklist_write reminder in prependContext for in-progress tasks with unchecked steps", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    writeFileSync(join(taskDir, "checklist.md"), makeChecklist(3, 1), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    const ctx = (result as any).prependContext as string;
    expect(ctx).toContain("checklist_write");
    expect(ctx).toContain("下一个待完成步骤");
    expect(ctx).toContain("禁止跳过");
  });

  it("should NOT contain checklist_write reminder in prependContext when all steps completed", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    // 所有步骤都完成 → 不注入打勾提醒
    writeFileSync(join(taskDir, "checklist.md"), makeChecklist(3, 3), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir }, {});

    // 所有步骤完成 → 返回空对象，无 prependContext
    expect(result).toEqual({});
  });

  it("should NOT contain buildResumeReminder text (task_resume removed)", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan", "checklist"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }
    writeFileSync(join(taskDir, "checklist.md"), makeChecklist(3, 1), "utf-8");

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
    it("should inject checklist guide in prependSystemContext for in_progress tasks", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
      for (const artifact of ["brief", "spec", "plan"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
      writeFileSync(join(taskDir, "checklist.md"), makeChecklist(3, 1), "utf-8");

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      expect(result).toHaveProperty("prependSystemContext");
      const sysCtx = (result as any).prependSystemContext as string;
      expect(sysCtx).toContain("checklist_read");
      expect(sysCtx).toContain("checklist_write");
      expect(sysCtx).toContain("不要手动编辑");
    });

    it("should inject checklist guide in prependSystemContext for skeleton tasks", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
      writeFileSync(join(taskDir, "brief.md"), "# Brief", "utf-8");
      writeFileSync(join(taskDir, "checklist.md"), makeChecklist(3, 1), "utf-8");

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      expect(result).toHaveProperty("prependSystemContext");
      const sysCtx = (result as any).prependSystemContext as string;
      expect(sysCtx).toContain("checklist_read");
      expect(sysCtx).toContain("checklist_write");
    });

    it("should NOT inject prependSystemContext when no active tasks (none)", async () => {
      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      expect((result as any).prependSystemContext).toBeUndefined();
    });

    it("should NOT inject prependSystemContext when no active tasks (empty)", async () => {
      mkdirSync(join(tmpDir, "spec-task"), { recursive: true });

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      expect((result as any).prependSystemContext).toBeUndefined();
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
  // prependContext 打勾提醒增强
  // =========================================================================

  describe("prependContext checklist reminder", () => {
    it("should append checklist reminder when unchecked steps exist", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
      for (const artifact of ["brief", "spec", "plan"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
      writeFileSync(join(taskDir, "checklist.md"), makeChecklist(5, 2), "utf-8");

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      const ctx = (result as any).prependContext as string;
      expect(ctx).toContain("当前进度");
      expect(ctx).toContain("2/5");
      expect(ctx).toContain("下一个待完成步骤");
      expect(ctx).toContain("3.1");
      expect(ctx).toContain("禁止跳过");
      expect(ctx).toContain("checklist_write");
    });

    it("should NOT append checklist reminder when all steps completed", async () => {
      const taskDir = join(tmpDir, "spec-task", "task-1");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
      for (const artifact of ["brief", "spec", "plan"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
      writeFileSync(join(taskDir, "checklist.md"), makeChecklist(3, 3), "utf-8");

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: tmpDir }, {});

      // 所有步骤完成 → 返回空对象
      expect(result).toEqual({});
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
});
