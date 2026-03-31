import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  createTestEnv, createTask, readStatus, writeArtifact, writeChecklist,
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
    const { taskDir } = await createTask(env.specTaskDir, "lifecycle-task", {
      title: "Full Lifecycle", assignedTo: "agent-1",
    });
    let status = await readStatus(taskDir);
    expectStatus(status, "pending");
    expect(status.task_id).toBe("lifecycle-task");
    expectRevisionCount(status, 1);

    // Phase 2: Fill documents
    await writeArtifact(taskDir, "brief.md", "# Brief\n\nTask brief.");
    await writeArtifact(taskDir, "spec.md", "# Spec\n\nDetailed spec.");
    await writeArtifact(taskDir, "plan.md", "# Plan\n\nExecution plan.");
    await writeChecklist(taskDir, "checklist.md",
      "- [ ] 1.1 Setup\n- [ ] 1.2 Implement\n- [ ] 1.3 Test\n- [ ] 1.4 Verify\n");
    await expectFileExists(join(taskDir, "brief.md"));

    // Phase 3: assigned → running
    await transitionTask(taskDir, "assigned", { assignedTo: "agent-1" });
    await transitionTask(taskDir, "running", { summary: "Start" });
    status = await readStatus(taskDir);
    expectStatus(status, "running");
    expect(status.started_at).not.toBeNull();
    expectRevisionCount(status, 3);

    // Phase 4: Progress update (running → running)
    await writeChecklist(taskDir, "checklist.md",
      "- [x] 1.1 Setup\n- [x] 1.2 Implement\n- [ ] 1.3 Test\n- [ ] 1.4 Verify\n");
    await transitionTask(taskDir, "running", { summary: "Progress: 2/4" });
    status = await readStatus(taskDir);
    expectRevisionCount(status, 4);

    // Phase 5: Complete + verify
    await writeChecklist(taskDir, "checklist.md",
      "- [x] 1.1 Setup\n- [x] 1.2 Implement\n- [x] 1.3 Test\n- [x] 1.4 Verify\n");
    await addCriterion(taskDir, "Tests pass", "passed", "48/48 passed");
    await addCriterion(taskDir, "No regressions", "passed", "Baseline OK");
    await addCriterion(taskDir, "Docs updated", "passed");
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
    const { taskDir } = await createTask(env.specTaskDir, "fail-task", {
      title: "Failure Test", assignedTo: "agent-1",
    });
    await writeArtifact(taskDir, "brief.md", "# Brief\n\nBrief.");
    await writeArtifact(taskDir, "spec.md", "# Spec\n\nSpec.");
    await writeArtifact(taskDir, "plan.md", "# Plan\n\nPlan.");
    await writeChecklist(taskDir, "checklist.md", "- [ ] 1.1 Step\n- [ ] 1.2 Step\n");

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
    await writeChecklist(taskDir, "checklist.md", "- [x] 1.1 Step\n- [x] 1.2 Step\n");
    await addCriterion(taskDir, "Data processed", "passed");
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
    const { taskDir: dirA } = await createTask(env.specTaskDir, "task-a", {
      title: "Task A", assignedTo: "agent-1" });
    const { taskDir: dirB } = await createTask(env.specTaskDir, "task-b", {
      title: "Task B", assignedTo: "agent-2" });

    // Fill docs + start both
    for (const dir of [dirA, dirB]) {
      await writeArtifact(dir, "brief.md", "# Brief\n\nBrief.");
      await writeArtifact(dir, "spec.md", "# Spec\n\nSpec.");
      await writeArtifact(dir, "plan.md", "# Plan\n\nPlan.");
      await writeChecklist(dir, "checklist.md", "- [ ] 1.1 Work\n");
      await transitionTask(dir, "assigned", { assignedTo: dir === dirA ? "agent-1" : "agent-2" });
      await transitionTask(dir, "running", { summary: `${dir === dirA ? "A" : "B"} started` });
    }

    // Task B blocks Task A
    await addBlock(dirA, dirB, "Depends on B's output");
    let statusA = await readStatus(dirA);
    expect(statusA.blocked_by).toHaveLength(1);

    // Task A → blocked
    await transitionTask(dirA, "blocked", {
      summary: "Waiting for task-b", blockType: "hard_block", blockReason: "Depends on B" });
    statusA = await readStatus(dirA);
    expectStatus(statusA, "blocked");

    // Task B completes
    await writeChecklist(dirB, "checklist.md", "- [x] 1.1 Work\n");
    await addCriterion(dirB, "Output ready", "passed");
    expect((await finalizeVerification(dirB)).autoCompleted).toBe(true);
    expectStatus(await readStatus(dirB), "completed");

    // Unblock Task A
    await removeBlock(dirA, dirB);
    await transitionTask(dirA, "pending", { summary: "Block resolved" });
    await transitionTask(dirA, "assigned", { assignedTo: "agent-1" });
    await transitionTask(dirA, "running", { summary: "Resumed" });

    // Task A completes
    await writeChecklist(dirA, "checklist.md", "- [x] 1.1 Work\n");
    await addCriterion(dirA, "Integration OK", "passed");
    expect((await finalizeVerification(dirA)).autoCompleted).toBe(true);

    statusA = await readStatus(dirA);
    expectStatus(statusA, "completed");
    expect(statusA.blocked_by).toHaveLength(0);

    // Verify revision history
    const blockedRev = statusA.revisions.find(r => r.block_type === "hard_block");
    expect(blockedRev).toBeDefined();
    expect(blockedRev?.block_type).toBe("hard_block");
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
      title: "Cancel Test", assignedTo: "agent-1" });

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
    const { taskDir: parentDir } = await createTask(env.specTaskDir, "parent-task", {
      title: "Parent", assignedTo: "coordinator" });
    let parent = await readStatus(parentDir);
    expect(parent.children).toHaveLength(0);

    // Create child (parent/depth params removed from API, children managed manually)
    const { taskDir: childDir } = await createTask(env.specTaskDir, "child-task", {
      title: "Child", assignedTo: "sub-agent" });
    let child = await readStatus(childDir);

    // Fill docs + complete child
    for (const dir of [parentDir, childDir]) {
      await writeArtifact(dir, "brief.md", "# Brief\n\nBrief.");
      await writeArtifact(dir, "spec.md", "# Spec\n\nSpec.");
      await writeArtifact(dir, "plan.md", "# Plan\n\nPlan.");
      await writeChecklist(dir, "checklist.md", "- [ ] 1.1 Execute\n");
    }
    await transitionTask(childDir, "assigned", { assignedTo: "sub-agent" });
    await transitionTask(childDir, "running", {});
    await writeChecklist(childDir, "checklist.md", "- [x] 1.1 Execute\n");
    await addCriterion(childDir, "Child done", "passed");
    expect((await finalizeVerification(childDir, "sub-agent")).autoCompleted).toBe(true);
    child = await readStatus(childDir);
    expectStatus(child, "completed");

    // Complete parent
    await transitionTask(parentDir, "assigned", { assignedTo: "coordinator" });
    await transitionTask(parentDir, "running", {});
    await writeChecklist(parentDir, "checklist.md", "- [x] 1.1 Execute\n");
    await addCriterion(parentDir, "Children done", "passed", "child-task completed");
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
    const { taskDir: dirX } = await createTask(env.specTaskDir, "task-x", {
      title: "Task X", assignedTo: "agent-x" });
    const { taskDir: dirY } = await createTask(env.specTaskDir, "task-y", {
      title: "Task Y", assignedTo: "agent-y" });

    // Fill docs
    for (const dir of [dirX, dirY]) {
      await writeArtifact(dir, "brief.md", "# Brief\n\nBrief.");
      await writeArtifact(dir, "spec.md", "# Spec\n\nSpec.");
      await writeArtifact(dir, "plan.md", "# Plan\n\nPlan.");
      await writeChecklist(dir, "checklist.md", "- [ ] 1.1 Step\n");
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
    await writeChecklist(dirX, "checklist.md", "- [x] 1.1 Step\n");
    await writeChecklist(dirY, "checklist.md", "- [x] 1.1 Step\n");
    await addCriterion(dirX, "X OK", "passed");
    await addCriterion(dirY, "Y OK", "passed");
    await Promise.all([finalizeVerification(dirX, "agent-x"), finalizeVerification(dirY, "agent-y")]);

    sX = await readStatus(dirX); sY = await readStatus(dirY);
    expectStatus(sX, "completed"); expectStatus(sY, "completed");
    expect(sX.task_id).toBe("task-x"); expect(sY.task_id).toBe("task-y");
    expect(sX.children).toHaveLength(0);
  });
});
