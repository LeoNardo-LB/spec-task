import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { extractSpec } from "../spec-extractor.js";
import type { TaskStatusData } from "../../types.js";

// ============================================================================
// Helpers
// ============================================================================

function buildStatusData(overrides?: Partial<TaskStatusData>): TaskStatusData {
  return {
    task_id: "test-task",
    title: "Test Task",
    created: "2025-01-01T00:00:00.000Z",
    updated: "2025-01-02T00:00:00.000Z",
    status: "completed",
    assigned_to: "agent",
    run_id: "001",
    started_at: "2025-01-01T00:00:00.000Z",
    completed_at: "2025-01-02T00:00:00.000Z",
    progress: { total: 2, completed: 2, skipped: 0, current_step: "", percentage: 100 },
    outputs: ["src/foo.ts"],
    steps: [
      {
        id: "1.1",
        summary: {
          title: "Setup project",
          content: "Created project structure with TypeScript config",
          approach: "Used tsc --init and configured strict mode",
          sources: ["https://example.com/typescript-setup"],
        },
        status: "completed",
        completed_at: "2025-01-01T01:00:00.000Z",
        tags: [],
      },
      {
        id: "2.1",
        summary: {
          title: "Implement feature",
          content: "Implemented the core feature module",
          approach: "Functional decomposition with pure functions",
          sources: [],
        },
        status: "completed",
        completed_at: "2025-01-01T02:00:00.000Z",
        tags: [],
      },
    ],
    errors: [
      { step: "1.1", message: "Type error in config", retry_count: 1, timestamp: "2025-01-01T00:30:00.000Z" },
    ],
    blocked_by: [],
    verification: {
      status: "passed",
      verified_at: "2025-01-02T00:00:00.000Z",
      verified_by: "agent",
      criteria: [
        { criterion: "Build passes", result: "passed", evidence: "npm run build succeeded", reason: "" },
        { criterion: "Tests pass", result: "failed", evidence: "2 tests failed", reason: "flaky test" },
      ],
    },
    revisions: [],
    ...overrides,
  };
}

