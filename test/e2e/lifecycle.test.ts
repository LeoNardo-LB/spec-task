import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { writeFile } from "fs/promises";
import YAML from "yaml";
import {
  createTestEnv, createTask, readStatus, writeArtifact,
  transitionTask, addCriterion, finalizeVerification,
  expectStatus, expectRevisionCount, expectFileExists,
} from "./helpers.js";

// ============================================================================
// Task 2: Full Lifecycle E2E Test
// ============================================================================

describe("E2E: Full Lifecycle", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("should complete full lifecycle: create → documents → assigned → running → progress → verify → completed", async () => {
    // Phase 1: Create
    const { taskRoot, taskDir } = await createTask(env.specTaskDir, "lifecycle-task", {
      title: "Full Lifecycle", assignedTo: "agent-1",
      brief: "## 目标\n完整生命周期测试",
    });
    let status = await readStatus(taskDir);
    expectStatus(status, "pending");
    expect(status.task_id).toBe("lifecycle-task");
    expectRevisionCount(status, 1);

    // Phase 2: Fill documents (artifacts go to taskRoot)
    await writeArtifact(taskRoot, "spec.md", "# Spec\n\nDetailed spec.");
    await writeArtifact(taskRoot, "plan.md", "# Plan\n\nExecution plan.");
    await expectFileExists(join(taskRoot, "brief.md"));

    // Phase 3: assigned → running
    await transitionTask(taskDir, "assigned", { assignedTo: "agent-1" });
    await transitionTask(taskDir, "running", { summary: "Start" });
    status = await readStatus(taskDir);
    expectStatus(status, "running");
    expect(status.started_at).not.toBeNull();
    expectRevisionCount(status, 3);

    // Phase 4: Progress update (running → running, no checklist in v0.3.0)
    await transitionTask(taskDir, "running", { summary: "Progress: working" });
    status = await readStatus(taskDir);
    expectRevisionCount(status, 4);

    // Phase 5: Complete + verify
    await addCriterion(taskDir, "Tests pass", "passed", "48/48 passed");
    await addCriterion(taskDir, "No regressions", "passed", "Baseline OK");
    await addCriterion(taskDir, "Docs updated", "passed");
    // 添加完整的 steps 数据以满足 finalizeVerification 的完整性检查
    const lifecycleStatus = await readStatus(taskDir);
    lifecycleStatus.steps = [
      { id: "1.1", summary: { title: "Step 1", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
    ];
    await writeFile(join(taskDir, "status.yaml"), YAML.stringify(lifecycleStatus), "utf-8");
    const { autoCompleted } = await finalizeVerification(taskDir, "agent-1");
    expect(autoCompleted).toBe(true);

    status = await readStatus(taskDir);
    expectStatus(status, "completed");
    expect(status.completed_at).not.toBeNull();
    expect(status.verification.status).toBe("passed");
    expectRevisionCount(status, 5);
  });
});

// ============================================================================
// Task 3: Failure Recovery E2E Test
// ============================================================================

describe("E2E: Failure Recovery", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("should recover from failure: running → failed → running → completed", async () => {
    const { taskDir, taskRoot } = await createTask(env.specTaskDir, "fail-task", {
      title: "Failure Test", assignedTo: "agent-1",
      brief: "## 目标\n失败恢复测试",
    });
    await writeArtifact(taskRoot, "spec.md", "# Spec\n\nSpec.");
    await writeArtifact(taskRoot, "plan.md", "# Plan\n\nPlan.");

    // Start
    await transitionTask(taskDir, "assigned", { assignedTo: "agent-1" });
    await transitionTask(taskDir, "running", { summary: "Start" });
    let status = await readStatus(taskDir);
    expectStatus(status, "running");

    // Log error
    const { logError } = await import("./helpers.js");
    await logError(taskDir, "1.2", "Database connection timeout after 30s");
    status = await readStatus(taskDir);
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].message).toContain("timeout");

    // Fail
    await transitionTask(taskDir, "failed", { summary: "Execution failed" });
    status = await readStatus(taskDir);
    expectStatus(status, "failed");
    expectRevisionCount(status, 4);

    // Recovery
    await transitionTask(taskDir, "running", { summary: "Retry: reconnected" });
    status = await readStatus(taskDir);
    expectStatus(status, "running");
    expectRevisionCount(status, 5);

    // Complete
    await addCriterion(taskDir, "Data processed", "passed");
    // 添加完整的 steps 数据以满足 finalizeVerification 的完整性检查
    const failStatus = await readStatus(taskDir);
    failStatus.steps = [
      { id: "1.1", summary: { title: "Step 1", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
    ];
    await writeFile(join(taskDir, "status.yaml"), YAML.stringify(failStatus), "utf-8");
    const { autoCompleted } = await finalizeVerification(taskDir);
    expect(autoCompleted).toBe(true);

    status = await readStatus(taskDir);
    expectStatus(status, "completed");
    // +1 for the auto-completion revision from finalizeVerification
    expectRevisionCount(status, 6);

    // Verify error history preserved + revision trail
    expect(status.errors).toHaveLength(1);
    // Verify revision trail: should have revisions for failed and recovery
    const statusChangeRevs = status.revisions.filter(r => r.type === "status_change");
    expect(statusChangeRevs.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Task 4: Block Recovery E2E Test
// ============================================================================

describe("E2E: Block Recovery", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("should handle cross-task blocking: blocked → pending → running → completed", async () => {
    const { addBlock, removeBlock } = await import("./helpers.js");

    // Create two tasks
    const { taskRoot: rootA, taskDir: dirA } = await createTask(env.specTaskDir, "task-a", {
      title: "Task A", assignedTo: "agent-1", brief: "## 目标\n任务 A" });
    const { taskRoot: rootB, taskDir: dirB } = await createTask(env.specTaskDir, "task-b", {
      title: "Task B", assignedTo: "agent-2", brief: "## 目标\n任务 B" });

    // Fill docs + start both
    for (const [root, dir, agent] of [[rootA, dirA, "agent-1"], [rootB, dirB, "agent-2"]] as const) {
      await writeArtifact(root, "spec.md", "# Spec\n\nSpec.");
      await writeArtifact(root, "plan.md", "# Plan\n\nPlan.");
      await transitionTask(dir, "assigned", { assignedTo: agent });
      await transitionTask(dir, "running", { summary: `${agent} started` });
    }

    // Task B blocks Task A
    await addBlock(dirA, dirB, "Depends on B's output");
    let statusA = await readStatus(dirA);
    expect(statusA.blocked_by).toHaveLength(1);

    // Task A → blocked
    await transitionTask(dirA, "blocked", {
      summary: "Waiting for task-b" });
    statusA = await readStatus(dirA);
    expectStatus(statusA, "blocked");

    // Task B completes
    await addCriterion(dirB, "Output ready", "passed");
    // 添加完整的 steps 数据以满足 finalizeVerification 的完整性检查
    const statusB = await readStatus(dirB);
    statusB.steps = [
      { id: "1.1", summary: { title: "Step 1", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
    ];
    await writeFile(join(dirB, "status.yaml"), YAML.stringify(statusB), "utf-8");
    expect((await finalizeVerification(dirB)).autoCompleted).toBe(true);
    expectStatus(await readStatus(dirB), "completed");

    // Unblock Task A
    await removeBlock(dirA, dirB);
    await transitionTask(dirA, "pending", { summary: "Block resolved" });
    await transitionTask(dirA, "assigned", { assignedTo: "agent-1" });
    await transitionTask(dirA, "running", { summary: "Resumed" });

    // Task A completes
    await addCriterion(dirA, "Integration OK", "passed");
    // 添加完整的 steps 数据以满足 finalizeVerification 的完整性检查
    const statusA2 = await readStatus(dirA);
    statusA2.steps = [
      { id: "1.1", summary: { title: "Step 1", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
    ];
    await writeFile(join(dirA, "status.yaml"), YAML.stringify(statusA2), "utf-8");
    expect((await finalizeVerification(dirA)).autoCompleted).toBe(true);

    statusA = await readStatus(dirA);
    expectStatus(statusA, "completed");
    expect(statusA.blocked_by).toHaveLength(0);

    // Verify revision history
  });
});

// ============================================================================
// Task 5: Cancellation E2E Test
// ============================================================================

describe("E2E: Task Cancellation", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("should cancel task: create → assigned → cancelled", async () => {
    const { taskDir } = await createTask(env.specTaskDir, "cancel-task", {
      title: "Cancel Test", assignedTo: "agent-1", brief: "## 目标\n取消测试" });

    let status = await readStatus(taskDir);
    expectStatus(status, "pending");

    await transitionTask(taskDir, "assigned", { assignedTo: "agent-1" });
    status = await readStatus(taskDir);
    expectStatus(status, "assigned");
    expectRevisionCount(status, 2);

    await transitionTask(taskDir, "cancelled", {
      summary: "Cancelled: requirements changed", revisionType: "cancel" });
    status = await readStatus(taskDir);
    expectStatus(status, "cancelled");
    expect(status.completed_at).not.toBeNull();
    expectRevisionCount(status, 3);

    // Verify cancellation revision
    const cancelRev = status.revisions.find(r => r.type === "cancel");
    expect(cancelRev).toBeDefined();
    expect(cancelRev?.trigger).toBeDefined();

    // Verify terminal state (no valid transitions from cancelled)
    const { VALID_TRANSITIONS } = await import("../../src/types.js");
    expect(VALID_TRANSITIONS["cancelled"]).toEqual([]);
  });
});

// ============================================================================
// Task 6: Parent-Child E2E Test (simplified — parent/depth removed from types)
// ============================================================================

describe("E2E: Parent-Child Tasks", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("should manage parent-child: create parent → child → complete child → complete parent", async () => {
    // Create parent
    const { taskRoot: parentRoot, taskDir: parentDir } = await createTask(env.specTaskDir, "parent-task", {
      title: "Parent", assignedTo: "coordinator", brief: "## 目标\n父任务" });
    let parent = await readStatus(parentDir);
    expect(parent.task_id).toBe("parent-task");

    // Create child (parent/depth params removed from API, children managed manually)
    const { taskRoot: childRoot, taskDir: childDir } = await createTask(env.specTaskDir, "child-task", {
      title: "Child", assignedTo: "sub-agent", brief: "## 目标\n子任务" });
    let child = await readStatus(childDir);

    // Fill docs for both tasks
    await writeArtifact(parentRoot, "spec.md", "# Spec\n\nSpec.");
    await writeArtifact(parentRoot, "plan.md", "# Plan\n\nPlan.");
    await writeArtifact(childRoot, "spec.md", "# Spec\n\nSpec.");
    await writeArtifact(childRoot, "plan.md", "# Plan\n\nPlan.");

    await transitionTask(childDir, "assigned", { assignedTo: "sub-agent" });
    await transitionTask(childDir, "running", {});
    await addCriterion(childDir, "Child done", "passed");
    // 添加完整的 steps 数据以满足 finalizeVerification 的完整性检查
    const childStatus = await readStatus(childDir);
    childStatus.steps = [
      { id: "1.1", summary: { title: "Step 1", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
    ];
    await writeFile(join(childDir, "status.yaml"), YAML.stringify(childStatus), "utf-8");
    expect((await finalizeVerification(childDir, "sub-agent")).autoCompleted).toBe(true);
    child = await readStatus(childDir);
    expectStatus(child, "completed");

    // Complete parent
    await transitionTask(parentDir, "assigned", { assignedTo: "coordinator" });
    await transitionTask(parentDir, "running", {});
    await addCriterion(parentDir, "Children done", "passed", "child-task completed");
    // 添加完整的 steps 数据以满足 finalizeVerification 的完整性检查
    const parentStatus = await readStatus(parentDir);
    parentStatus.steps = [
      { id: "1.1", summary: { title: "Step 1", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
    ];
    await writeFile(join(parentDir, "status.yaml"), YAML.stringify(parentStatus), "utf-8");
    expect((await finalizeVerification(parentDir, "coordinator")).autoCompleted).toBe(true);
    parent = await readStatus(parentDir);
    expectStatus(parent, "completed");
  });
});

// ============================================================================
// Task 7: Concurrent Operations E2E Test
// ============================================================================

describe("E2E: Concurrent Operations", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("should handle concurrent operations on different tasks without interference", async () => {
    const { taskRoot: rootX, taskDir: dirX } = await createTask(env.specTaskDir, "task-x", {
      title: "Task X", assignedTo: "agent-x", brief: "## 目标\n任务 X" });
    const { taskRoot: rootY, taskDir: dirY } = await createTask(env.specTaskDir, "task-y", {
      title: "Task Y", assignedTo: "agent-y", brief: "## 目标\n任务 Y" });

    // Fill docs
    for (const root of [rootX, rootY]) {
      await writeArtifact(root, "spec.md", "# Spec\n\nSpec.");
      await writeArtifact(root, "plan.md", "# Plan\n\nPlan.");
    }

    // Concurrent transitions
    await Promise.all([
      (async () => {
        await transitionTask(dirX, "assigned", { assignedTo: "agent-x" });
        await transitionTask(dirX, "running", { summary: "X running" });
      })(),
      (async () => {
        await transitionTask(dirY, "assigned", { assignedTo: "agent-y" });
        await transitionTask(dirY, "running", { summary: "Y running" });
      })(),
    ]);

    let sX = await readStatus(dirX), sY = await readStatus(dirY);
    expectStatus(sX, "running"); expectStatus(sY, "running");
    expect(sX.assigned_to).toBe("agent-x"); expect(sY.assigned_to).toBe("agent-y");
    expectRevisionCount(sX, 3); expectRevisionCount(sY, 3);

    // Concurrent completions
    await addCriterion(dirX, "X OK", "passed");
    await addCriterion(dirY, "Y OK", "passed");
    // 添加完整的 steps 数据以满足 finalizeVerification 的完整性检查
    const sXPre = await readStatus(dirX);
    sXPre.steps = [
      { id: "1.1", summary: { title: "Step 1", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
    ];
    await writeFile(join(dirX, "status.yaml"), YAML.stringify(sXPre), "utf-8");
    const sYPre = await readStatus(dirY);
    sYPre.steps = [
      { id: "1.1", summary: { title: "Step 1", content: "", approach: "", sources: [] }, status: "completed", completed_at: new Date().toISOString(), tags: [] },
    ];
    await writeFile(join(dirY, "status.yaml"), YAML.stringify(sYPre), "utf-8");
    await Promise.all([finalizeVerification(dirX, "agent-x"), finalizeVerification(dirY, "agent-y")]);

    sX = await readStatus(dirX); sY = await readStatus(dirY);
    expectStatus(sX, "completed"); expectStatus(sY, "completed");
    expect(sX.task_id).toBe("task-x"); expect(sY.task_id).toBe("task-y");
  });
});
