import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { parseChecklist, toggleStep, updateProgress } from "../checklist-utils.js";

// ============================================================================
// 测试用的临时目录
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
  it("should parse checked and unchecked steps", () => {
    const content = [
      "- [x] 1.1 First step done",
      "- [ ] 1.2 Second step pending",
      "- [x] 2.1 Another done step",
    ].join("\n");

    const steps = parseChecklist(content);

    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ checked: true, text: "1.1 First step done", stepNumber: "1.1", tag: undefined });
    expect(steps[1]).toEqual({ checked: false, text: "1.2 Second step pending", stepNumber: "1.2", tag: undefined });
    expect(steps[2]).toEqual({ checked: true, text: "2.1 Another done step", stepNumber: "2.1", tag: undefined });
  });

  it("should extract step numbers", () => {
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

  it("should return empty array for empty content", () => {
    expect(parseChecklist("")).toEqual([]);
    expect(parseChecklist("   \n\n   ")).toEqual([]);
    expect(parseChecklist("# Some header\n## Another header\n")).toEqual([]);
  });

  it("should skip non-checkbox lines", () => {
    const content = [
      "# Checklist",
      "",
      "Some plain text",
      "- [x] 1.1 Actual step",
      "- not a checkbox line",
      "  - [ ] 1.2 Indented checkbox",
    ].join("\n");

    const steps = parseChecklist(content);

    // Indented checkbox should NOT match (regex requires line start ^-)
    expect(steps).toHaveLength(1);
    expect(steps[0].stepNumber).toBe("1.1");
  });
});

// ============================================================================
// toggleStep
// ============================================================================

describe("toggleStep", () => {
  const sampleContent = [
    "- [x] 1.1 First step done",
    "- [ ] 1.2 Second step pending",
    "- [ ] 2.1 Third step pending",
    "- [x] 2.2 Fourth step done",
  ].join("\n");

  it("should toggle an unchecked step to checked", () => {
    const result = toggleStep(sampleContent, (s) => s.stepNumber === "1.2", true);

    expect(result.matched).toBe(true);
    expect(result.content).toContain("- [x] 1.2 Second step pending");
    // Other lines should remain unchanged
    expect(result.content).toContain("- [x] 1.1 First step done");
    expect(result.content).toContain("- [ ] 2.1 Third step pending");
    expect(result.content).toContain("- [x] 2.2 Fourth step done");
  });

  it("should toggle a checked step to unchecked", () => {
    const result = toggleStep(sampleContent, (s) => s.stepNumber === "1.1", false);

    expect(result.matched).toBe(true);
    expect(result.content).toContain("- [ ] 1.1 First step done");
  });

  it("should not modify when status matches (already checked, trying to check)", () => {
    const result = toggleStep(sampleContent, (s) => s.stepNumber === "1.1", true);

    expect(result.matched).toBe(false);
    expect(result.content).toBe(sampleContent);
  });

  it("should not modify when status matches (already unchecked, trying to uncheck)", () => {
    const result = toggleStep(sampleContent, (s) => s.stepNumber === "1.2", false);

    expect(result.matched).toBe(false);
    expect(result.content).toBe(sampleContent);
  });

  it("should return matched=false when no step matches", () => {
    const result = toggleStep(sampleContent, (s) => s.stepNumber === "99.99", true);

    expect(result.matched).toBe(false);
    expect(result.content).toBe(sampleContent);
  });

  it("should match by step number", () => {
    const result = toggleStep(sampleContent, (s) => s.stepNumber === "2.2", false);

    expect(result.matched).toBe(true);
    expect(result.content).toContain("- [ ] 2.2 Fourth step done");
  });

  it("should match by tag", () => {
    const tagContent = [
      "- [ ] 1.1 [spawn:financial-valuation] Create model",
      "- [ ] 1.2 [spawn:risk-assessment] Evaluate risks",
    ].join("\n");

    const result = toggleStep(tagContent, (s) => s.tag === "spawn:financial-valuation", true);

    expect(result.matched).toBe(true);
    expect(result.content).toContain("- [x] 1.1 [spawn:financial-valuation] Create model");
    // Other lines unchanged
    expect(result.content).toContain("- [ ] 1.2 [spawn:risk-assessment] Evaluate risks");
  });

  it("should match by partial text", () => {
    const result = toggleStep(sampleContent, (s) => s.text.includes("Third step"), true);

    expect(result.matched).toBe(true);
    expect(result.content).toContain("- [x] 2.1 Third step pending");
  });

  it("should only modify the first matching step", () => {
    const multiMatch = [
      "- [ ] 1.1 Step A",
      "- [ ] 1.2 Step B",
      "- [ ] 1.3 Step A duplicate",
    ].join("\n");

    const result = toggleStep(multiMatch, (s) => s.text.includes("Step A"), true);

    expect(result.matched).toBe(true);
    const lines = result.content.split("\n");
    expect(lines[0]).toContain("[x]");
    expect(lines[2]).toContain("[ ]"); // Third step should remain unchecked
  });
});

