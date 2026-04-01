/**
 * ============================================================================
 * E2E: Real Tool Function Tests
 * ============================================================================
 *
 * Calls all 8 tool functions DIRECTLY (not helpers/YAML simulation).
 * This is the most critical E2E test gap — validates the real execute*()
 * functions end-to-end with real filesystem operations.
 *
 * Tool functions under test:
 *   executeConfigMerge, executeTaskRecall, executeTaskCreate,
 *   executeTaskTransition, executeTaskLog, executeTaskVerify,
 *   executeTaskResume, executeTaskArchive
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, stat, writeFile } from "fs/promises";
import { join } from "path";

// ── Test helpers (only env creation + file-level helpers, NOT tool simulations) ──
import { createTestEnv, readStatus } from "./helpers.js";

// ── Real tool functions ──
import { executeTaskCreate } from "../../src/tools/task-create.js";
import { executeTaskTransition } from "../../src/tools/task-transition.js";
import { executeTaskLog } from "../../src/tools/task-log.js";
import { executeTaskVerify } from "../../src/tools/task-verify.js";
import { executeStepsUpdate } from "../../src/tools/steps-update.js";
import { executeTaskResume } from "../../src/tools/task-resume.js";
import { executeTaskArchive } from "../../src/tools/task-archive.js";
import { executeConfigMerge } from "../../src/tools/config-merge.js";
import { executeTaskRecall } from "../../src/tools/task-recall.js";

// ── Type imports (type-only) ──
import type { ToolResponse } from "../../src/tool-utils.js";
import type { TestEnv } from "./helpers.js";

// ============================================================================
// Helpers
// ============================================================================

/** Parse a ToolResponse into the underlying JSON object */
function parseResponse(response: ToolResponse): any {
  return JSON.parse(response.content[0].text);
}

/** Shorthand: call a tool and parse the result */
async function callAndParse(fn: (...args: any[]) => Promise<ToolResponse>, ...args: any[]): Promise<any> {
  return parseResponse(await fn(...args));
}

// ============================================================================
// Suite 1: Core Lifecycle (real tool calls)
// ============================================================================

