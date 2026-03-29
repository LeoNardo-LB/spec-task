import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ConfigManager } from "../../src/core/config.js";
import type { SpecTaskConfig } from "../../src/types.js";

describe("ConfigManager", () => {
  let tmpDir: string;
  let cm: ConfigManager;
  let defaultConfig: SpecTaskConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));
    cm = new ConfigManager();
    defaultConfig = {
      context: "",
      runtime: {
        allow_agent_self_delegation: true,
        task_timeout: 60,
      },
      archive: {
        record_history: true,
        generate_lessons: true,
        auto_archive: false,
      },
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeIdentityFile(filename: string, content: string): void {
    writeFileSync(join(tmpDir, filename), content, "utf-8");
  }

  // ====================================================================
  // deepMerge
  // ====================================================================
  describe("deepMerge", () => {
    it("should merge flat objects", () => {
      const base: SpecTaskConfig = { context: "base" };
      const override: Partial<SpecTaskConfig> = { context: "override" };
      const result = cm.deepMerge(base, override);
      expect(result.context).toBe("override");
    });

    it("should recursively merge nested dicts", () => {
      const base: SpecTaskConfig = {
        runtime: { allow_agent_self_delegation: true, task_timeout: 60 },
        archive: { record_history: true },
      };
      const override: Partial<SpecTaskConfig> = {
        runtime: { task_timeout: 120 },
      };
      const result = cm.deepMerge(base, override);
      expect(result.runtime!.allow_agent_self_delegation).toBe(true);
      expect(result.runtime!.task_timeout).toBe(120);
      expect(result.archive!.record_history).toBe(true);
    });

    it("should replace lists (not merge)", () => {
      const base: SpecTaskConfig = {
        failure_policy: {
          hard_block: {
            adapt_modifies: ["spec", "plan"],
          },
        },
      };
      const override: Partial<SpecTaskConfig> = {
        failure_policy: {
          hard_block: {
            adapt_modifies: ["brief"],
          },
        },
      };
      const result = cm.deepMerge(base, override);
      expect(result.failure_policy!.hard_block!.adapt_modifies).toEqual(["brief"]);
    });

    it("should not mutate base object", () => {
      const base: SpecTaskConfig = { runtime: { task_timeout: 60 } };
      const override: Partial<SpecTaskConfig> = { runtime: { task_timeout: 120 } };
      cm.deepMerge(base, override);
      expect(base.runtime!.task_timeout).toBe(60);
    });

    it("should handle empty override", () => {
      const base: SpecTaskConfig = { context: "keep" };
      const result = cm.deepMerge(base, {});
      expect(result.context).toBe("keep");
    });

    it("should handle empty base", () => {
      const result = cm.deepMerge({}, { context: "new" });
      expect(result.context).toBe("new");
    });
  });

  // ====================================================================
  // extractContext
  // ====================================================================
  describe("extractContext", () => {
    it("should extract context from first found identity file", async () => {
      writeIdentityFile("AGENTS.md", "# AGENTS\n\nThis is the context description for the project.\nMore content...");
      const ctx = await cm.extractContext(tmpDir);
      expect(ctx).toContain("This is the context description");
    });

    it("should return empty string when no identity files exist", async () => {
      const ctx = await cm.extractContext(tmpDir);
      expect(ctx).toBe("");
    });

    it("should respect 200 character limit and add ellipsis", async () => {
      const longLine = "A".repeat(300);
      writeIdentityFile("IDENTITY.md", `# Title\n\n${longLine}`);
      const ctx = await cm.extractContext(tmpDir);
      expect(ctx.length).toBeLessThanOrEqual(203); // 200 + "..."
      expect(ctx).toContain("...");
    });

    it("should skip markdown headers (# lines)", async () => {
      writeIdentityFile("SOUL.md", "# SOUL\n\n## Section\n\nActual content here\n");
      const ctx = await cm.extractContext(tmpDir);
      expect(ctx).toContain("Actual content here");
      expect(ctx).not.toContain("# SOUL");
    });

    it("should skip HTML comment lines", async () => {
      writeIdentityFile("README.md", "<!-- this is a comment -->\n\nReal content starts here\n");
      const ctx = await cm.extractContext(tmpDir);
      expect(ctx).toContain("Real content starts here");
      expect(ctx).not.toContain("comment");
    });

    it("should try files in order: AGENTS.md, IDENTITY.md, SOUL.md, README.md, CLAUDE.md", async () => {
      writeIdentityFile("README.md", "README context");
      writeIdentityFile("CLAUDE.md", "CLAUDE context");
      const ctx = await cm.extractContext(tmpDir);
      expect(ctx).toBe("README context");
    });

    it("should silently skip unreadable files", async () => {
      const agentsPath = join(tmpDir, "AGENTS.md");
      writeFileSync(agentsPath, "should not read this");
      try {
        const { chmodSync } = await import("fs");
        chmodSync(agentsPath, 0o000);
        const ctx = await cm.extractContext(tmpDir);
        expect(typeof ctx).toBe("string");
      } finally {
        const { chmodSync } = await import("fs");
        chmodSync(agentsPath, 0o644);
      }
    });
  });

  // ====================================================================
  // ensureProjectConfig
  // ====================================================================
  describe("ensureProjectConfig", () => {
    it("should create config.yaml if not exists", async () => {
      await cm.ensureProjectConfig(tmpDir, defaultConfig);
      const { readFile } = await import("fs/promises");
      const content = await readFile(join(tmpDir, "spec-task", "config.yaml"), "utf-8");
      expect(content).toContain("record_history: true");
    });

    it("should not overwrite existing config.yaml", async () => {
      const specDir = join(tmpDir, "spec-task");
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "config.yaml"), "archive:\n  record_history: false\n", "utf-8");
      await cm.ensureProjectConfig(tmpDir, defaultConfig);
      const { readFile } = await import("fs/promises");
      const content = await readFile(join(specDir, "config.yaml"), "utf-8");
      expect(content).toContain("record_history: false");
    });
  });

  // ====================================================================
  // 配置校验（3 个）
  // ====================================================================
  describe("config validation", () => {
    it("should handle invalid YAML in project config gracefully", async () => {
      const specDir = join(tmpDir, "spec-task");
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "config.yaml"), "invalid: yaml: content: [", "utf-8");
      const result = await cm.loadMergedConfig(tmpDir);
      expect(result.archive!.record_history).toBe(true);
    });

    it("should handle config with unexpected field types", async () => {
      const specDir = join(tmpDir, "spec-task");
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "config.yaml"), "archive:\n  record_history: \"not_a_boolean\"\n", "utf-8");
      const result = await cm.loadMergedConfig(tmpDir);
      expect(result.archive).toBeDefined();
    });

    it("should handle empty project config file", async () => {
      const specDir = join(tmpDir, "spec-task");
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "config.yaml"), "", "utf-8");
      const result = await cm.loadMergedConfig(tmpDir);
      expect(result.archive!.record_history).toBe(true);
    });
  });
});
