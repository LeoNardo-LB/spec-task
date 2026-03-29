import { describe, it, expect } from "vitest";
import { StateMachine } from "../../src/core/state-machine.js";
import { VALID_TRANSITIONS } from "../../src/types.js";
import type { TaskStatus } from "../../src/types.js";

describe("StateMachine", () => {
  const sm = new StateMachine();

  // ====================================================================
  // 14 条合法转换
  // ====================================================================
  describe("valid transitions (14)", () => {
    const validCases: Array<{ from: TaskStatus; to: TaskStatus }> = [
      { from: "pending", to: "assigned" },
      { from: "pending", to: "cancelled" },
      { from: "assigned", to: "running" },
      { from: "assigned", to: "cancelled" },
      { from: "running", to: "completed" },
      { from: "running", to: "failed" },
      { from: "running", to: "blocked" },
      { from: "running", to: "cancelled" },
      { from: "running", to: "revised" },
      { from: "running", to: "running" },
      { from: "failed", to: "running" },
      { from: "blocked", to: "pending" },
      { from: "revised", to: "running" },
      { from: "revised", to: "pending" },
    ];

    it.each(validCases)("$from → $to should be valid", ({ from, to }) => {
      expect(sm.isValidTransition(from, to)).toBe(true);
    });

    it.each(validCases)("$from → $to validate() should not throw", ({ from, to }) => {
      expect(() => sm.validate(from, to)).not.toThrow();
    });
  });

  // ====================================================================
  // 14 条非法转换
  // ====================================================================
  describe("invalid transitions (14)", () => {
    const invalidCases: Array<{ from: TaskStatus; to: TaskStatus }> = [
      // completed → 任何状态（终态）
      { from: "completed", to: "running" },
      { from: "completed", to: "pending" },
      { from: "completed", to: "failed" },
      // cancelled → 任何状态（终态）
      { from: "cancelled", to: "running" },
      { from: "cancelled", to: "pending" },
      { from: "cancelled", to: "assigned" },
      // pending → running（必须经过 assigned）
      { from: "pending", to: "running" },
      // pending → completed（必须经过 assigned → running）
      { from: "pending", to: "completed" },
      // pending → failed（不可能从 pending 直接失败）
      { from: "pending", to: "failed" },
      // assigned → assigned（无意义）
      { from: "assigned", to: "assigned" },
      // failed → failed（不能从失败到失败）
      { from: "failed", to: "failed" },
      // failed → completed（不能直接完成）
      { from: "failed", to: "completed" },
      // blocked → running（必须经过 pending）
      { from: "blocked", to: "running" },
      // revised → revised（不允许连续修订）
      { from: "revised", to: "revised" },
    ];

    it.each(invalidCases)("$from → $to should be invalid", ({ from, to }) => {
      expect(sm.isValidTransition(from, to)).toBe(false);
    });

    it.each(invalidCases)("$from → $to validate() should throw", ({ from, to }) => {
      expect(() => sm.validate(from, to)).toThrow("Invalid transition");
    });
  });

  // ====================================================================
  // 覆盖率：VALID_TRANSITIONS 常量一致性
  // ====================================================================
  describe("consistency with VALID_TRANSITIONS", () => {
    it("should have exactly 14 valid transitions in total", () => {
      let count = 0;
      for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
        for (const to of targets) {
          expect(sm.isValidTransition(from as TaskStatus, to as TaskStatus)).toBe(true);
          count++;
        }
      }
      expect(count).toBe(14);
    });
  });
});
