import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { checkVerifyFinalizeBlocked } from "../../src/core/steps-utils.js";
import { suggestVerificationCriteria } from "../../src/core/steps-utils.js";
import type { Step } from "../../src/types.js";

describe("checkVerifyFinalizeBlocked", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns blockReason when criteria is empty", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "verify-finalize-"));
    const statusYaml = YAML.stringify({
      verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
    });
    writeFileSync(join(tmpDir, "status.yaml"), statusYaml, "utf-8");

    const result = checkVerifyFinalizeBlocked(tmpDir);
    expect(result).toEqual({ blockReason: expect.stringContaining("尚无验收标准") });
  });

  it("returns null when criteria exist", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "verify-finalize-"));
    const statusYaml = YAML.stringify({
      verification: {
        status: "pending",
        criteria: [{ criterion: "测试通过", result: "passed", evidence: "", reason: "" }],
        verified_at: null,
        verified_by: null,
      },
    });
    writeFileSync(join(tmpDir, "status.yaml"), statusYaml, "utf-8");

    expect(checkVerifyFinalizeBlocked(tmpDir)).toBeNull();
  });

  it("returns null when status.yaml does not exist", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "verify-finalize-"));
    // tmpDir is empty, no status.yaml
    expect(checkVerifyFinalizeBlocked(tmpDir)).toBeNull();
  });

  it("returns null when directory does not exist", () => {
    expect(checkVerifyFinalizeBlocked("/nonexistent/path/that/does/not/exist")).toBeNull();
  });
});

describe("suggestVerificationCriteria", () => {
  function makeStep(
    id: string,
    title: string,
    status: "pending" | "completed" | "skipped" = "pending",
  ): Step {
    return {
      id,
      summary: { title, content: "", approach: "", sources: [] },
      status,
      completed_at: status !== "pending" ? "2026-04-01T00:00:00.000Z" : null,
      tags: [],
    };
  }

  it("returns suggestions for all steps when no criteria exist", () => {
    const steps = [makeStep("1.1", "实现登录"), makeStep("1.2", "编写测试"), makeStep("2.1", "部署")];
    const result = suggestVerificationCriteria(steps, []);
    expect(result).toHaveLength(3);
    expect(result[0]).toContain("1.1");
    expect(result[0]).toContain("实现登录");
  });

  it("skips steps already covered by criterion (substring match)", () => {
    const steps = [makeStep("1.1", "实现登录"), makeStep("1.2", "编写测试"), makeStep("2.1", "部署")];
    const criteria = [{ criterion: "验证步骤 1.1: 实现登录通过" }];
    const result = suggestVerificationCriteria(steps, criteria);
    expect(result).toHaveLength(2);
    expect(result).not.toContain(expect.stringContaining("1.1"));
  });

  it("skips skipped steps", () => {
    const steps = [
      makeStep("1.1", "实现登录", "completed"),
      makeStep("1.2", "跳过步骤", "skipped"),
      makeStep("2.1", "部署", "pending"),
    ];
    const result = suggestVerificationCriteria(steps, []);
    expect(result).toHaveLength(2);
    expect(result).not.toContain(expect.stringContaining("1.2"));
  });

  it("returns empty array for empty steps", () => {
    expect(suggestVerificationCriteria([], [])).toEqual([]);
  });

  it("uses step.id when step has no summary.title", () => {
    const steps = [
      {
        id: "1.1",
        summary: { title: "", content: "", approach: "", sources: [] },
        status: "pending" as const,
        completed_at: null as string | null,
        tags: [],
      },
    ];
    const result = suggestVerificationCriteria(steps, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("1.1");
  });
});