// ============================================================================
// 临时目录
// ============================================================================

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    process.env.TMPDIR ?? "/tmp",
    `spec-extractor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// extractSpec
// ============================================================================

describe("extractSpec", () => {
  it("should generate spec.md in task root from full task data", async () => {
    // Setup: task-root/brief.md, task-root/plan.md, task-root/runs/001/status.yaml
    const taskRoot = join(tmpDir, "my-task");
    const runDir = join(taskRoot, "runs", "001");
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(taskRoot, "brief.md"), "# My Task\n\nBuild something cool.", "utf-8");
    writeFileSync(join(taskRoot, "plan.md"), "# Plan\n\nStep 1: Setup\nStep 2: Build", "utf-8");

    const data = buildStatusData();
    writeFileSync(join(runDir, "status.yaml"), YAML.stringify(data), "utf-8");

    const specPath = await extractSpec({ taskDir: runDir, runDir });

    // spec.md should be in task root
    expect(specPath).toBe(join(taskRoot, "spec.md"));
    expect(specPath !== null && existsSync(specPath)).toBe(true);

    const content = specPath !== null ? readFileSync(specPath, "utf-8") : "";

    // Title
    expect(content).toContain("# Spec: Test Task");

    // Auto-extracted header
    expect(content).toContain("Auto-extracted from run 001");

    // Technical Decisions section
    expect(content).toContain("## Technical Decisions");
    expect(content).toContain("### 1.1 Setup project");
    expect(content).toContain("Used tsc --init");
    expect(content).toContain("### 2.1 Implement feature");
    expect(content).toContain("Functional decomposition");

    // Implementation Summary section
    expect(content).toContain("## Implementation Summary");
    expect(content).toContain("Created project structure");
    expect(content).toContain("Implemented the core feature");

    // Verification Results
    expect(content).toContain("## Verification Results");
    expect(content).toContain("✅ Build passes");
    expect(content).toContain("❌ Tests pass");

    // Outputs
    expect(content).toContain("## Outputs");
    expect(content).toContain("`src/foo.ts`");

    // Errors
    expect(content).toContain("## Errors Encountered");
    expect(content).toContain("[1.1] Type error in config (retry#1)");

    // Sources
    expect(content).toContain("## Sources Referenced");
    expect(content).toContain("https://example.com/typescript-setup");
  });

  it("should generate spec from steps alone when brief.md and plan.md are missing", async () => {
    const taskRoot = join(tmpDir, "my-task");
    const runDir = join(taskRoot, "runs", "001");
    mkdirSync(runDir, { recursive: true });

    // No brief.md, no plan.md
    const data = buildStatusData();
    writeFileSync(join(runDir, "status.yaml"), YAML.stringify(data), "utf-8");

    const specPath = await extractSpec({ taskDir: runDir, runDir });

    expect(specPath).toBe(join(taskRoot, "spec.md"));
    expect(specPath !== null && existsSync(specPath)).toBe(true);

    const content = specPath !== null ? readFileSync(specPath, "utf-8") : "";
    expect(content).toContain("# Spec: Test Task");
    expect(content).toContain("## Technical Decisions");
  });

  it("should return null when status.yaml does not exist", async () => {
    const taskRoot = join(tmpDir, "my-task");
    const runDir = join(taskRoot, "runs", "001");
    mkdirSync(runDir, { recursive: true });

    const result = await extractSpec({ taskDir: runDir, runDir });
    expect(result).toBeNull();
  });

  it("should return null when status.yaml is malformed", async () => {
    const taskRoot = join(tmpDir, "my-task");
    const runDir = join(taskRoot, "runs", "001");
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(runDir, "status.yaml"), "not valid yaml: {{", "utf-8");

    const result = await extractSpec({ taskDir: runDir, runDir });
    expect(result).toBeNull();
  });

  it("should handle task with no steps gracefully", async () => {
    const taskRoot = join(tmpDir, "my-task");
    const runDir = join(taskRoot, "runs", "001");
    mkdirSync(runDir, { recursive: true });

    const data = buildStatusData({ steps: [], outputs: [], errors: [], verification: { status: "pending", criteria: [], verified_at: null, verified_by: null } });
    writeFileSync(join(runDir, "status.yaml"), YAML.stringify(data), "utf-8");

    const specPath = await extractSpec({ taskDir: runDir, runDir });

    expect(specPath).toBe(join(taskRoot, "spec.md"));
    const content = specPath !== null ? readFileSync(specPath, "utf-8") : "";
    expect(content).toContain("# Spec: Test Task");
    // No sections should appear for empty data
    expect(content).not.toContain("## Technical Decisions");
    expect(content).not.toContain("## Implementation Summary");
    expect(content).not.toContain("## Verification Results");
    expect(content).not.toContain("## Outputs");
    expect(content).not.toContain("## Errors Encountered");
    expect(content).not.toContain("## Sources Referenced");
  });

  it("should deduplicate and sort sources", async () => {
    const taskRoot = join(tmpDir, "my-task");
    const runDir = join(taskRoot, "runs", "001");
    mkdirSync(runDir, { recursive: true });

    const data = buildStatusData({
      steps: [
        {
          id: "1.1",
          summary: { title: "A", content: "", approach: "", sources: ["https://z.com", "https://a.com"] },
          status: "completed", completed_at: null, tags: [],
        },
        {
          id: "1.2",
          summary: { title: "B", content: "", approach: "", sources: ["https://a.com", "https://b.com"] },
          status: "completed", completed_at: null, tags: [],
        },
      ],
    });
    writeFileSync(join(runDir, "status.yaml"), YAML.stringify(data), "utf-8");

    const specPath = await extractSpec({ taskDir: runDir, runDir });
    const content = readFileSync(specPath!, "utf-8");

    // Sources should be sorted and deduplicated
    const srcSection = content.split("## Sources Referenced")[1].split("## ")[0];
    expect(srcSection).toContain("https://a.com");
    expect(srcSection).toContain("https://b.com");
    expect(srcSection).toContain("https://z.com");
    // a.com should appear only once (deduplicated)
    const matches = srcSection.match(/https:\/\/a\.com/g);
    expect(matches?.length).toBe(1);
  });
});
