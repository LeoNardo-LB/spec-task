import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  getNextRunId,
  getActiveRuns,
  resolveRunDir,
  resolveTaskRoot,
} from "../run-utils.js";

// ============================================================================
// 临时目录
// ============================================================================

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    process.env.TMPDIR ?? "/tmp",
    `run-utils-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// getNextRunId
// ============================================================================

describe("getNextRunId", () => {
  it("should return '001' when runs/ does not exist", async () => {
    const taskDir = join(tmpDir, "my-task");
    mkdirSync(taskDir, { recursive: true });

    const result = await getNextRunId(taskDir);
    expect(result).toBe("001");
  });

  it("should return '001' when runs/ exists but is empty", async () => {
    const taskDir = join(tmpDir, "my-task");
    mkdirSync(join(taskDir, "runs"), { recursive: true });

    const result = await getNextRunId(taskDir);
    expect(result).toBe("001");
  });

  it("should return '002' when runs/ has 001", async () => {
    const taskDir = join(tmpDir, "my-task");
    mkdirSync(join(taskDir, "runs", "001"), { recursive: true });

    const result = await getNextRunId(taskDir);
    expect(result).toBe("002");
  });

  it("should return '003' when runs/ has 001 and 002", async () => {
    const taskDir = join(tmpDir, "my-task");
    mkdirSync(join(taskDir, "runs", "001"), { recursive: true });
    mkdirSync(join(taskDir, "runs", "002"), { recursive: true });

    const result = await getNextRunId(taskDir);
    expect(result).toBe("003");
  });

  it("should ignore non-numeric directories", async () => {
    const taskDir = join(tmpDir, "my-task");
    mkdirSync(join(taskDir, "runs", "001"), { recursive: true });
    mkdirSync(join(taskDir, "runs", "abc"), { recursive: true });
    mkdirSync(join(taskDir, "runs", "tmp"), { recursive: true });
    mkdirSync(join(taskDir, "runs", "12"), { recursive: true }); // not 3-digit

    const result = await getNextRunId(taskDir);
    expect(result).toBe("002");
  });

  it("should ignore files (non-directories)", async () => {
    const taskDir = join(tmpDir, "my-task");
    mkdirSync(join(taskDir, "runs", "001"), { recursive: true });
    writeFileSync(join(taskDir, "runs", "002"), "not a dir");

    const result = await getNextRunId(taskDir);
    expect(result).toBe("002");
  });
});

// ============================================================================
// getActiveRuns
// ============================================================================

describe("getActiveRuns", () => {
  function writeRunStatus(taskDir: string, runId: string, status: string) {
    const runPath = join(taskDir, "runs", runId);
    mkdirSync(runPath, { recursive: true });
    writeFileSync(
      join(runPath, "status.yaml"),
      YAML.stringify({ task_id: "test", status }),
      "utf-8",
    );
  }

  it("should return empty array when runs/ does not exist", async () => {
    const taskDir = join(tmpDir, "my-task");
    mkdirSync(taskDir, { recursive: true });

    const result = await getActiveRuns(taskDir);
    expect(result).toEqual([]);
  });

  it("should return empty array when all runs are terminal", async () => {
    const taskDir = join(tmpDir, "my-task");
    writeRunStatus(taskDir, "001", "completed");
    writeRunStatus(taskDir, "002", "failed");
    writeRunStatus(taskDir, "003", "cancelled");

    const result = await getActiveRuns(taskDir);
    expect(result).toEqual([]);
  });

  it("should return active run IDs", async () => {
    const taskDir = join(tmpDir, "my-task");
    writeRunStatus(taskDir, "001", "running");
    writeRunStatus(taskDir, "002", "completed");

    const result = await getActiveRuns(taskDir);
    expect(result).toEqual(["001"]);
  });

  it("should filter mixed runs correctly", async () => {
    const taskDir = join(tmpDir, "my-task");
    writeRunStatus(taskDir, "001", "completed");
    writeRunStatus(taskDir, "002", "running");
    writeRunStatus(taskDir, "003", "pending");
    writeRunStatus(taskDir, "004", "failed");
    writeRunStatus(taskDir, "005", "blocked");

    const result = await getActiveRuns(taskDir);
    expect(result).toEqual(["002", "003", "005"]);
  });

  it("should skip runs without status.yaml", async () => {
    const taskDir = join(tmpDir, "my-task");
    mkdirSync(join(taskDir, "runs", "001"), { recursive: true });
    writeRunStatus(taskDir, "002", "running");

    const result = await getActiveRuns(taskDir);
    expect(result).toEqual(["002"]);
  });

  it("should skip runs with malformed status.yaml", async () => {
    const taskDir = join(tmpDir, "my-task");
    const badRun = join(taskDir, "runs", "001");
    mkdirSync(badRun, { recursive: true });
    writeFileSync(join(badRun, "status.yaml"), "not valid yaml: {{", "utf-8");

    writeRunStatus(taskDir, "002", "running");

    const result = await getActiveRuns(taskDir);
    expect(result).toEqual(["002"]);
  });
});

// ============================================================================
// resolveRunDir
// ============================================================================

describe("resolveRunDir", () => {
  it("should construct correct run directory path", () => {
    const result = resolveRunDir("my-task", "001", "/home/user/project");
    expect(result).toBe("/home/user/project/spec-task/my-task/runs/001");
  });

  it("should handle different run IDs", () => {
    const result = resolveRunDir("my-task", "003", "/home/user/project");
    expect(result).toBe("/home/user/project/spec-task/my-task/runs/003");
  });
});

// ============================================================================
// resolveTaskRoot
// ============================================================================

describe("resolveTaskRoot", () => {
  it("should construct correct task root path", () => {
    const result = resolveTaskRoot("my-task", "/home/user/project");
    expect(result).toBe("/home/user/project/spec-task/my-task");
  });

  it("should handle nested task names", () => {
    const result = resolveTaskRoot("feature/auth", "/home/user/project");
    expect(result).toBe("/home/user/project/spec-task/feature/auth");
  });
});