describe("E2E Real Tools: Core Lifecycle", () => {
  let env: TestEnv;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("1. Full lifecycle via real tools: create → assigned → running → checklist → completed → verify", async () => {
    // Step 1: Create
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "lifecycle-full",
      project_root: env.projectRoot,
      title: "Full Lifecycle Test",
      assigned_to: "agent-1",
      brief: "## 目标\n全生命周期端到端测试",
    });
    expect(createResult.success).toBe(true);
    expect(createResult.status).toBe("pending");
    expect(createResult.task_id).toBe("lifecycle-full");
    expect(createResult.run_id).toBe("001");
    const taskDir: string = createResult.task_dir;

    // Verify task dir structure
    expect((await stat(taskDir)).isDirectory()).toBe(true);
    expect((await stat(join(taskDir, "status.yaml"))).isFile()).toBe(true);
    // outputs/, subtasks/, .gitignore are NOT pre-created
    expect(() => stat(join(taskDir, "outputs"))).rejects.toThrow();
    expect(() => stat(join(taskDir, "subtasks"))).rejects.toThrow();
    expect(() => stat(join(taskDir, ".gitignore"))).rejects.toThrow();

    // Step 2: Transition to assigned
    const assignedResult = await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir,
      status: "assigned",
      trigger: "coordinator",
      summary: "Assigned to agent-1",
    });
    expect(assignedResult.success).toBe(true);
    expect(assignedResult.old_status).toBe("pending");
    expect(assignedResult.new_status).toBe("assigned");

    // Step 3: Transition to running
    const runningResult = await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir,
      status: "running",
      trigger: "agent-1",
      summary: "Started execution",
    });
    expect(runningResult.success).toBe(true);
    expect(runningResult.new_status).toBe("running");

    // Step 4: No checklist in v0.3.0 — progress comes from steps in status.yaml

    // Step 5: Transition to completed (requires_verification: false for E2E lifecycle test)
    await writeFile(join(taskDir, "config.yaml"), "completion:\n  requires_verification: false\n", "utf-8");
    const completedResult = await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir,
      status: "completed",
      trigger: "agent-1",
      summary: "All steps completed",
    });
    expect(completedResult.success).toBe(true);
    expect(completedResult.new_status).toBe("completed");
    // Progress calculated from steps (no steps in status.yaml → all zeros)
    expect(completedResult.progress.total).toBe(0);
    expect(completedResult.progress.completed).toBe(0);

    // Step 6: Verify final state via status.yaml
    const status = await readStatus(taskDir);
    expect(status.status).toBe("completed");
    expect(status.completed_at).not.toBeNull();
    expect(status.completed_at).not.toBe("");
    expect(status.started_at).not.toBeNull();
    // Progress calculated from steps (no steps in status.yaml → all zeros)

    // Verify revision trail: created → assigned → running → completed
    expect(status.revisions.length).toBe(4);
    expect(status.revisions[0].type).toBe("created");
    expect(status.revisions[1].type).toBe("status_change");
    expect(status.revisions[2].type).toBe("status_change");
    expect(status.revisions[3].type).toBe("status_change");
  });

  it("2. task_create creates task dir with status.yaml only", async () => {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "subdir-check",
      project_root: env.projectRoot,
      title: "Subdir Check",
      brief: "## 目标\n子目录检查测试",
    });
    expect(createResult.success).toBe(true);
    const taskDir: string = createResult.task_dir;

    // Verify task dir structure
    expect((await stat(taskDir)).isDirectory()).toBe(true);
    expect((await stat(join(taskDir, "status.yaml"))).isFile()).toBe(true);
    // outputs/, subtasks/, .gitignore are NOT pre-created
    expect(() => stat(join(taskDir, "outputs"))).rejects.toThrow();
    expect(() => stat(join(taskDir, "subtasks"))).rejects.toThrow();
    expect(() => stat(join(taskDir, ".gitignore"))).rejects.toThrow();
    // v0.3.0: task_dir points to runs/001/
    expect(taskDir).toContain("runs");
    expect(taskDir).toContain("001");
  });

  it("3. task_transition state machine enforcement: pending → running should fail", async () => {
    // Create task (status: pending)
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "state-machine-test",
      project_root: env.projectRoot,
      brief: "## 目标\n状态机测试",
    });
    const taskDir: string = createResult.task_dir;

    // Attempt invalid transition: pending → running (should be pending → assigned first)
    const invalidResult = await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir,
      status: "running",
    });
    expect(invalidResult.success).toBe(false);
    expect(invalidResult.error).toBe("INVALID_TRANSITION");
    expect(invalidResult.message).toContain("pending");
    expect(invalidResult.message).toContain("running");

    // Verify status unchanged
    const status = await readStatus(taskDir);
    expect(status.status).toBe("pending");
  });

  it("4. task_transition running → running skips revision", async () => {
    // Create → assigned → running
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "running-skip-rev",
      project_root: env.projectRoot,
      brief: "## 目标\n运行跳过修订测试",
    });
    const taskDir: string = createResult.task_dir;

    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "running",
    });

    // Check revision count: created + assigned + running = 3
    let status = await readStatus(taskDir);
    expect(status.revisions.length).toBe(3);

    // Transition running → running (should skip revision)
    const result = await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir,
      status: "running",
      summary: "Progress update",
    });
    expect(result.success).toBe(true);
    expect(result.revision_id).toBe(-1); // -1 means skipped

    // Revision count unchanged
    status = await readStatus(taskDir);
    expect(status.revisions.length).toBe(3);

    // Status still running
    expect(status.status).toBe("running");
  });

  it("5. task_verify add-criterion then finalize auto-complete", async () => {
    // Create → assigned → running
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "verify-autocomplete",
      project_root: env.projectRoot,
      assigned_to: "agent-1",
      brief: "## 目标\n验证自动完成测试",
    });
    const taskDir: string = createResult.task_dir;

    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "running",
    });

    // Add criteria (all passed)
    const crit1 = await callAndParse(executeTaskVerify, "test-id", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Tests pass", result: "passed", evidence: "48/48 passed" },
    });
    expect(crit1.success).toBe(true);
    expect(crit1.total_criteria).toBe(1);
    expect(crit1.passed).toBe(1);

    const crit2 = await callAndParse(executeTaskVerify, "test-id", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "No regressions", result: "passed", evidence: "Baseline OK" },
    });
    expect(crit2.success).toBe(true);
    expect(crit2.total_criteria).toBe(2);
    expect(crit2.passed).toBe(2);

    // Add completed steps so auto-complete can pass steps validation
    await callAndParse(executeStepsUpdate, "test-id", {
      task_dir: taskDir,
      steps: [
        { id: "1.1", summary: { title: "Step 1", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
      ],
    });

    // Finalize → should auto-complete since all criteria passed + status is "running"
    const finalizeResult = await callAndParse(executeTaskVerify, "test-id", {
      task_dir: taskDir,
      action: { action: "finalize", verified_by: "agent-1" },
    });
    expect(finalizeResult.success).toBe(true);
    expect(finalizeResult.verification_status).toBe("passed");
    expect(finalizeResult.auto_completed).toBe(true);

    // Verify final state
    const status = await readStatus(taskDir);
    expect(status.status).toBe("completed");
    expect(status.completed_at).not.toBeNull();
    expect(status.verification.status).toBe("passed");
    expect(status.verification.verified_by).toBe("agent-1");
    expect(status.verification.verified_at).not.toBeNull();

    // Revisions: created + assigned + running + auto-complete = 4
    expect(status.revisions.length).toBe(4);
    const autoRev = status.revisions[3];
    expect(autoRev.summary).toContain("Auto-completed");
  });
});

// ============================================================================
// Suite 2: task_log (all 6 actions)
// ============================================================================

