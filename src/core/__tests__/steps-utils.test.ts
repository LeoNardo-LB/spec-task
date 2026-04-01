import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  calculateProgressFromSteps,
  syncStepsToStatus,
  loadStepsFromStatus,
  validateStepsForCompletion,
  checkTransitionBlocked,
  checkVerificationBlocked,
  readCompletionConfig,
} from "../steps-utils.js";
import type { Step } from "../../types.js";

// ============================================================================
// 临时目录
// ============================================================================

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    process.env.TMPDIR ?? "/tmp",
    `steps-utils-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// calculateProgressFromSteps
// ============================================================================

describe("calculateProgressFromSteps", () => {
  // ---- 正常进度计算 ----

  it("should calculate normal progress correctly", () => {
    const steps: Step[] = [
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
      { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.4", summary: { title: "D", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
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
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
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
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [], skip_reason: "n/a" },
      { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
      { id: "1.4", summary: { title: "D", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [], skip_reason: "skip" },
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
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [], skip_reason: "skip" },
      { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [], skip_reason: "skip" },
      { id: "1.4", summary: { title: "D", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
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
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
      { id: "1.4", summary: { title: "D", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
    ];

    const progress = calculateProgressFromSteps(steps);

    expect(progress.current_step).toBe("1.3");
  });

  it("should set current_step to empty string when all done", () => {
    const steps: Step[] = [
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [] },
    ];

    const progress = calculateProgressFromSteps(steps);

    expect(progress.current_step).toBe("");
  });

  // ---- 百分比精度 ----

  it("should round percentage to integer", () => {
    const steps: Step[] = [
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
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
      progress: { total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 },
    };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    const steps: Step[] = [
      { id: "1.1", summary: { title: "Step A", content: "", approach: "", sources: [] }, status: "completed", completed_at: "2025-01-01T00:00:00.000Z", tags: [] },
      { id: "1.2", summary: { title: "Step B", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
      { id: "1.3", summary: { title: "Step C", content: "", approach: "", sources: [] }, status: "completed", completed_at: "2025-01-02T00:00:00.000Z", tags: [] },
      { id: "1.4", summary: { title: "Step D", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
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
      { id: "1.1", summary: { title: "Step", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
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
        { id: "1.1", summary: { title: "Step A", content: "", approach: "", sources: [] }, status: "completed", completed_at: "2025-01-01T00:00:00.000Z", tags: [] },
        { id: "1.2", summary: { title: "Step B", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: ["spawn:setup"] },
        { id: "1.3", summary: { title: "Step C", content: "", approach: "", sources: [] }, status: "skipped", completed_at: "2025-01-02T00:00:00.000Z", tags: [], skip_reason: "not needed" },
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

// ============================================================================
// validateStepsForCompletion
// ============================================================================

describe("validateStepsForCompletion", () => {
  it("should return valid: true when all steps are completed", () => {
    const steps: Step[] = [
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
    ];

    const result = validateStepsForCompletion(steps);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.incompleteStepIds).toBeUndefined();
  });

  it("should return valid: true when all steps are skipped", () => {
    const steps: Step[] = [
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [], skip_reason: "n/a" },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [], skip_reason: "skip" },
    ];

    const result = validateStepsForCompletion(steps);
    expect(result.valid).toBe(true);
  });

  it("should return valid: true when steps are mixed completed+skipped", () => {
    const steps: Step[] = [
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [] },
    ];

    const result = validateStepsForCompletion(steps);
    expect(result.valid).toBe(true);
  });

  it("should return valid: false with reason when steps is empty", () => {
    const result = validateStepsForCompletion([]);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("没有步骤数据");
    expect(result.incompleteStepIds).toBeUndefined();
  });

  it("should return valid: false with reason and incompleteStepIds when steps have pending items", () => {
    const steps: Step[] = [
      { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
      { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "running" as any, completed_at: null, tags: [] },
    ];

    const result = validateStepsForCompletion(steps);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("2 个步骤未完成");
    expect(result.reason).toContain("1.2, 1.3");
    expect(result.incompleteStepIds).toEqual(["1.2", "1.3"]);
  });

  it("should return valid: false when steps is non-array (null)", () => {
    const result = validateStepsForCompletion(null as any);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("没有步骤数据");
  });

  it("should return valid: false when steps is non-array (undefined)", () => {
    const result = validateStepsForCompletion(undefined as any);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("没有步骤数据");
  });
});

// ============================================================================
// checkTransitionBlocked
// ============================================================================

describe("checkTransitionBlocked", () => {
  it("should return blockReason when status.yaml has empty steps", () => {
    const statusData = { task_id: "test-task", steps: [] };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    const result = checkTransitionBlocked(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.blockReason).toContain("没有步骤数据");
  });

  it("should return blockReason when status.yaml has incomplete steps", () => {
    const statusData = {
      task_id: "test-task",
      steps: [
        { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
        { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
        { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
      ],
    };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    const result = checkTransitionBlocked(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.blockReason).toContain("2 个步骤未完成");
    expect(result!.blockReason).toContain("1.2, 1.3");
  });

  it("should return null when all steps are completed", () => {
    const statusData = {
      task_id: "test-task",
      steps: [
        { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
        { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
        { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      ],
    };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    expect(checkTransitionBlocked(tmpDir)).toBeNull();
  });

  it("should return null when all steps are skipped", () => {
    const statusData = {
      task_id: "test-task",
      steps: [
        { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [], skip_reason: "n/a" },
        { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [], skip_reason: "skip" },
      ],
    };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    expect(checkTransitionBlocked(tmpDir)).toBeNull();
  });

  it("should return null when steps are mixed completed+skipped", () => {
    const statusData = {
      task_id: "test-task",
      steps: [
        { id: "1.1", summary: { title: "A", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
        { id: "1.2", summary: { title: "B", content: "", approach: "", sources: [] }, status: "skipped", completed_at: null, tags: [] },
        { id: "1.3", summary: { title: "C", content: "", approach: "", sources: [] }, status: "completed", completed_at: null, tags: [] },
      ],
    };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    expect(checkTransitionBlocked(tmpDir)).toBeNull();
  });

  it("should return null when status.yaml does not exist", () => {
    expect(checkTransitionBlocked(tmpDir)).toBeNull();
  });

  it("should return null when status.yaml has invalid YAML", () => {
    writeFileSync(join(tmpDir, "status.yaml"), "{{invalid yaml content", "utf-8");

    expect(checkTransitionBlocked(tmpDir)).toBeNull();
  });
});

// ============================================================================
// readCompletionConfig
// ============================================================================

describe("readCompletionConfig", () => {
  it("should return requires_verification: true when config.yaml does not exist", () => {
    const config = readCompletionConfig(tmpDir);
    expect(config.requires_verification).toBe(true);
  });

  it("should return requires_verification: true when config.yaml has no completion field", () => {
    writeFileSync(join(tmpDir, "config.yaml"), YAML.stringify({ tracking: { level: "high" } }), "utf-8");
    const config = readCompletionConfig(tmpDir);
    expect(config.requires_verification).toBe(true);
  });

  it("should return requires_verification: false when explicitly set", () => {
    writeFileSync(join(tmpDir, "config.yaml"), YAML.stringify({ completion: { requires_verification: false } }), "utf-8");
    const config = readCompletionConfig(tmpDir);
    expect(config.requires_verification).toBe(false);
  });

  it("should return requires_verification: true when explicitly set", () => {
    writeFileSync(join(tmpDir, "config.yaml"), YAML.stringify({ completion: { requires_verification: true } }), "utf-8");
    const config = readCompletionConfig(tmpDir);
    expect(config.requires_verification).toBe(true);
  });
});

// ============================================================================
// checkVerificationBlocked
// ============================================================================

describe("checkVerificationBlocked", () => {
  const makeStatus = (verifStatus: string, criteria: Array<{ result: string }> = []) => ({
    task_id: "test-task",
    verification: { status: verifStatus, criteria, verified_at: null, verified_by: null },
  });

  it("should return blocked when verification.status is pending", () => {
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(makeStatus("pending", [
      { result: "passed" }, { result: "pending" },
    ])), "utf-8");

    const result = checkVerificationBlocked(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.blockReason).toContain("pending");
    expect(result!.blockReason).toContain("1/2");
    expect(result!.blockReason).toContain("task_verify");
  });

  it("should return null when verification.status is passed", () => {
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(makeStatus("passed", [
      { result: "passed" }, { result: "passed" },
    ])), "utf-8");

    expect(checkVerificationBlocked(tmpDir)).toBeNull();
  });

  it("should return blocked with repair guidance when verification.status is failed", () => {
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(makeStatus("failed", [
      { result: "passed" }, { result: "failed" },
    ])), "utf-8");

    const result = checkVerificationBlocked(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.blockReason).toContain("failed");
    expect(result!.blockReason).toContain("1/2");
    expect(result!.blockReason).toContain("修正失败项");
  });

  it("should return null when requires_verification is false", () => {
    writeFileSync(join(tmpDir, "config.yaml"), YAML.stringify({ completion: { requires_verification: false } }), "utf-8");
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(makeStatus("pending")), "utf-8");

    expect(checkVerificationBlocked(tmpDir)).toBeNull();
  });

  it("should default to true when config.yaml does not exist", () => {
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(makeStatus("pending")), "utf-8");

    const result = checkVerificationBlocked(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.blockReason).toContain("pending");
  });

  it("should default to true when config.yaml has no completion field", () => {
    writeFileSync(join(tmpDir, "config.yaml"), YAML.stringify({}), "utf-8");
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(makeStatus("pending")), "utf-8");

    const result = checkVerificationBlocked(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.blockReason).toContain("pending");
  });

  it("should return null when status.yaml does not exist", () => {
    expect(checkVerificationBlocked(tmpDir)).toBeNull();
  });
});
