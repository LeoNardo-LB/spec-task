import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RevisionBuilder } from "../../src/core/revision.js";
import type { TaskStatusData, Revision } from "../../src/types.js";

describe("RevisionBuilder", () => {
  let rb: RevisionBuilder;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T12:00:00.000Z"));
    rb = new RevisionBuilder();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function emptyData(overrides: Partial<TaskStatusData> = {}): TaskStatusData {
    return {
      task_id: "test-task",
      title: "Test",
      created: "2026-03-29T00:00:00.000Z",
      updated: "2026-03-29T00:00:00.000Z",
      status: "pending",
      assigned_to: "agent",
      started_at: null,
      completed_at: null,
      progress: { total: 0, completed: 0, current_step: "", percentage: 0 },
      parent: null,
      depth: 0,
      children: [],
      outputs: [],
      timing: { estimated_minutes: null, elapsed_minutes: null },
      errors: [],
      alerts: [],
      blocked_by: [],
      verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
      revisions: [],
      ...overrides,
    };
  }

  // ====================================================================
  // nextId
  // ====================================================================
  describe("nextId", () => {
    it("should return 1 for empty revisions", () => {
      expect(rb.nextId(emptyData())).toBe(1);
    });

    it("should return 1 when revisions key is missing", () => {
      const data = emptyData();
      delete (data as any).revisions;
      expect(rb.nextId(data)).toBe(1);
    });

    it("should return max_id + 1 for existing revisions", () => {
      const data = emptyData({
        revisions: [
          { id: 1, type: "created", timestamp: "", trigger: "", summary: "", impact: "minor",
            changes: [], affected_steps: { invalidated: [], modified: [], added: [] },
            resume_from: "", status_before: "pending", status_after: "pending",
            block_type: null, block_reason: null },
          { id: 3, type: "created", timestamp: "", trigger: "", summary: "", impact: "minor",
            changes: [], affected_steps: { invalidated: [], modified: [], added: [] },
            resume_from: "", status_before: "pending", status_after: "pending",
            block_type: null, block_reason: null },
        ] as Revision[],
      });
      expect(rb.nextId(data)).toBe(4);
    });

    it("should return max_id + 1 for single revision", () => {
      const data = emptyData({
        revisions: [
          { id: 5, type: "created", timestamp: "", trigger: "", summary: "", impact: "minor",
            changes: [], affected_steps: { invalidated: [], modified: [], added: [] },
            resume_from: "", status_before: "pending", status_after: "pending",
            block_type: null, block_reason: null },
        ] as Revision[],
      });
      expect(rb.nextId(data)).toBe(6);
    });
  });

  // ====================================================================
  // build — 基础
  // ====================================================================
  describe("build — basic", () => {
    it("should create revision with correct id", () => {
      const data = emptyData();
      const rev = rb.build({ data, type: "created", trigger: "test", summary: "Init" });
      expect(rev.id).toBe(1);
    });

    it("should auto-increment id based on existing revisions", () => {
      const data = emptyData({
        revisions: [
          { id: 1, type: "created", timestamp: "", trigger: "", summary: "", impact: "minor",
            changes: [], affected_steps: { invalidated: [], modified: [], added: [] },
            resume_from: "", status_before: "pending", status_after: "pending",
            block_type: null, block_reason: null },
        ] as Revision[],
      });
      const rev = rb.build({ data, type: "status_change" });
      expect(rev.id).toBe(2);
    });

    it("should set type correctly", () => {
      const rev = rb.build({ data: emptyData(), type: "user_request" });
      expect(rev.type).toBe("user_request");
    });

    it("should set trigger and summary", () => {
      const rev = rb.build({
        data: emptyData(),
        type: "created",
        trigger: "agent",
        summary: "Task created",
      });
      expect(rev.trigger).toBe("agent");
      expect(rev.summary).toBe("Task created");
    });

    it("should default impact to minor", () => {
      const rev = rb.build({ data: emptyData(), type: "created" });
      expect(rev.impact).toBe("minor");
    });

    it("should use provided impact", () => {
      const rev = rb.build({ data: emptyData(), type: "user_request", impact: "major" });
      expect(rev.impact).toBe("major");
    });

    it("should set timestamp to current time (faked)", () => {
      const rev = rb.build({ data: emptyData(), type: "created" });
      expect(rev.timestamp).toBe("2026-03-29T12:00:00.000Z");
    });

    it("should default changes to empty array", () => {
      const rev = rb.build({ data: emptyData(), type: "created" });
      expect(rev.changes).toEqual([]);
    });

    it("should default affected_steps to empty object", () => {
      const rev = rb.build({ data: emptyData(), type: "created" });
      expect(rev.affected_steps).toEqual({ invalidated: [], modified: [], added: [] });
    });

    it("should default resume_from to empty string", () => {
      const rev = rb.build({ data: emptyData(), type: "created" });
      expect(rev.resume_from).toBe("");
    });

    it("should set status_before and status_after to current status", () => {
      const data = emptyData({ status: "running" });
      const rev = rb.build({ data, type: "status_change" });
      expect(rev.status_before).toBe("running");
      expect(rev.status_after).toBe("running");
    });
  });

  // ====================================================================
  // build — block 相关
  // ====================================================================
  describe("build — block info", () => {
    it("should include block_type when provided", () => {
      const rev = rb.build({
        data: emptyData({ status: "running" }),
        type: "status_change",
        blockType: "soft_block",
        blockReason: "waiting for review",
      });
      expect(rev.block_type).toBe("soft_block");
      expect(rev.block_reason).toBe("waiting for review");
    });

    it("should not include block_type when not provided", () => {
      const rev = rb.build({ data: emptyData(), type: "created" });
      expect(rev.block_type).toBeNull();
      expect(rev.block_reason).toBeNull();
    });
  });
});