describe("E2E Real Tools: task_log", () => {
  let env: TestEnv;
  let taskDir: string;

  beforeEach(async () => {
    env = await createTestEnv();
    // Create a running task for log tests
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "log-test-task",
      project_root: env.projectRoot,
      brief: "## 目标\n日志测试任务",
    });
    taskDir = createResult.task_dir;
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "running",
    });
  });
  afterEach(async () => { await env.cleanup(); });

  it("6. task_log error: log error and verify in status", async () => {
    const result = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "error", step: "1.2", message: "Database connection timeout" },
    });
    expect(result.success).toBe(true);
    expect(result.action).toBe("error");
    expect(result.step).toBe("1.2");
    expect(result.total_errors).toBe(1);

    // Verify persisted in status.yaml
    const status = await readStatus(taskDir);
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].step).toBe("1.2");
    expect(status.errors[0].message).toBe("Database connection timeout");
    expect(status.errors[0].retry_count).toBe(0);
    expect(status.errors[0].timestamp).not.toBe("");
  });

  it("7. task_log error always appends: log same error twice, check both exist", async () => {
    // Log first error
    await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "error", step: "2.1", message: "File not found" },
    });

    // Log same error again
    const result2 = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "error", step: "2.1", message: "File not found" },
    });
    expect(result2.success).toBe(true);
    expect(result2.total_errors).toBe(2);

    // Verify both records exist
    const status = await readStatus(taskDir);
    expect(status.errors).toHaveLength(2);
    expect(status.errors[0].step).toBe("2.1");
    expect(status.errors[1].step).toBe("2.1");
    expect(status.errors[0].message).toBe("File not found");
    expect(status.errors[1].message).toBe("File not found");
    // Both should be separate records with different timestamps
    expect(status.errors[0].timestamp).not.toBe(status.errors[1].timestamp);
  });

  it("8. task_log retry without matching error: fallback creates new record", async () => {
    // Retry a step that has no corresponding error record
    const result = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "retry", step: "3.1" },
    });
    expect(result.success).toBe(true);
    expect(result.action).toBe("retry");
    expect(result.step).toBe("3.1");
    expect(result.retry_count).toBe(1);
    expect(result.created).toBe(true);

    // Verify a new error record was created as fallback
    const status = await readStatus(taskDir);
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].step).toBe("3.1");
    expect(status.errors[0].message).toContain("Retry initiated for step");
    expect(status.errors[0].retry_count).toBe(1);
  });

  it("9. task_log retry with matching error: increment retry_count", async () => {
    // First log an error
    await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "error", step: "4.1", message: "API rate limit exceeded" },
    });

    // Then retry the same step
    const retryResult = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "retry", step: "4.1" },
    });
    expect(retryResult.success).toBe(true);
    expect(retryResult.retry_count).toBe(1);
    expect(retryResult.created).toBeUndefined(); // Not created, matched existing

    // Retry again
    const retryResult2 = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "retry", step: "4.1" },
    });
    expect(retryResult2.retry_count).toBe(2);

    // Verify the original error record was updated in place
    const status = await readStatus(taskDir);
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].step).toBe("4.1");
    expect(status.errors[0].message).toBe("API rate limit exceeded");
    expect(status.errors[0].retry_count).toBe(2);
  });

  it("10. task_log add-block + remove-block", async () => {
    // Add a block
    const addResult = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "add-block", task: "upstream-task", reason: "Waiting for data" },
    });
    expect(addResult.success).toBe(true);
    expect(addResult.action).toBe("add-block");
    expect(addResult.task).toBe("upstream-task");

    let status = await readStatus(taskDir);
    expect(status.blocked_by).toHaveLength(1);
    expect(status.blocked_by[0].task).toBe("upstream-task");
    expect(status.blocked_by[0].reason).toBe("Waiting for data");

    // Remove the block
    const removeResult = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "remove-block", task: "upstream-task" },
    });
    expect(removeResult.success).toBe(true);
    expect(removeResult.action).toBe("remove-block");

    status = await readStatus(taskDir);
    expect(status.blocked_by).toHaveLength(0);
  });

  it("11. task_log output path resolution: relative path resolved to absolute", async () => {
    // Add output with relative path
    const result = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "output", path: "outputs/result.json" },
    });
    expect(result.success).toBe(true);
    expect(result.action).toBe("output");
    expect(result.path).toMatch(/^\/.*outputs\/result\.json$/); // Absolute path
    expect(result.total_outputs).toBe(1);

    // Verify in status
    const status = await readStatus(taskDir);
    expect(status.outputs).toHaveLength(1);
    expect(status.outputs[0]).toBe(result.path);
    expect(status.outputs[0]).not.toBe("outputs/result.json"); // Not the relative path

    // Absolute path should be stored as-is
    const absResult = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "output", path: "/tmp/absolute-output.txt" },
    });
    expect(absResult.path).toBe("/tmp/absolute-output.txt");
  });

  it("task_log duplicate block returns error", async () => {
    // Add block once
    await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "add-block", task: "dup-task", reason: "First block" },
    });

    // Try to add same block again
    const dupResult = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "add-block", task: "dup-task", reason: "Duplicate" },
    });
    expect(dupResult.success).toBe(false);
    expect(dupResult.error).toBe("DUPLICATE_BLOCK");
  });

  it("task_log remove non-existent block returns error", async () => {
    const result = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "remove-block", task: "ghost-task" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("BLOCK_NOT_FOUND");
  });

  it("task_log duplicate output returns error", async () => {
    await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "output", path: "outputs/data.csv" },
    });

    const dupResult = await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "output", path: "outputs/data.csv" },
    });
    expect(dupResult.success).toBe(false);
    expect(dupResult.error).toBe("DUPLICATE_OUTPUT");
  });
});

