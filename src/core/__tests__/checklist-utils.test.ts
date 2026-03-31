import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  parseChecklist,
  markdownToSteps,
  calculateProgressFromSteps,
  syncStepsToStatus,
  loadStepsFromStatus,
} from "../checklist-utils.js";
import type { Step } from "../../types.js";

// ============================================================================
// 临时目录
// ============================================================================

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    process.env.TMPDIR ?? "/tmp",
    `checklist-utils-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// parseChecklist
// ============================================================================

describe("parseChecklist", () => {
  // ---- 基础解析 ----

  it("should parse [x] as completed and [ ] as pending", () => {
    const content = [
      "- [x] 1.1 First step done",
      "- [ ] 1.2 Second step pending",
      "- [x] 2.1 Another done step",
    ].join("\n");

    const steps = parseChecklist(content);

    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({
      stepNumber: "1.1",
      text: "1.1 First step done",
      status: "completed",
      tag: undefined,
      skipReason: undefined,
    });
    expect(steps[1]).toEqual({
      stepNumber: "1.2",
      text: "1.2 Second step pending",
      status: "pending",
      tag: undefined,
      skipReason: undefined,
    });
    expect(steps[2]).toEqual({
      stepNumber: "2.1",
      text: "2.1 Another done step",
      status: "completed",
      tag: undefined,
      skipReason: undefined,
    });
  });

  it("should parse [-] as skipped with skip_reason extracted from parentheses", () => {
    const content = [
      "- [-] 1.1 Optional validation (数据不可用)",
      "- [-] 1.2 Skipped without reason",
      "- [-] 1.3 Another skip (环境不支持)",
    ].join("\n");

    const steps = parseChecklist(content);

    expect(steps).toHaveLength(3);
    expect(steps[0].status).toBe("skipped");
    expect(steps[0].skipReason).toBe("数据不可用");

    expect(steps[1].status).toBe("skipped");
    expect(steps[1].skipReason).toBeUndefined();

    expect(steps[2].status).toBe("skipped");
    expect(steps[2].skipReason).toBe("环境不支持");
  });

  // ---- 标签提取 ----

  it("should extract tags like [spawn:xxx]", () => {
    const content = [
      "- [ ] 1.1 [spawn:financial-valuation] Create financial model",
      "- [ ] 1.2 [spawn:risk-assessment] Evaluate risks",
      "- [ ] 2.1 Normal step without tag",
    ].join("\n");

    const steps = parseChecklist(content);

    expect(steps[0].tag).toBe("spawn:financial-valuation");
    expect(steps[1].tag).toBe("spawn:risk-assessment");
    expect(steps[2].tag).toBeUndefined();
  });

  it("should extract tags from completed and skipped steps too", () => {
    const content = [
      "- [x] 1.1 [spawn:setup] Setup environment",
      "- [-] 1.2 [spawn:cleanup] Cleanup (不再需要)",
    ].join("\n");

    const steps = parseChecklist(content);

    expect(steps[0].tag).toBe("spawn:setup");
    expect(steps[0].status).toBe("completed");

    expect(steps[1].tag).toBe("spawn:cleanup");
    expect(steps[1].status).toBe("skipped");
    expect(steps[1].skipReason).toBe("不再需要");
  });

  // ---- 无步骤编号的行被忽略 ----

  it("should ignore lines without step numbers", () => {
    const content = [
      "# Checklist",
      "",
      "Some plain text",
      "- [x] 1.1 Actual step",
      "- [ ] Unnumbered checkbox step",
      "  - [ ] 1.2 Indented checkbox",
      "Just another line",
    ].join("\n");

    const steps = parseChecklist(content);

    // Only "1.1 Actual step" has a step number; indented line starts with space so regex ^- doesn't match
    expect(steps).toHaveLength(1);
    expect(steps[0].stepNumber).toBe("1.1");
  });

  it("should ignore phase headers and non-checkbox lines", () => {
    const content = [
      "# Phase 1: Setup",
      "## 1.0 Preparation",
      "- [ ] 1.1 Create project",
      "",
      "## Phase 2: Build",
      "- [x] 2.1 Build component",
      "- This is not a checkbox",
      "3.1 Random numbered line",
    ].join("\n");

    const steps = parseChecklist(content);

    expect(steps).toHaveLength(2);
    expect(steps[0].stepNumber).toBe("1.1");
    expect(steps[1].stepNumber).toBe("2.1");
  });

  // ---- 边界情况 ----

  it("should return empty array for empty content", () => {
    expect(parseChecklist("")).toEqual([]);
    expect(parseChecklist("   \n\n   ")).toEqual([]);
    expect(parseChecklist("# Some header\n## Another header\n")).toEqual([]);
  });

  it("should handle multi-level step numbers", () => {
    const content = [
      "- [ ] 1.1 Simple step",
      "- [ ] 10.20 Deeply nested step",
      "- [ ] 1.2.3 Multi-level step",
    ].join("\n");

    const steps = parseChecklist(content);

    expect(steps[0].stepNumber).toBe("1.1");
    expect(steps[1].stepNumber).toBe("10.20");
    expect(steps[2].stepNumber).toBe("1.2.3");
  });

  it("should treat lines with single numbers (no dot) as non-step lines", () => {
    const content = [
      "- [ ] 1 Single number step",
      "- [ ] 1.1 Proper step number",
    ].join("\n");

    const steps = parseChecklist(content);

    // "1" does not match \d+(?:\.\d+)+ — requires at least one dot
    expect(steps).toHaveLength(1);
    expect(steps[0].stepNumber).toBe("1.1");
  });
});

// ============================================================================
// markdownToSteps
// ============================================================================

describe("markdownToSteps", () => {
  // ---- 基础转换 ----

  it("should convert markdown to Step array with correct fields", () => {
    const content = [
      "- [ ] 1.1 Create project structure",
      "- [x] 1.2 Setup dependencies",
      "- [-] 1.3 Run tests (CI unavailable)",
    ].join("\n");

    const steps = markdownToSteps(content);

    expect(steps).toHaveLength(3);

    // Pending step
    expect(steps[0].id).toBe("1.1");
    expect(steps[0].status).toBe("pending");
    expect(steps[0].completed_at).toBeNull();
    expect(steps[0].tags).toEqual([]);
    expect(steps[0].text).toBe("Create project structure");

    // Completed step
    expect(steps[1].id).toBe("1.2");
    expect(steps[1].status).toBe("completed");
    expect(steps[1].completed_at).not.toBeNull();
    expect(steps[1].text).toBe("Setup dependencies");

    // Skipped step
    expect(steps[2].id).toBe("1.3");
    expect(steps[2].status).toBe("skipped");
    expect(steps[2].completed_at).not.toBeNull();
    expect(steps[2].skip_reason).toBe("CI unavailable");
    expect(steps[2].text).toBe("Run tests");
  });

  it("should strip step number, tag, and skip_reason from text", () => {
    const content = [
      "- [x] 1.1 [spawn:setup] Create project (fast track)",
    ].join("\n");

    const steps = markdownToSteps(content);

    expect(steps[0].text).toBe("Create project");
    expect(steps[0].tags).toEqual(["spawn:setup"]);
  });

  // ---- completed_at 保留 ----

  it("should preserve completed_at from existingSteps", () => {
    const content = [
      "- [x] 1.1 Step one",
      "- [x] 1.2 Step two",
      "- [ ] 1.3 Step three",
    ].join("\n");

    const existingSteps: Step[] = [
      {
        id: "1.1",
        text: "Step one",
        status: "completed",
        completed_at: "2025-01-15T10:00:00.000Z",
        tags: [],
      },
      {
        id: "1.2",
        text: "Step two",
        status: "completed",
        completed_at: "2025-01-16T12:00:00.000Z",
        tags: [],
      },
    ];

    const steps = markdownToSteps(content, existingSteps);

    // Should preserve original timestamps
    expect(steps[0].completed_at).toBe("2025-01-15T10:00:00.000Z");
    expect(steps[1].completed_at).toBe("2025-01-16T12:00:00.000Z");
    // Pending step stays null
    expect(steps[2].completed_at).toBeNull();
  });

  it("should use current timestamp for completed steps not in existingSteps", () => {
    const content = "- [x] 1.1 New completed step\n";

    const steps = markdownToSteps(content);

    expect(steps[0].completed_at).not.toBeNull();
    const ts = new Date(steps[0].completed_at!);
    expect(ts.getTime()).not.toBeNaN();
  });

  it("should use current timestamp when no existingSteps provided", () => {
    const content = [
      "- [x] 1.1 First step",
      "- [-] 1.2 Skipped step (reason)",
    ].join("\n");

    const steps = markdownToSteps(content);

    expect(steps[0].completed_at).not.toBeNull();
    expect(steps[1].completed_at).not.toBeNull();
  });

  // ---- 标签提取 ----

  it("should extract tags into the tags array", () => {
    const content = [
      "- [ ] 1.1 [spawn:alpha] Task alpha",
      "- [ ] 1.2 [spawn:beta] Task beta",
      "- [ ] 1.3 No tag task",
    ].join("\n");

    const steps = markdownToSteps(content);

    expect(steps[0].tags).toEqual(["spawn:alpha"]);
    expect(steps[1].tags).toEqual(["spawn:beta"]);
    expect(steps[2].tags).toEqual([]);
  });

  // ---- 边界情况 ----

  it("should return empty array for content with no step numbers", () => {
    const content = [
      "# Header",
      "- [ ] Unnumbered step",
      "Some text",
    ].join("\n");

    const steps = markdownToSteps(content);

    expect(steps).toEqual([]);
  });

  it("should return empty array for empty content", () => {
    expect(markdownToSteps("")).toEqual([]);
    expect(markdownToSteps("  \n\n  ")).toEqual([]);
  });
});

// ============================================================================
// calculateProgressFromSteps
// ============================================================================

describe("calculateProgressFromSteps", () => {
  // ---- 正常进度计算 ----

  it("should calculate normal progress correctly", () => {
    const steps: Step[] = [
      { id: "1.1", text: "A", status: "completed", completed_at: null, tags: [] },
      { id: "1.2", text: "B", status: "pending", completed_at: null, tags: [] },
      { id: "1.3", text: "C", status: "completed", completed_at: null, tags: [] },
      { id: "1.4", text: "D", status: "pending", completed_at: null, tags: [] },
    ];

    const progress = calculateProgressFromSteps(steps);

    expect(progress).toEqual({
      total: 4,
      completed: 2,
      skipped: 0,
      current_step: "1.2",
      percentage: 50,
    });
  });

  it("should return 100% when all steps are completed", () => {
    const steps: Step[] = [
      { id: "1.1", text: "A", status: "completed", completed_at: null, tags: [] },
      { id: "1.2", text: "B", status: "completed", completed_at: null, tags: [] },
      { id: "1.3", text: "C", status: "completed", completed_at: null, tags: [] },
    ];

    const progress = calculateProgressFromSteps(steps);

    expect(progress).toEqual({
      total: 3,
      completed: 3,
      skipped: 0,
      current_step: "",
      percentage: 100,
    });
  });

  it("should return zero progress for empty steps array", () => {
    const progress = calculateProgressFromSteps([]);

    expect(progress).toEqual({
      total: 0,
      completed: 0,
      skipped: 0,
      current_step: "",
      percentage: 0,
    });
  });

  // ---- skipped 单独计数 ----

  it("should count skipped steps separately from completed", () => {
    const steps: Step[] = [
      { id: "1.1", text: "A", status: "completed", completed_at: null, tags: [] },
      { id: "1.2", text: "B", status: "skipped", completed_at: null, tags: [], skip_reason: "n/a" },
      { id: "1.3", text: "C", status: "pending", completed_at: null, tags: [] },
      { id: "1.4", text: "D", status: "skipped", completed_at: null, tags: [], skip_reason: "skip" },
    ];

    const progress = calculateProgressFromSteps(steps);

    // skipped counted separately, percentage = completed / total (skipped not in denominator reduction)
    expect(progress.total).toBe(4);
    expect(progress.completed).toBe(1);
    expect(progress.skipped).toBe(2);
    expect(progress.percentage).toBe(25); // 1/4 = 25%
    expect(progress.current_step).toBe("1.3");
  });

  it("should not include skipped in percentage numerator", () => {
    const steps: Step[] = [
      { id: "1.1", text: "A", status: "completed", completed_at: null, tags: [] },
      { id: "1.2", text: "B", status: "skipped", completed_at: null, tags: [], skip_reason: "skip" },
      { id: "1.3", text: "C", status: "skipped", completed_at: null, tags: [], skip_reason: "skip" },
      { id: "1.4", text: "D", status: "completed", completed_at: null, tags: [] },
    ];

    const progress = calculateProgressFromSteps(steps);

    // 2 completed out of 4 total = 50%, not 100%
    expect(progress.completed).toBe(2);
    expect(progress.skipped).toBe(2);
    expect(progress.percentage).toBe(50);
    // No pending step → current_step is ""
    expect(progress.current_step).toBe("");
  });

  // ---- current_step ----

  it("should set current_step to the first pending step's id", () => {
    const steps: Step[] = [
      { id: "1.1", text: "A", status: "completed", completed_at: null, tags: [] },
      { id: "1.2", text: "B", status: "completed", completed_at: null, tags: [] },
      { id: "1.3", text: "C", status: "pending", completed_at: null, tags: [] },
      { id: "1.4", text: "D", status: "pending", completed_at: null, tags: [] },
    ];

    const progress = calculateProgressFromSteps(steps);

    expect(progress.current_step).toBe("1.3");
  });

  it("should set current_step to empty string when all done", () => {
    const steps: Step[] = [
      { id: "1.1", text: "A", status: "completed", completed_at: null, tags: [] },
      { id: "1.2", text: "B", status: "skipped", completed_at: null, tags: [] },
    ];

    const progress = calculateProgressFromSteps(steps);

    expect(progress.current_step).toBe("");
  });

  // ---- 百分比精度 ----

  it("should round percentage to integer", () => {
    const steps: Step[] = [
      { id: "1.1", text: "A", status: "completed", completed_at: null, tags: [] },
      { id: "1.2", text: "B", status: "completed", completed_at: null, tags: [] },
      { id: "1.3", text: "C", status: "pending", completed_at: null, tags: [] },
    ];

    const progress = calculateProgressFromSteps(steps);

    // 2/3 = 66.666... → 67
    expect(progress.percentage).toBe(67);
  });
});

// ============================================================================
// syncStepsToStatus
// ============================================================================

describe("syncStepsToStatus", () => {
  it("should write steps and calculated progress to status.yaml", () => {
    // 准备 status.yaml
    const statusData = {
      task_id: "test-task",
      title: "Test",
      status: "running",
      progress: { total: 0, completed: 0, current_step: "", percentage: 0 },
    };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    const steps: Step[] = [
      { id: "1.1", text: "Step A", status: "completed", completed_at: "2025-01-01T00:00:00.000Z", tags: [] },
      { id: "1.2", text: "Step B", status: "pending", completed_at: null, tags: [] },
      { id: "1.3", text: "Step C", status: "completed", completed_at: "2025-01-02T00:00:00.000Z", tags: [] },
      { id: "1.4", text: "Step D", status: "pending", completed_at: null, tags: [] },
    ];

    syncStepsToStatus(tmpDir, steps);

    const updated = YAML.parse(
      require("fs").readFileSync(join(tmpDir, "status.yaml"), "utf-8"),
    );

    // steps 应被写入
    expect(updated.steps).toHaveLength(4);
    expect(updated.steps[0].id).toBe("1.1");
    expect(updated.steps[1].id).toBe("1.2");

    // progress 应被计算并写入
    expect(updated.progress).toEqual({
      total: 4,
      completed: 2,
      skipped: 0,
      current_step: "1.2",
      percentage: 50,
    });

    // 原有字段应保留
    expect(updated.task_id).toBe("test-task");
    expect(updated.title).toBe("Test");
    expect(updated.status).toBe("running");
  });

  it("should silently skip when status.yaml does not exist", () => {
    const steps: Step[] = [
      { id: "1.1", text: "Step", status: "pending", completed_at: null, tags: [] },
    ];

    // 不应抛错
    expect(() => syncStepsToStatus(tmpDir, steps)).not.toThrow();
  });

  it("should handle empty steps array", () => {
    const statusData = { task_id: "test", progress: {} };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    syncStepsToStatus(tmpDir, []);

    const updated = YAML.parse(
      require("fs").readFileSync(join(tmpDir, "status.yaml"), "utf-8"),
    );

    expect(updated.steps).toEqual([]);
    expect(updated.progress).toEqual({
      total: 0,
      completed: 0,
      skipped: 0,
      current_step: "",
      percentage: 0,
    });
  });
});

// ============================================================================
// loadStepsFromStatus
// ============================================================================

describe("loadStepsFromStatus", () => {
  it("should read steps from status.yaml", () => {
    const statusData = {
      task_id: "test-task",
      steps: [
        { id: "1.1", text: "Step A", status: "completed", completed_at: "2025-01-01T00:00:00.000Z", tags: [] },
        { id: "1.2", text: "Step B", status: "pending", completed_at: null, tags: ["spawn:setup"] },
        { id: "1.3", text: "Step C", status: "skipped", completed_at: "2025-01-02T00:00:00.000Z", tags: [], skip_reason: "not needed" },
      ],
    };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    const steps = loadStepsFromStatus(tmpDir);

    expect(steps).toHaveLength(3);
    expect(steps![0].id).toBe("1.1");
    expect(steps![0].status).toBe("completed");
    expect(steps![1].tags).toEqual(["spawn:setup"]);
    expect(steps![2].skip_reason).toBe("not needed");
    expect(steps![2].status).toBe("skipped");
  });

  it("should return null when status.yaml does not exist", () => {
    expect(loadStepsFromStatus(tmpDir)).toBeNull();
  });

  it("should return null when steps field is missing", () => {
    const statusData = { task_id: "test-task", status: "running" };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    expect(loadStepsFromStatus(tmpDir)).toBeNull();
  });

  it("should return null when steps is an empty array", () => {
    const statusData = { task_id: "test-task", steps: [] };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    expect(loadStepsFromStatus(tmpDir)).toBeNull();
  });
});
