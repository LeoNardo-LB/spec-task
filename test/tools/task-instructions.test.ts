import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeTaskInstructions } from "../../src/tools/task-instructions.js";
import { SchemaReader } from "../../src/core/schema-reader.js";

function makeSchemaDir(baseDir: string): void {
  const schemaDir = join(baseDir, "schemas", "agent-task");
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(join(schemaDir, "schema.yaml"), YAML.stringify({
    name: "agent-task",
    version: 1,
    artifacts: [
      { id: "brief", generates: "brief.md", description: "Brief", template: "brief.md", instruction: "Create brief", requires: [] },
      { id: "spec", generates: "spec.md", description: "Spec", template: "spec.md", instruction: "Create spec", requires: ["brief"] },
      { id: "plan", generates: "plan.md", description: "Plan", template: "plan.md", instruction: "Create plan", requires: ["brief"] },
      { id: "checklist", generates: "checklist.md", description: "Checklist", template: "checklist.md", instruction: "Create checklist", requires: ["spec", "plan"] },
    ],
  }), "utf-8");
}

function makeTemplatesDir(baseDir: string): void {
  const templatesDir = join(baseDir, "schemas", "agent-task", "templates");
  mkdirSync(templatesDir, { recursive: true });
  for (const name of ["brief.md", "spec.md", "plan.md", "checklist.md"]) {
    writeFileSync(join(templatesDir, name), `# Template for ${name}\n`, "utf-8");
  }
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

describe("executeTaskInstructions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-instr-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return INVALID_PARAMS for empty task_dir", async () => {
    const result = await executeTaskInstructions("test", { task_dir: "", artifact_id: "brief" });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should return INVALID_PARAMS for empty artifact_id", async () => {
    const result = await executeTaskInstructions("test", { task_dir: "/some/path", artifact_id: "" });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("should return TASK_NOT_FOUND when task_dir has no spec-task", async () => {
    const result = await executeTaskInstructions("test", {
      task_dir: "/tmp/no-spec-task-here",
      artifact_id: "brief",
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("should return INVALID_PARAMS for unknown artifact_id", async () => {
    const specTaskDir = join(tmpDir, "spec-task");
    mkdirSync(specTaskDir, { recursive: true });
    makeSchemaDir(specTaskDir);
    const taskRoot = join(specTaskDir, "test-task");
    mkdirSync(taskRoot, { recursive: true });

    const result = await executeTaskInstructions("test", {
      task_dir: taskRoot,
      artifact_id: "nonexistent",
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
    expect(data.message).toContain("nonexistent");
    expect(data.message).toContain("Valid IDs");
  });

  it("should return full guidance for brief artifact", async () => {
    const specTaskDir = join(tmpDir, "spec-task");
    mkdirSync(specTaskDir, { recursive: true });
    makeSchemaDir(specTaskDir);
    makeTemplatesDir(specTaskDir);
    writeFileSync(join(specTaskDir, "config.yaml"), YAML.stringify({
      context: "项目背景信息",
      rules: { brief: ["必须包含成功标准"] },
    }), "utf-8");
    const taskRoot = join(specTaskDir, "test-task");
    mkdirSync(taskRoot, { recursive: true });

    const result = await executeTaskInstructions("test", {
      task_dir: taskRoot,
      artifact_id: "brief",
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.artifact_id).toBe("brief");
    expect(data.instruction).toBe("Create brief");
    expect(data.context).toBe("项目背景信息");
    expect(data.rules).toEqual(["必须包含成功标准"]);
    expect(data.dependencies).toEqual([]);
    expect(data.available_artifacts).toContain("brief");
  });

  it("should include dependency content when deps are done", async () => {
    const specTaskDir = join(tmpDir, "spec-task");
    mkdirSync(specTaskDir, { recursive: true });
    makeSchemaDir(specTaskDir);
    makeTemplatesDir(specTaskDir);
    const taskRoot = join(specTaskDir, "test-task");
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(join(taskRoot, "brief.md"), "# Brief content here", "utf-8");

    const result = await executeTaskInstructions("test", {
      task_dir: taskRoot,
      artifact_id: "plan",
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.dependencies).toHaveLength(1);
    expect(data.dependencies[0].id).toBe("brief");
    expect(data.dependencies[0].done).toBe(true);
    expect(data.dependencies[0].content).toContain("Brief content here");
  });

  it("should show dep as not done when dep file missing", async () => {
    const specTaskDir = join(tmpDir, "spec-task");
    mkdirSync(specTaskDir, { recursive: true });
    makeSchemaDir(specTaskDir);
    makeTemplatesDir(specTaskDir);
    const taskRoot = join(specTaskDir, "test-task");
    mkdirSync(taskRoot, { recursive: true });

    const result = await executeTaskInstructions("test", {
      task_dir: taskRoot,
      artifact_id: "plan",
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.dependencies).toHaveLength(1);
    expect(data.dependencies[0].id).toBe("brief");
    expect(data.dependencies[0].done).toBe(false);
    expect(data.dependencies[0].content).toBeNull();
  });
});