// ============================================================================
// Suite 3: task_resume (next_action)
// ============================================================================

describe("E2E Real Tools: task_resume", () => {
  let env: TestEnv;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("12. task_resume on pending task: returns '等待分配'", async () => {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "resume-pending",
      project_root: env.projectRoot,
      brief: "## 目标\n恢复待分配测试",
    });
    const taskDir: string = createResult.task_dir;

    const resumeResult = await callAndParse(executeTaskResume, "test-id", {
      task_dir: taskDir,
    });
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.status).toBe("pending");
    expect(resumeResult.next_action).toContain("等待分配");
    expect(resumeResult.next_action).toContain("task_transition assigned");
    expect(resumeResult.details.task_id).toBe("resume-pending");
  });

  it("13. task_resume on running with error: shows error message", async () => {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "resume-error",
      project_root: env.projectRoot,
      brief: "## 目标\n恢复错误测试",
    });
    const taskDir: string = createResult.task_dir;

    // Transition to running
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "running",
    });

    // Log an error
    await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "error", step: "2.3", message: "Network timeout after 30s" },
    });

    // Resume should show the error
    const resumeResult = await callAndParse(executeTaskResume, "test-id", {
      task_dir: taskDir,
    });
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.status).toBe("running");
    expect(resumeResult.next_action).toContain("修复错误");
    expect(resumeResult.next_action).toContain("2.3");
    expect(resumeResult.next_action).toContain("Network timeout");
    expect(resumeResult.errors).toHaveLength(1);
  });

  it("14. task_resume on blocked task: shows blocker", async () => {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "resume-blocked",
      project_root: env.projectRoot,
      brief: "## 目标\n恢复阻塞测试",
    });
    const taskDir: string = createResult.task_dir;

    // Create → assigned → running → add block → blocked
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "running",
    });

    // Add block via task_log
    await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "add-block", task: "dep-task-alpha", reason: "Needs alpha output" },
    });

    // Transition to blocked
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir,
      status: "blocked",
    });

    // Resume should show the blocker
    const resumeResult = await callAndParse(executeTaskResume, "test-id", {
      task_dir: taskDir,
    });
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.status).toBe("blocked");
    expect(resumeResult.next_action).toContain("等待阻塞解除");
    expect(resumeResult.next_action).toContain("dep-task-alpha");
  });

  it("15. task_resume on revised with resume_from: shows resume point", async () => {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "resume-revised",
      project_root: env.projectRoot,
      brief: "## 目标\n恢复修订测试",
    });
    const taskDir: string = createResult.task_dir;

    // Create → assigned → running
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "running",
    });

    // Transition to revised with user_request revision_type and summary
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir,
      status: "revised",
      revision_type: "user_request",
      summary: "User requested changes: refactor API layer",
      trigger: "user",
    });

    // Resume should show revised message (resume_from no longer stored in Revision)
    const resumeResult = await callAndParse(executeTaskResume, "test-id", {
      task_dir: taskDir,
    });
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.status).toBe("revised");
    expect(resumeResult.next_action).toContain("需要重新规划");
    // resume_from no longer stored in Revision, so next_action uses default message
  });

  it("task_resume on completed task: suggests archive", async () => {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "resume-completed",
      project_root: env.projectRoot,
      brief: "## 目标\n恢复完成测试",
    });
    const taskDir: string = createResult.task_dir;

    // Fast path to completed
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "running",
    });
    // Set requires_verification: false for E2E test (verification guard is tested separately)
    await writeFile(join(taskDir, "config.yaml"), "completion:\n  requires_verification: false\n", "utf-8");
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "completed",
    });

    const resumeResult = await callAndParse(executeTaskResume, "test-id", {
      task_dir: taskDir,
    });
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.status).toBe("completed");
    expect(resumeResult.next_action).toContain("已完成");
    expect(resumeResult.next_action).toContain("task_archive");
  });

  it("task_resume on cancelled task: shows cannot recover", async () => {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "resume-cancelled",
      project_root: env.projectRoot,
      brief: "## 目标\n恢复取消测试",
    });
    const taskDir: string = createResult.task_dir;

    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "cancelled",
    });

    const resumeResult = await callAndParse(executeTaskResume, "test-id", {
      task_dir: taskDir,
    });
    expect(resumeResult.status).toBe("cancelled");
    expect(resumeResult.next_action).toContain("已取消");
    expect(resumeResult.next_action).toContain("无法恢复");
  });
});

// ============================================================================
// Suite 4: task_archive
// ============================================================================

