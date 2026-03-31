import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeChecklistWrite } from "../../src/tools/checklist-write.js";

describe("executeChecklistWrite", () => {
  let tmpDir: string;
  let taskDir: string;

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T10:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "checklist-write-test-"));
    taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });
    // 创建 status.yaml 以便测试进度自动更新
    writeFileSync(
      join(taskDir, "status.yaml"),
      YAML.stringify({ status: "running", progress: { total: 0, completed: 0, current_step: "", percentage: 0 } }),
      "utf-8"
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create new checklist.md when it does not exist", async () => {
    const content = "- [ ] 1.1 First step\n- [ ] 1.2 Second step\n";
    const result = await executeChecklistWrite("cl-1", { task_dir: taskDir, content });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(existsSync(join(taskDir, "checklist.md"))).toBe(true);
    expect(readFileSync(join(taskDir, "checklist.md"), "utf-8")).toBe(content);
  });

  it("should overwrite existing checklist.md", async () => {
    writeFileSync(join(taskDir, "checklist.md"), "old content\n", "utf-8");
    const newContent = "- [x] 1.1 Done\n- [ ] 1.2 Pending\n";
    const result = await executeChecklistWrite("cl-1", { task_dir: taskDir, content: newContent });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(readFileSync(join(taskDir, "checklist.md"), "utf-8")).toBe(newContent);
  });

  it("should auto-update status.yaml progress after write", async () => {
    const content = "- [x] 1.1 Done\n- [ ] 1.2 Pending\n- [ ] 1.3 Also pending\n";
    await executeChecklistWrite("cl-1", { task_dir: taskDir, content });

    const statusContent = readFileSync(join(taskDir, "status.yaml"), "utf-8");
    const statusData = YAML.parse(statusContent);

    expect(statusData.progress.total).toBe(3);
    expect(statusData.progress.completed).toBe(1);
    expect(statusData.progress.percentage).toBe(33);
    expect(statusData.progress.current_step).toBe("1.2");
  });

  it("should silently skip progress update when status.yaml does not exist", async () => {
    rmSync(join(taskDir, "status.yaml"));
    const content = "- [x] 1.1 Done\n";
    const result = await executeChecklistWrite("cl-1", { task_dir: taskDir, content });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(existsSync(join(taskDir, "checklist.md"))).toBe(true);
  });

  it("should return error when task_dir is empty", async () => {
    const result = await executeChecklistWrite("cl-1", { task_dir: "", content: "some content" });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should return error when content is empty", async () => {
    const result = await executeChecklistWrite("cl-1", { task_dir: taskDir, content: "" });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should return error when content is undefined", async () => {
    const result = await executeChecklistWrite("cl-1", { task_dir: taskDir, content: undefined } as any);
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should write arbitrary markdown (no format validation)", async () => {
    const content = `# My Checklist

## Phase 1
- [x] 1.1 Do something

### Notes
This is a note, not a checkbox.

- [ ] 1.2 Next step
`;
    await executeChecklistWrite("cl-1", { task_dir: taskDir, content });

    expect(readFileSync(join(taskDir, "checklist.md"), "utf-8")).toBe(content);
  });
});
