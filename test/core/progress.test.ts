import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ProgressCalculator } from "../../src/core/progress.js";

describe("ProgressCalculator", () => {
  let tmpDir: string;
  let calc: ProgressCalculator;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "progress-test-"));
    calc = new ProgressCalculator();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeChecklist(content: string): string {
    const path = join(tmpDir, "checklist.md");
    writeFileSync(path, content, "utf-8");
    return path;
  }

  // ====================================================================
  // 基本场景
  // ====================================================================
  describe("basic scenarios", () => {
    it("should return zero progress for nonexistent file", async () => {
      const result = await calc.calculate(join(tmpDir, "nonexistent.md"));
      expect(result).toEqual({
        total: 0,
        completed: 0,
        current_step: "",
        percentage: 0,
      });
    });

    it("should return zero progress for empty file", async () => {
      const path = writeChecklist("");
      const result = await calc.calculate(path);
      expect(result).toEqual({
        total: 0,
        completed: 0,
        current_step: "",
        percentage: 0,
      });
    });

    it("should return zero progress for file with no checklist items", async () => {
      const path = writeChecklist("# Header\n\nSome random text\n");
      const result = await calc.calculate(path);
      expect(result).toEqual({
        total: 0,
        completed: 0,
        current_step: "",
        percentage: 0,
      });
    });

    it("should calculate all unchecked items", async () => {
      const path = writeChecklist(
        "- [ ] 1.1 Setup\n- [ ] 1.2 Configure\n- [ ] 1.3 Deploy\n"
      );
      const result = await calc.calculate(path);
      expect(result).toEqual({
        total: 3,
        completed: 0,
        current_step: "1.1",
        percentage: 0,
      });
    });

    it("should calculate all checked items", async () => {
      const path = writeChecklist(
        "- [x] 1.1 Setup\n- [x] 1.2 Configure\n"
      );
      const result = await calc.calculate(path);
      expect(result).toEqual({
        total: 2,
        completed: 2,
        current_step: "",
        percentage: 100,
      });
    });

    it("should calculate mixed checked/unchecked items", async () => {
      const path = writeChecklist(
        "- [x] 1.1 Setup\n- [x] 1.2 Configure\n- [ ] 2.1 Test\n- [ ] 2.2 Deploy\n"
      );
      const result = await calc.calculate(path);
      expect(result).toEqual({
        total: 4,
        completed: 2,
        current_step: "2.1",
        percentage: 50,
      });
    });
  });

  // ====================================================================
  // 边界场景
  // ====================================================================
  describe("edge cases", () => {
    it("should handle multi-digit step numbers", async () => {
      const path = writeChecklist(
        "- [ ] 10.1 First\n- [x] 10.2 Second\n"
      );
      const result = await calc.calculate(path);
      expect(result).toEqual({
        total: 2,
        completed: 1,
        current_step: "10.1",
        percentage: 50,
      });
    });

    it("should handle nested step numbers (e.g., 1.2.3)", async () => {
      const path = writeChecklist(
        "- [x] 1.1 Alpha\n- [ ] 1.2.3 Beta\n- [x] 1.3 Gamma\n"
      );
      const result = await calc.calculate(path);
      expect(result.total).toBe(3);
      expect(result.completed).toBe(2);
      expect(result.current_step).toBe("1.2.3");
    });

    it("should ignore non-checklist lines", async () => {
      const path = writeChecklist(
        "# Header\n\n- [x] 1.1 Done\nSome random text\n- [ ] 1.2 Todo\n"
      );
      const result = await calc.calculate(path);
      expect(result).toEqual({
        total: 2,
        completed: 1,
        current_step: "1.2",
        percentage: 50,
      });
    });

    it("should handle single item unchecked", async () => {
      const path = writeChecklist("- [ ] 1.0 Only step\n");
      const result = await calc.calculate(path);
      expect(result).toEqual({
        total: 1,
        completed: 0,
        current_step: "1.0",
        percentage: 0,
      });
    });

    it("should handle single item checked", async () => {
      const path = writeChecklist("- [x] 1.0 Only step\n");
      const result = await calc.calculate(path);
      expect(result).toEqual({
        total: 1,
        completed: 1,
        current_step: "",
        percentage: 100,
      });
    });

    it("should round percentage correctly (1/3 = 33%)", async () => {
      const path = writeChecklist(
        "- [x] 1.1 Done\n- [ ] 1.2 Todo\n- [ ] 1.3 Also\n"
      );
      const result = await calc.calculate(path);
      expect(result.percentage).toBe(33); // round(1/3 * 100) = 33
    });

    it("should handle checklist items without step numbers", async () => {
      const path = writeChecklist(
        "- [x] First item\n- [ ] Second item\n"
      );
      const result = await calc.calculate(path);
      // Regex requires \d+(?:\.\d+)?, so items without numbers are skipped
      expect(result.total).toBe(0);
    });

    it("should handle items with mixed spacing after checkbox", async () => {
      const path = writeChecklist(
        "- [x]1.1 Tight spacing\n- [ ]  1.2 Double space\n"
      );
      const result = await calc.calculate(path);
      // Regex: ^- \[x\]\s+(\d+...)  — requires at least one space after ]
      // "1.1 Tight" matches (space before 1.1)
      // "1.2 Double" matches (two spaces, \s+ matches both)
      expect(result.total).toBe(2);
      expect(result.completed).toBe(1);
    });
  });

  // ====================================================================
  // 百分比边界
  // ====================================================================
  describe("percentage edge cases", () => {
    it("should return 0% when all unchecked", async () => {
      const path = writeChecklist("- [ ] 1.1 A\n- [ ] 1.2 B\n");
      const result = await calc.calculate(path);
      expect(result.percentage).toBe(0);
    });

    it("should return 100% when all checked", async () => {
      const path = writeChecklist("- [x] 1.1 A\n- [x] 1.2 B\n");
      const result = await calc.calculate(path);
      expect(result.percentage).toBe(100);
    });

    it("should return 0% for empty progress (total=0)", async () => {
      const path = writeChecklist("# No items here");
      const result = await calc.calculate(path);
      expect(result.percentage).toBe(0);
    });
  });

  // ====================================================================
  // current_step 行为
  // ====================================================================
  describe("current_step behavior", () => {
    it("should return first unchecked step number", async () => {
      const path = writeChecklist(
        "- [x] 1.1 A\n- [ ] 2.1 B\n- [ ] 2.2 C\n"
      );
      const result = await calc.calculate(path);
      expect(result.current_step).toBe("2.1");
    });

    it("should return empty string when all checked", async () => {
      const path = writeChecklist(
        "- [x] 1.1 A\n- [x] 2.1 B\n"
      );
      const result = await calc.calculate(path);
      expect(result.current_step).toBe("");
    });
  });
});