describe("E2E Real Tools: task_archive", () => {
  let env: TestEnv;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  /** Helper: create a completed task via real tools */
  async function createCompletedTask(taskName: string): Promise<string> {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: taskName,
      project_root: env.projectRoot,
      assigned_to: "archive-agent",
      brief: `## 目标\n${taskName}`,
    });
    const taskDir: string = createResult.task_dir;

    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "running",
    });

    // v0.3.0: progress comes from steps, not checklist.md

    // Complete via transition (requires_verification: false for E2E helper)
    await writeFile(join(taskDir, "config.yaml"), "completion:\n  requires_verification: false\n", "utf-8");
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "completed",
    });

    return taskDir;
  }

  it("16. task_archive dry_run: returns planned actions without writing files", async () => {
    const taskDir = await createCompletedTask("archive-dry-run");

    const result = await callAndParse(executeTaskArchive, "test-id", {
      task_dir: taskDir,
      agent_workspace: env.agentWorkspace,
      project_root: env.projectRoot,
      agent_name: "archiver",
      dry_run: true,
    });
    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.results).toHaveLength(2);

    // Verify planned actions
    const historyAction = result.results.find(
      (r: any) => r.action === "create",
    );
    expect(historyAction).toBeDefined();
    expect(historyAction.status).toBe("planned");
    expect(historyAction.file).toContain("task-history");
    expect(historyAction.file).toContain("archive-dry-run.md");

    const lessonsAction = result.results.find(
      (r: any) => r.action === "create_or_append",
    );
    expect(lessonsAction).toBeDefined();
    expect(lessonsAction.status).toBe("planned");
    expect(lessonsAction.file).toContain("task-lessons");
    expect(lessonsAction.file).toContain("archive-dry-run.md");

    // Verify NO files were actually created
    const historyDir = join(env.agentWorkspace, "memory", "task-history");
    const { readdir } = await import("fs/promises");
    try {
      const entries = await readdir(historyDir);
      // If directory exists, it should be empty (no date subdirs)
      expect(entries).toHaveLength(0);
    } catch {
      // Directory doesn't exist at all — also fine for dry_run
    }
  });

  it("17. task_archive real: creates history and lessons files", async () => {
    const taskDir = await createCompletedTask("archive-real");

    // Write a brief.md to task root (not run dir) — first line becomes the archive title
    const taskRoot = join(taskDir, "..", "..");
    await writeFile(join(taskRoot, "brief.md"), "Implement Auth Module\n\nJWT authentication with refresh tokens.", "utf-8");

    const result = await callAndParse(executeTaskArchive, "test-id", {
      task_dir: taskDir,
      agent_workspace: env.agentWorkspace,
      project_root: env.projectRoot,
      agent_name: "archiver",
    });
    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(false);
    // Archive creates: history file + lessons file + possibly spec extraction
    expect(result.results.length).toBeGreaterThanOrEqual(2);

    // Both files should be created (not appended since first time)
    const historyAction = result.results.find((r: any) => r.action === "create");
    expect(historyAction).toBeDefined();
    expect(historyAction.status).toBe("created");

    const lessonsAction = result.results.find((r: any) => r.action === "create");
    expect(lessonsAction).toBeDefined();

    // Verify history file exists and has content
    // readBrief() returns first line of brief.md → title becomes "# {firstLine}"
    const { readFile } = await import("fs/promises");
    const historyFile = historyAction.file;
    const historyContent = await readFile(historyFile, "utf-8");
    expect(historyContent).toContain("archive-real");
    expect(historyContent).toContain("Implement Auth Module");
    expect(historyContent).toContain("completed");
    expect(historyContent).toContain("archiver");

    // Verify lessons file exists
    const lessonsFile = result.results.find((r: any) => r.file.includes("task-lessons")).file;
    const lessonsContent = await readFile(lessonsFile, "utf-8");
    expect(lessonsContent).toContain("Lessons");
    expect(lessonsContent).toContain("archive-real");
  });

  it("task_archive on non-existent task returns error", async () => {
    const result = await callAndParse(executeTaskArchive, "test-id", {
      task_dir: "/tmp/nonexistent-task-dir",
      agent_workspace: env.agentWorkspace,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("TASK_NOT_FOUND");
  });

  it("task_archive idempotent: second archive skips history file", async () => {
    const taskDir = await createCompletedTask("archive-idempotent");

    // First archive
    await callAndParse(executeTaskArchive, "test-id", {
      task_dir: taskDir,
      agent_workspace: env.agentWorkspace,
      project_root: env.projectRoot,
    });

    // Second archive — history file should be skipped (already exists)
    const result2 = await callAndParse(executeTaskArchive, "test-id", {
      task_dir: taskDir,
      agent_workspace: env.agentWorkspace,
      project_root: env.projectRoot,
    });
    expect(result2.success).toBe(true);

    const historyAction = result2.results.find(
      (r: any) => r.file.includes("task-history"),
    );
    expect(historyAction.action).toBe("skip");
    expect(historyAction.status).toBe("already_exists");

    // Lessons file should be appended
    const lessonsAction = result2.results.find(
      (r: any) => r.file.includes("task-lessons"),
    );
    expect(lessonsAction.action).toBe("append");
    expect(lessonsAction.status).toBe("appended");
  });
});

// ============================================================================
// Suite 5: config_merge + task_recall
// ============================================================================