// ============================================================================
// updateProgress
// ============================================================================

describe("updateProgress", () => {
  it("should update status.yaml progress", () => {
    // 准备 checklist.md
    const checklistContent = [
      "- [x] 1.1 First step done",
      "- [ ] 1.2 Second step pending",
      "- [x] 1.3 Third step done",
      "- [ ] 1.4 Fourth step pending",
    ].join("\n");
    writeFileSync(join(tmpDir, "checklist.md"), checklistContent, "utf-8");

    // 准备 status.yaml
    const statusData = {
      task_id: "test-task",
      title: "Test",
      status: "running",
      progress: { total: 0, completed: 0, current_step: "", percentage: 0 },
    };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    // 执行
    updateProgress(tmpDir);

    // 验证
    const updated = YAML.parse(
      require("fs").readFileSync(join(tmpDir, "status.yaml"), "utf-8"),
    );

    expect(updated.progress).toEqual({
      total: 4,
      completed: 2,
      current_step: "1.2",
      percentage: 50,
    });
  });

  it("should silently skip when status.yaml does not exist", () => {
    // 只创建 checklist.md，不创建 status.yaml
    writeFileSync(join(tmpDir, "checklist.md"), "- [x] 1.1 Done\n", "utf-8");

    // 不应抛错
    expect(() => updateProgress(tmpDir)).not.toThrow();
  });

  it("should silently skip when checklist does not exist", () => {
    // 只创建 status.yaml，不创建 checklist.md
    writeFileSync(join(tmpDir, "status.yaml"), "task_id: test\n", "utf-8");

    // 不应抛错
    expect(() => updateProgress(tmpDir)).not.toThrow();

    // status.yaml 应保持不变（progress 未被修改）
    const content = require("fs").readFileSync(join(tmpDir, "status.yaml"), "utf-8");
    expect(content).toBe("task_id: test\n");
  });

  it("should calculate 100% when all steps are checked", () => {
    writeFileSync(join(tmpDir, "checklist.md"), "- [x] 1.1 Done\n- [x] 1.2 Done\n", "utf-8");

    const statusData = {
      task_id: "test",
      progress: { total: 0, completed: 0, current_step: "", percentage: 0 },
    };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    updateProgress(tmpDir);

    const updated = YAML.parse(
      require("fs").readFileSync(join(tmpDir, "status.yaml"), "utf-8"),
    );

    expect(updated.progress).toEqual({
      total: 2,
      completed: 2,
      current_step: "",
      percentage: 100,
    });
  });

  it("should only count steps with step numbers in progress", () => {
    writeFileSync(
      join(tmpDir, "checklist.md"),
      [
        "- [x] 1.1 Numbered step",
        "- [ ] Unnumbered checkbox step",
        "- [x] 1.2 Another numbered step",
      ].join("\n"),
      "utf-8",
    );

    const statusData = {
      task_id: "test",
      progress: { total: 0, completed: 0, current_step: "", percentage: 0 },
    };
    writeFileSync(join(tmpDir, "status.yaml"), YAML.stringify(statusData), "utf-8");

    updateProgress(tmpDir);

    const updated = YAML.parse(
      require("fs").readFileSync(join(tmpDir, "status.yaml"), "utf-8"),
    );

    // 只有带步骤编号的才计入 total（共 2 个，完成 2 个）
    expect(updated.progress.total).toBe(2);
    expect(updated.progress.completed).toBe(2);
  });
});
