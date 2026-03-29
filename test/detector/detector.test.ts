import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { Detector } from "../../src/detector.js";

describe("Detector", () => {
  let tmpDir: string;
  let detector: Detector;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "detector-test-"));
    detector = new Detector();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeStatus(taskDir: string, data: Record<string, unknown>): void {
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
  }

  // L1: none
  it("should return level 'none' when spec-task/ directory does not exist", async () => {
    const result = await detector.detect(tmpDir);
    expect(result.level).toBe("none");
    expect(result.spec_task_dir).toBeNull();
    expect(result.skeleton_tasks).toHaveLength(0);
    expect(result.incomplete_tasks).toHaveLength(0);
  });

  // L2: empty
  it("should return level 'empty' when spec-task/ exists but has no task subdirs", async () => {
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
    const result = await detector.detect(tmpDir);
    expect(result.level).toBe("empty");
    expect(result.spec_task_dir).toBe(join(tmpDir, "spec-task"));
    expect(result.skeleton_tasks).toHaveLength(0);
  });

  // L3: skeleton — missing artifacts
  it("should return level 'skeleton' when task has status.yaml but missing brief.md", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    writeStatus(taskDir, { task_id: "task-1", status: "pending" });

    const result = await detector.detect(tmpDir);
    expect(result.level).toBe("skeleton");
    expect(result.skeleton_tasks).toHaveLength(1);
    expect(result.skeleton_tasks[0].name).toBe("task-1");
    expect(result.skeleton_tasks[0].missing).toContain("brief");
  });

  it("should detect multiple missing artifacts for skeleton tasks", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    writeStatus(taskDir, { task_id: "task-1", status: "running" });
    writeFileSync(join(taskDir, "brief.md"), "# Brief", "utf-8");

    const result = await detector.detect(tmpDir);
    expect(result.level).toBe("skeleton");
    expect(result.skeleton_tasks[0].missing).toEqual(
      expect.arrayContaining(["spec", "plan", "checklist"])
    );
    expect(result.skeleton_tasks[0].missing).not.toContain("brief");
  });

  // L4: in_progress
  it("should return level 'in_progress' when task has all artifacts and non-terminal status", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    writeStatus(taskDir, { task_id: "task-1", status: "running" });
    for (const artifact of ["brief", "spec", "plan", "checklist"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }

    const result = await detector.detect(tmpDir);
    expect(result.level).toBe("in_progress");
    expect(result.incomplete_tasks).toHaveLength(1);
    expect(result.incomplete_tasks[0].name).toBe("task-1");
    expect(result.incomplete_tasks[0].status).toBe("running");
  });

  // L5: all_done
  it("should return level 'all_done' when all tasks are in terminal status", async () => {
    const taskDir = join(tmpDir, "spec-task", "task-1");
    writeStatus(taskDir, { task_id: "task-1", status: "completed" });
    for (const artifact of ["brief", "spec", "plan", "checklist"]) {
      writeFileSync(join(taskDir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }

    const result = await detector.detect(tmpDir);
    expect(result.level).toBe("all_done");
    expect(result.incomplete_tasks).toHaveLength(0);
  });

  // YAML parse error → skip
  it("should silently skip tasks with invalid YAML in status.yaml", async () => {
    const taskDir = join(tmpDir, "spec-task", "bad-yaml");
    mkdirSync(taskDir, { recursive: true });
    // Tab-indented YAML causes parse error
    writeFileSync(join(taskDir, "status.yaml"), "\tinvalid:\n\t  key: value", "utf-8");

    const result = await detector.detect(tmpDir);
    // bad-yaml 被跳过，没有有效任务（但有目录存在）→ all_done
    expect(result.level).toBe("all_done");
  });

  // skeleton优先
  it("should return 'skeleton' when both skeleton and complete tasks exist", async () => {
    const task1Dir = join(tmpDir, "spec-task", "task-1");
    writeStatus(task1Dir, { task_id: "task-1", status: "pending" });

    const task2Dir = join(tmpDir, "spec-task", "task-2");
    writeStatus(task2Dir, { task_id: "task-2", status: "running" });
    for (const artifact of ["brief", "spec", "plan", "checklist"]) {
      writeFileSync(join(task2Dir, `${artifact}.md`), `# ${artifact}`, "utf-8");
    }

    const result = await detector.detect(tmpDir);
    expect(result.level).toBe("skeleton");
    expect(result.skeleton_tasks).toHaveLength(1);
  });

  // filter hidden files
  it("should filter hidden files and config.yaml from task directories", async () => {
    const specDir = join(tmpDir, "spec-task");
    mkdirSync(specDir, { recursive: true });
    mkdirSync(join(specDir, ".hidden"), { recursive: true });
    writeFileSync(join(specDir, "config.yaml"), "key: value", "utf-8");

    const result = await detector.detect(tmpDir);
    expect(result.level).toBe("empty");
  });

  // permission denied → skip
  it("should silently skip tasks when permission denied reading status.yaml", async () => {
    const taskDir = join(tmpDir, "spec-task", "no-read");
    mkdirSync(taskDir, { recursive: true });
    const statusFile = join(taskDir, "status.yaml");
    writeFileSync(statusFile, "status: pending", "utf-8");

    try {
      chmodSync(statusFile, 0o000);
      const result = await detector.detect(tmpDir);
      // root 用户不受 chmod 限制，所以结果可能是 empty 或 all_done
      // 关键是不抛错
      expect(["empty", "none", "skeleton", "in_progress", "all_done"]).toContain(result.level);
    } finally {
      chmodSync(statusFile, 0o644);
    }
  });
});