describe("E2E Real Tools: config_merge + task_recall", () => {
  let env: TestEnv;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("18. config_merge: reads config.yaml and returns merged config", async () => {
    const result = await callAndParse(executeConfigMerge, "test-id", {
      project_root: env.projectRoot,
      format: "json",
    });
    expect(result.success).toBe(true);
    expect(result.config).toBeDefined();
    expect(result.config.context).toBe("e2e-test");
    expect(result.config.runtime).toBeDefined();
    expect(result.config.runtime.allow_agent_self_delegation).toBe(true);
    expect(result.config.runtime.task_timeout).toBe(60);
    expect(result.config.archive).toBeDefined();
    expect(result.config.archive.record_history).toBe(true);
    expect(result.config.archive.generate_lessons).toBe(true);
  });

  it("config_merge with yaml format: returns config_yaml string", async () => {
    const result = await callAndParse(executeConfigMerge, "test-id", {
      project_root: env.projectRoot,
      format: "yaml",
    });
    expect(result.success).toBe(true);
    expect(result.format).toBe("yaml");
    expect(result.config_yaml).toBeDefined();
    expect(typeof result.config_yaml).toBe("string");
    expect(result.config_yaml).toContain("e2e-test");
    expect(result.config_yaml).toContain("allow_agent_self_delegation");
  });

  it("config_merge with invalid format returns error", async () => {
    const result = await callAndParse(executeConfigMerge, "test-id", {
      project_root: env.projectRoot,
      format: "xml" as any,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("CONFIG_NOT_FOUND");
  });

  it("19. task_recall: creates .md files in memory dirs, searches with keywords", async () => {
    // Create memory directories
    const historyDir = join(env.agentWorkspace, "memory", "task-history", "2026-03-29");
    const lessonsDir = join(env.agentWorkspace, "memory", "task-lessons");
    await mkdir(historyDir, { recursive: true });
    await mkdir(lessonsDir, { recursive: true });

    // Create .md files with searchable content
    await writeFile(
      join(historyDir, "auth-module.md"),
      "# Auth Module\n\nImplemented JWT authentication with refresh tokens.\nUsed bcrypt for password hashing.",
      "utf-8",
    );
    await writeFile(
      join(lessonsDir, "database-optimization.md"),
      "# Lessons: Database Optimization\n\nKey insight: indexing strategy matters.\nAdded composite index on user_email column.",
      "utf-8",
    );
    await writeFile(
      join(historyDir, "api-gateway.md"),
      "# API Gateway\n\nSet up rate limiting and request validation.",
      "utf-8",
    );

    // Search for "authentication" — should match auth-module.md
    const authResult = await callAndParse(executeTaskRecall, "test-id", {
      keywords: "authentication JWT",
      agent_workspace: env.agentWorkspace,
    });
    expect(authResult.success).toBe(true);
    expect(authResult.total_matches).toBeGreaterThanOrEqual(1);
    expect(authResult.results.length).toBeGreaterThanOrEqual(1);
    // The top result should be auth-module.md (has both "authentication" and "JWT")
    const topResult = authResult.results[0];
    expect(topResult.file).toContain("auth-module");
    expect(topResult.snippet).toContain("authentication");
    expect(topResult.score).toBeGreaterThanOrEqual(1);

    // Search for "indexing database" — should match database-optimization.md
    const dbResult = await callAndParse(executeTaskRecall, "test-id", {
      keywords: "indexing database",
      agent_workspace: env.agentWorkspace,
    });
    expect(dbResult.success).toBe(true);
    expect(dbResult.total_matches).toBeGreaterThanOrEqual(1);
    const dbTop = dbResult.results[0];
    expect(dbTop.file).toContain("database-optimization");

    // Search with stop words only — should return empty results
    const stopWordsResult = await callAndParse(executeTaskRecall, "test-id", {
      keywords: "the and is",
      agent_workspace: env.agentWorkspace,
    });
    expect(stopWordsResult.success).toBe(true);
    expect(stopWordsResult.keywords).toEqual([]);
    expect(stopWordsResult.total_matches).toBe(0);
    expect(stopWordsResult.results).toEqual([]);
  });

  it("task_recall respects top parameter", async () => {
    // Create multiple matching files
    const historyDir = join(env.agentWorkspace, "memory", "task-history", "2026-03-29");
    await mkdir(historyDir, { recursive: true });

    for (let i = 1; i <= 5; i++) {
      await writeFile(
        join(historyDir, `task-${i}.md`),
        `# Task ${i}\n\nPerformance optimization with caching strategy.\n`,
        "utf-8",
      );
    }

    const result = await callAndParse(executeTaskRecall, "test-id", {
      keywords: "caching optimization",
      agent_workspace: env.agentWorkspace,
      top: 2,
    });
    expect(result.success).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.total_matches).toBe(5); // All 5 match, but only 2 returned
  });

  it("task_recall with empty keywords returns empty", async () => {
    const result = await callAndParse(executeTaskRecall, "test-id", {
      keywords: "",
      agent_workspace: env.agentWorkspace,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });
});

// ============================================================================
// Suite 6: Cross-tool Integration
// ============================================================================

describe("E2E Real Tools: Cross-tool Integration", () => {
  let env: TestEnv;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("task_verify get returns current verification state", async () => {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "verify-get-test",
      project_root: env.projectRoot,
      brief: "## 目标\n验证获取测试",
    });
    const taskDir: string = createResult.task_dir;

    // Get verification state (initial: pending with no criteria)
    const getResult = await callAndParse(executeTaskVerify, "test-id", {
      task_dir: taskDir,
      action: { action: "get" },
    });
    expect(getResult.success).toBe(true);
    expect(getResult.verification.status).toBe("pending");
    expect(getResult.verification.criteria).toEqual([]);
    expect(getResult.verification.verified_at).toBeNull();
  });

  it("task_verify finalize with no criteria returns error", async () => {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "verify-no-criteria",
      project_root: env.projectRoot,
      brief: "## 目标\n无标准验证测试",
    });
    const taskDir: string = createResult.task_dir;

    const result = await callAndParse(executeTaskVerify, "test-id", {
      task_dir: taskDir,
      action: { action: "finalize" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("NO_CRITERIA");
  });

  it("task_verify finalize with failed criteria does NOT auto-complete", async () => {
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "verify-failed",
      project_root: env.projectRoot,
      brief: "## 目标\n验证失败测试",
    });
    const taskDir: string = createResult.task_dir;

    // assigned → running
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "running",
    });

    // Add a failed criterion
    await callAndParse(executeTaskVerify, "test-id", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Tests pass", result: "failed", evidence: "3/48 failed" },
    });

    // Finalize — should NOT auto-complete
    const finalizeResult = await callAndParse(executeTaskVerify, "test-id", {
      task_dir: taskDir,
      action: { action: "finalize", verified_by: "tester" },
    });
    expect(finalizeResult.success).toBe(true);
    expect(finalizeResult.verification_status).toBe("failed");
    expect(finalizeResult.auto_completed).toBe(false);

    // Status should still be running
    const status = await readStatus(taskDir);
    expect(status.status).toBe("running");
  });

  it("task_create with duplicate name returns error", async () => {
    await callAndParse(executeTaskCreate, "test-id", {
      task_name: "duplicate-task",
      project_root: env.projectRoot,
      brief: "## 目标\n重复任务测试",
    });

    const dupResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "duplicate-task",
      project_root: env.projectRoot,
      brief: "## 目标\n重复任务测试",
    });
    expect(dupResult.success).toBe(false);
    // First run is still pending (non-terminal), so TASK_HAS_ACTIVE_RUNS
    expect(dupResult.error).toBe("TASK_HAS_ACTIVE_RUNS");
  });

  it("task_create with invalid task_name returns error", async () => {
    const slashResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "has/slash",
      project_root: env.projectRoot,
    });
    expect(slashResult.success).toBe(false);
    expect(slashResult.error).toBe("INVALID_PARAMS");

    const emptyResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "",
      project_root: env.projectRoot,
    });
    expect(emptyResult.success).toBe(false);
    expect(emptyResult.error).toBe("INVALID_PARAMS");
  });

  // ════════════════════════════════════════════════════════════════
  // task_verify suggested_criteria (功能 A)
  // ════════════════════════════════════════════════════════════════

  describe("task_verify suggested_criteria", () => {
    it("add-criterion returns suggested_criteria for uncovered steps", async () => {
      // 创建任务并设置 3 个 steps
      const createResult = await callAndParse(executeTaskCreate, "test-id", {
        task_name: "suggest-add",
        project_root: env.projectRoot,
        brief: "## 目标\n建议测试",
      });
      const taskDir: string = createResult.task_dir;

      await callAndParse(executeStepsUpdate, "test-id", {
        task_dir: taskDir,
        steps: [
          { id: "1.1", summary: { title: "实现登录", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
          { id: "1.2", summary: { title: "实现注册", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
          { id: "2.1", summary: { title: "实现注销", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
        ],
      });

      // 添加 1 个 criterion，覆盖步骤 1.1
      const result = await callAndParse(executeTaskVerify, "test-id", {
        task_dir: taskDir,
        action: { action: "add-criterion", criterion: "验证步骤 1.1: 实现登录", result: "passed" },
      });

      expect(result.success).toBe(true);
      expect(result.suggested_criteria).toBeDefined();
      expect(result.suggested_criteria).toHaveLength(2);
      // 应包含 1.2 和 2.1 的建议
      const suggestionTexts = result.suggested_criteria.join(" ");
      expect(suggestionTexts).toContain("1.2");
      expect(suggestionTexts).toContain("2.1");
    });

    it("add-criterion returns no suggestions when all covered", async () => {
      const createResult = await callAndParse(executeTaskCreate, "test-id", {
        task_name: "suggest-all-covered",
        project_root: env.projectRoot,
        brief: "## 目标\n全覆盖测试",
      });
      const taskDir: string = createResult.task_dir;

      await callAndParse(executeStepsUpdate, "test-id", {
        task_dir: taskDir,
        steps: [
          { id: "1.1", summary: { title: "功能A", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
          { id: "1.2", summary: { title: "功能B", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
          { id: "2.1", summary: { title: "功能C", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
        ],
      });

      // 添加 3 个 criteria 全覆盖
      await callAndParse(executeTaskVerify, "test-id", {
        task_dir: taskDir,
        action: { action: "add-criterion", criterion: "验证步骤 1.1: 功能A", result: "passed" },
      });
      await callAndParse(executeTaskVerify, "test-id", {
        task_dir: taskDir,
        action: { action: "add-criterion", criterion: "验证步骤 1.2: 功能B", result: "passed" },
      });

      const result = await callAndParse(executeTaskVerify, "test-id", {
        task_dir: taskDir,
        action: { action: "add-criterion", criterion: "验证步骤 2.1: 功能C", result: "passed" },
      });

      expect(result.success).toBe(true);
      expect(result.suggested_criteria).toBeUndefined();
    });

    it("get returns suggested_criteria", async () => {
      const createResult = await callAndParse(executeTaskCreate, "test-id", {
        task_name: "suggest-get",
        project_root: env.projectRoot,
        brief: "## 目标\nget 建议测试",
      });
      const taskDir: string = createResult.task_dir;

      await callAndParse(executeStepsUpdate, "test-id", {
        task_dir: taskDir,
        steps: [
          { id: "1.1", summary: { title: "实现登录", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
          { id: "1.2", summary: { title: "实现注册", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
          { id: "2.1", summary: { title: "实现注销", content: "", approach: "", sources: [] }, status: "pending", completed_at: null, tags: [] },
        ],
      });

      // get 时 0 criteria → 3 条建议
      const result = await callAndParse(executeTaskVerify, "test-id", {
        task_dir: taskDir,
        action: { action: "get" },
      });

      expect(result.success).toBe(true);
      expect(result.suggested_criteria).toBeDefined();
      expect(result.suggested_criteria).toHaveLength(3);
    });

    it("get returns no suggestions when steps empty", async () => {
      const createResult = await callAndParse(executeTaskCreate, "test-id", {
        task_name: "suggest-empty-steps",
        project_root: env.projectRoot,
        brief: "## 目标\n空步骤测试",
      });
      const taskDir: string = createResult.task_dir;

      // 0 steps, 0 criteria
      const result = await callAndParse(executeTaskVerify, "test-id", {
        task_dir: taskDir,
        action: { action: "get" },
      });

      expect(result.success).toBe(true);
      expect(result.suggested_criteria).toBeUndefined();
    });
  });

  it("full flow: create → assign → run → error → retry → verify → complete → archive → recall", async () => {
    // 1. Create
    const createResult = await callAndParse(executeTaskCreate, "test-id", {
      task_name: "integration-flow",
      project_root: env.projectRoot,
      assigned_to: "full-flow-agent",
      brief: "## 目标\n集成流程全链路测试",
    });
    expect(createResult.success).toBe(true);
    const taskDir: string = createResult.task_dir;

    // 2. Assign → Run
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "assigned",
    });
    await callAndParse(executeTaskTransition, "test-id", {
      task_dir: taskDir, status: "running",
    });

    // 3. Log an error
    await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "error", step: "1.1", message: "Setup failed" },
    });

    // 4. Retry the error
    await callAndParse(executeTaskLog, "test-id", {
      task_dir: taskDir,
      action: { action: "retry", step: "1.1" },
    });

    // 5. Add verification criteria
    await callAndParse(executeTaskVerify, "test-id", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion: "Setup works", result: "passed" },
    });

    // 5.5 Add completed steps so auto-complete can pass steps validation
    await callAndParse(executeStepsUpdate, "test-id", {
      task_dir: taskDir,
      steps: [
        { id: "1.1", summary: { title: "Step 1", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
      ],
    });

    // 6. Finalize → auto-complete
    const finalizeResult = await callAndParse(executeTaskVerify, "test-id", {
      task_dir: taskDir,
      action: { action: "finalize", verified_by: "full-flow-agent" },
    });
    expect(finalizeResult.auto_completed).toBe(true);

    // 7. Verify status
    let status = await readStatus(taskDir);
    expect(status.status).toBe("completed");
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].retry_count).toBe(1);
    expect(status.verification.status).toBe("passed");

    // 8. Write brief for archive (brief.md is at task root, resolve from run dir)
    const taskRoot = join(taskDir, "..", "..");
    await writeFile(join(taskRoot, "brief.md"), "# Integration Flow\n\nFull pipeline test", "utf-8");

    // 9. Archive
    const archiveResult = await callAndParse(executeTaskArchive, "test-id", {
      task_dir: taskDir,
      agent_workspace: env.agentWorkspace,
      project_root: env.projectRoot,
      agent_name: "full-flow-agent",
    });
    expect(archiveResult.success).toBe(true);
    expect(archiveResult.results.some((r: any) => r.status === "created")).toBe(true);

    // 10. Recall — search for the archived task
    const recallResult = await callAndParse(executeTaskRecall, "test-id", {
      keywords: "integration pipeline",
      agent_workspace: env.agentWorkspace,
    });
    expect(recallResult.success).toBe(true);
    expect(recallResult.total_matches).toBeGreaterThanOrEqual(1);

    // 11. Resume on completed task
    const resumeResult = await callAndParse(executeTaskResume, "test-id", {
      task_dir: taskDir,
    });
    expect(resumeResult.status).toBe("completed");
    expect(resumeResult.next_action).toContain("已完成");
  });
});
