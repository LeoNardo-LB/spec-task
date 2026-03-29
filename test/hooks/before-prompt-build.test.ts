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

describe("createPromptBuildHandler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should auto-initialize and return reminder for L1 (no spec-task directory)", async () => {
    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir });
    // L1 none → 自动创建 spec-task/config.yaml + 注入初始化提醒
    expect(result).toHaveProperty("prependContext");
    expect((result as any).prependContext).toContain("spec-task");
    expect((result as any).prependContext).toContain("强制要求");
    // 验证目录和 config.yaml 已创建
    expect(existsSync(join(tmpDir, "spec-task", "config.yaml"))).toBe(true);
  });

  it("should return light reminder for L2 (empty spec-task directory)", async () => {
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir });

    expect(result).toHaveProperty("prependContext");
    expect((result as any).prependContext).toContain("spec-task");
    expect((result as any).prependContext).toContain("强制要求");
  });

  it("should return skeleton warning for L3 (missing artifacts)", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "pending" }), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir });

    expect(result).toHaveProperty("prependContext");
    const ctx = (result as any).prependContext;
    expect(ctx).toContain("task-1");
    expect(ctx).toContain("brief");
    expect(ctx).toContain("SPEC-TASK");
    expect(ctx).toContain("强制要求");
  });

  it("should return resume reminder for L4 (in-progress tasks)", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "running" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan", "checklist"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir });

    expect(result).toHaveProperty("prependContext");
    const ctx = (result as any).prependContext;
    expect(ctx).toContain("task-1");
    expect(ctx).toContain("running");
    expect(ctx).toContain("task_resume");
  });

  it("should return empty object for L5 (all tasks completed)", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "completed" }), "utf-8");
    for (const artifact of ["brief", "spec", "plan", "checklist"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir });
    expect(result).toEqual({});
  });

  it("should return empty object when enforceOnSubAgents is false", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: "task-1", status: "pending" }), "utf-8");

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, { enforceOnSubAgents: false });
    const result = await handler({ cwd: tmpDir });
    expect(result).toEqual({});
  });

  it("should list all skeleton tasks in warning", async () => {
    for (const name of ["task-a", "task-b"]) {
      const taskDir = join(tmpDir, "spec-task", name);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: name, status: "pending" }), "utf-8");
    }

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir });

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
    const result = await handler({ cwd: tmpDir });

    const ctx = (result as any).prependContext;
    expect(ctx).toContain("spec");
    expect(ctx).toContain("plan");
    expect(ctx).toContain("checklist");
  });

  it("should return empty object when no workspace directory available", async () => {
    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({});
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
    const result = await handler({ cwd: tmpDir });
    expect(result).toHaveProperty("prependContext");
  });

  it("should list all in-progress tasks in resume reminder", async () => {
    for (const [name, status] of [["task-a", "running"], ["task-b", "assigned"]] as const) {
      const taskDir = join(tmpDir, "spec-task", name);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status.yaml"), YAML.stringify({ task_id: name, status }), "utf-8");
      for (const artifact of ["brief", "spec", "plan", "checklist"]) {
        writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
      }
    }

    const detector = new Detector();
    const handler = createPromptBuildHandler(mockLogger, detector, {});
    const result = await handler({ cwd: tmpDir });

    const ctx = (result as any).prependContext;
    expect(ctx).toContain("task-a");
    expect(ctx).toContain("task-b");
  });
});
