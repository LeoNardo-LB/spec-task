import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { SchemaReader } from "../../src/core/schema-reader.js";

function makeSchemaDir(baseDir: string, schemaData?: Record<string, unknown>): string {
  const schemaDir = join(baseDir, "schemas", "agent-task");
  mkdirSync(schemaDir, { recursive: true });
  const schema = schemaData ?? {
    name: "agent-task",
    version: 1,
    artifacts: [
      { id: "brief", generates: "brief.md", description: "Brief", template: "brief.md", instruction: "Create brief", requires: [] },
      { id: "spec", generates: "spec.md", description: "Spec", template: "spec.md", instruction: "Create spec", requires: ["brief"] },
      { id: "plan", generates: "plan.md", description: "Plan", template: "plan.md", instruction: "执行计划", requires: ["brief"] },
    ],
  };
  writeFileSync(join(schemaDir, "schema.yaml"), YAML.stringify(schema), "utf-8");
  return schemaDir;
}

describe("SchemaReader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "schema-reader-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // === 推断式状态机 ===
  describe("inferred artifact state machine", () => {
    it("should infer states when only brief exists", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);
      const taskRoot = join(specTaskDir, "test-task");
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "brief.md"), "# Brief", "utf-8");

      const reader = new SchemaReader(null, taskRoot);
      const result = await reader.getStatus(taskRoot);

      expect(result.hasCycle).toBe(false);
      const briefStatus = result.artifacts.find(a => a.id === "brief");
      expect(briefStatus?.state).toBe("done");
      const planStatus = result.artifacts.find(a => a.id === "plan");
      expect(planStatus?.state).toBe("ready");
      const specStatus = result.artifacts.find(a => a.id === "spec");
      expect(specStatus?.state).toBe("ready");
      expect(result.artifacts).toHaveLength(3);
    });

    it("should infer all done when all files exist", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);
      const taskRoot = join(specTaskDir, "test-task");
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "brief.md"), "# Brief", "utf-8");
      writeFileSync(join(taskRoot, "spec.md"), "# Spec", "utf-8");
      writeFileSync(join(taskRoot, "plan.md"), "# Plan", "utf-8");

      const reader = new SchemaReader(null, taskRoot);
      const result = await reader.getStatus(taskRoot);

      expect(result.completed.sort()).toEqual(["brief", "plan", "spec"]);
      expect(result.nextReady).toEqual([]);
    });

  });

  // === parse ===
  describe("parse()", () => {
    it("should parse valid schema.yaml", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);

      const reader = new SchemaReader(null, specTaskDir);
      const artifacts = await reader.parse();

      expect(artifacts).toHaveLength(3);
      expect(artifacts[0].id).toBe("brief");
      expect(artifacts[1].requires).toEqual(["brief"]);
    });

    it("should return empty for missing schema.yaml", async () => {
      const reader = new SchemaReader("/nonexistent/schema.yaml");
      const artifacts = await reader.parse();
      expect(artifacts).toEqual([]);
    });

    it("should return empty for malformed YAML", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(join(specTaskDir, "schemas", "agent-task"), { recursive: true });
      writeFileSync(join(specTaskDir, "schemas", "agent-task", "schema.yaml"), "not: valid: yaml: [", "utf-8");

      const reader = new SchemaReader(null, specTaskDir);
      const artifacts = await reader.parse();
      expect(artifacts).toEqual([]);
    });
  });

  // === cycle detection ===
  describe("cycle detection", () => {
    it("should detect circular dependencies", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(join(specTaskDir, "schemas", "agent-task"), { recursive: true });
      writeFileSync(join(specTaskDir, "schemas", "agent-task", "schema.yaml"), YAML.stringify({
        name: "test",
        artifacts: [
          { id: "a", generates: "a.md", requires: ["b"] },
          { id: "b", generates: "b.md", requires: ["a"] },
        ],
      }), "utf-8");

      const reader = new SchemaReader(null, specTaskDir);
      await reader.parse();
      const result = await reader.getStatus(join(tmpDir, "test-task"));
      expect(result.hasCycle).toBe(true);
    });
  });

  // === getNextReady ===
  describe("getNextReady()", () => {
    it("should return brief as first ready when no files exist", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);
      const taskRoot = join(specTaskDir, "test-task");
      mkdirSync(taskRoot, { recursive: true });

      const reader = new SchemaReader(null, taskRoot);
      const status = await reader.getStatus(taskRoot);
      expect(reader.getNextReady(status)).toEqual(["brief"]);
    });

    it("should return empty when all done", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);
      const taskRoot = join(specTaskDir, "test-task");
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "brief.md"), "# Brief", "utf-8");
      writeFileSync(join(taskRoot, "spec.md"), "# Spec", "utf-8");
      writeFileSync(join(taskRoot, "plan.md"), "# Plan", "utf-8");

      const reader = new SchemaReader(null, taskRoot);
      const status = await reader.getStatus(taskRoot);
      expect(reader.getNextReady(status)).toEqual([]);
    });
  });

  // === config context/rules ===
  describe("config context and rules", () => {
    it("should read context and rules from config.yaml", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);
      writeFileSync(join(specTaskDir, "config.yaml"), YAML.stringify({
        context: "项目背景信息",
        rules: { brief: ["必须包含成功标准"], plan: ["必须包含 Key Decisions"] },
      }), "utf-8");

      const reader = new SchemaReader(null, specTaskDir);
      const context = await reader.getContext(join(specTaskDir, "test-task"));
      const briefRules = await reader.getRules("brief", join(specTaskDir, "test-task"));
      const planRules = await reader.getRules("plan", join(specTaskDir, "test-task"));

      expect(context).toBe("项目背景信息");
      expect(briefRules).toEqual(["必须包含成功标准"]);
      expect(planRules).toEqual(["必须包含 Key Decisions"]);
    });

    it("should return empty for missing config.yaml", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);

      const reader = new SchemaReader(null, specTaskDir);
      const context = await reader.getContext(join(specTaskDir, "test-task"));
      const rules = await reader.getRules("brief", join(specTaskDir, "test-task"));
      expect(context).toBe("");
      expect(rules).toEqual([]);
    });
  });

  // === getArtifact ===
  describe("getArtifact()", () => {
    it("should return artifact for valid id", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);

      const reader = new SchemaReader(null, specTaskDir);
      await reader.parse();
      const artifact = reader.getArtifact("brief");
      expect(artifact).not.toBeNull();
      expect(artifact!.id).toBe("brief");
    });

    it("should return null for invalid id", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);

      const reader = new SchemaReader(null, specTaskDir);
      await reader.parse();
      expect(reader.getArtifact("nonexistent")).toBeNull();
    });
  });

  // === getInstructions ===
  describe("getInstructions()", () => {
    it("should return full guidance with dependency content", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);
      const taskRoot = join(specTaskDir, "test-task");
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(join(taskRoot, "brief.md"), "# Brief content", "utf-8");
      writeFileSync(join(specTaskDir, "config.yaml"), YAML.stringify({
        context: "项目背景",
        rules: { plan: ["必须有 Key Decisions"] },
      }), "utf-8");

      const reader = new SchemaReader(null, specTaskDir);
      const instructions = await reader.getInstructions("plan", taskRoot);

      expect(instructions).not.toBeNull();
      expect(instructions!.artifact_id).toBe("plan");
      expect(instructions!.instruction).toContain("执行计划");
      expect(instructions!.context).toBe("项目背景");
      expect(instructions!.rules).toEqual(["必须有 Key Decisions"]);
      expect(instructions!.dependencies).toHaveLength(1);
      expect(instructions!.dependencies[0].id).toBe("brief");
      expect(instructions!.dependencies[0].done).toBe(true);
      expect(instructions!.dependencies[0].content).toContain("Brief content");
    });

    it("should return null for invalid artifact id", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir);

      const reader = new SchemaReader(null, specTaskDir);
      const instructions = await reader.getInstructions("nonexistent", specTaskDir);
      expect(instructions).toBeNull();
    });

    it("should use instruction as fallback when template file is missing", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir, {
        name: "agent-task",
        version: 1,
        artifacts: [
          { id: "brief", generates: "brief.md", description: "Brief", template: "brief.md", instruction: "Fallback instruction without code block", requires: [] },
        ],
      });
      // 不创建 templates 目录，模拟模板文件缺失

      const reader = new SchemaReader(null, specTaskDir);
      const instructions = await reader.getInstructions("brief", specTaskDir);

      expect(instructions).not.toBeNull();
      expect(instructions!.template).toBe("Fallback instruction without code block");
    });

    it("should extract code block content from instruction as fallback", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir, {
        name: "agent-task",
        version: 1,
        artifacts: [
          {
            id: "spec",
            generates: "spec.md",
            description: "Spec",
            template: "spec.md",
            instruction: "Write a spec document:\n```markdown\n# Spec\n\n## Requirements\n\nWrite requirements here.\n```\nMake it comprehensive.",
            requires: [],
          },
        ],
      });

      const reader = new SchemaReader(null, specTaskDir);
      const instructions = await reader.getInstructions("spec", specTaskDir);

      expect(instructions).not.toBeNull();
      expect(instructions!.template).toBe("# Spec\n\n## Requirements\n\nWrite requirements here.");
    });

    it("should prefer template file over instruction fallback", async () => {
      const specTaskDir = join(tmpDir, "spec-task");
      mkdirSync(specTaskDir, { recursive: true });
      makeSchemaDir(specTaskDir, {
        name: "agent-task",
        version: 1,
        artifacts: [
          { id: "brief", generates: "brief.md", description: "Brief", template: "brief.md", instruction: "Fallback instruction", requires: [] },
        ],
      });
      // 创建模板文件
      const templateDir = join(specTaskDir, "schemas", "agent-task", "templates");
      mkdirSync(templateDir, { recursive: true });
      writeFileSync(join(templateDir, "brief.md"), "# Real template content", "utf-8");

      const reader = new SchemaReader(null, specTaskDir);
      const instructions = await reader.getInstructions("brief", specTaskDir);

      expect(instructions).not.toBeNull();
      expect(instructions!.template).toBe("# Real template content");
    });
  });
});
