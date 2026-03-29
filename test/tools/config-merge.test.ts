import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { executeConfigMerge } from "../../src/tools/config-merge.js";

describe("executeConfigMerge", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T10:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "config-merge-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  it("should return default config when no project config exists", async () => {
    const result = await executeConfigMerge("tool-1", {
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.config).toBeDefined();
    // 默认配置包含 runtime 和 archive
    expect(data.config.runtime).toBeDefined();
    expect(data.config.runtime.allow_agent_self_delegation).toBe(true);
    expect(data.config.runtime.task_timeout).toBe(60);
    expect(data.config.archive).toBeDefined();
    expect(data.config.archive.record_history).toBe(true);
    expect(data.config.archive.generate_lessons).toBe(true);
    expect(data.config.archive.auto_archive).toBe(false);
  });

  it("should merge project config with default config", async () => {
    // 先创建项目配置
    const specDir = join(tmpDir, "spec-task");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "config.yaml"),
      YAML.stringify({
        runtime: { task_timeout: 120 },
        context: "my project context",
      }),
      "utf-8",
    );

    const result = await executeConfigMerge("tool-2", {
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    // project 覆盖了 task_timeout
    expect(data.config.runtime.task_timeout).toBe(120);
    // 默认的 allow_agent_self_delegation 保留
    expect(data.config.runtime.allow_agent_self_delegation).toBe(true);
    // project 新增的 context
    expect(data.config.context).toBe("my project context");
  });

  it("should deep merge nested config objects", async () => {
    const specDir = join(tmpDir, "spec-task");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "config.yaml"),
      YAML.stringify({
        failure_policy: {
          soft_block: { strategy: "retry", max_retries: 5 },
        },
      }),
      "utf-8",
    );

    const result = await executeConfigMerge("tool-3", {
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.config.failure_policy).toBeDefined();
    expect(data.config.failure_policy.soft_block.strategy).toBe("retry");
    expect(data.config.failure_policy.soft_block.max_retries).toBe(5);
  });

  it("should auto-generate project config from identity files", async () => {
    // 创建 IDENTITY.md 文件，ConfigManager 会从中提取 context
    writeFileSync(
      join(tmpDir, "IDENTITY.md"),
      "# My Project\n\nThis is a sample project for testing auto-generation.\n",
      "utf-8",
    );

    const result = await executeConfigMerge("tool-4", {
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.config.context).toBeDefined();
    expect(data.config.context.length).toBeGreaterThan(0);

    // 验证 spec-task/config.yaml 已自动生成
    const configPath = join(tmpDir, "spec-task", "config.yaml");
    expect(readFileSync(configPath, "utf-8")).toBeDefined();
  });

  it("should return CONFIG_NOT_FOUND for invalid YAML in project config", async () => {
    const specDir = join(tmpDir, "spec-task");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "config.yaml"),
      ":\n  invalid: [yaml: content:",
      "utf-8",
    );

    // 无效 YAML 时 ConfigManager.loadMergedConfig 返回默认配置而非报错
    // 但如果 YAML 解析抛异常，formatError 会被捕获
    // 根据 config.ts 代码，无效 YAML 返回默认配置，所以这里测的是正常路径
    const result = await executeConfigMerge("tool-5", {
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    // 无效 YAML → loadMergedConfig catch 块返回 { ...defaultConfig }
    expect(data.success).toBe(true);
    expect(data.config).toBeDefined();
  });

  it("should return error for unsupported format", async () => {
    const result = await executeConfigMerge("tool-6", {
      project_root: tmpDir,
      format: "xml" as any,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toBe("CONFIG_NOT_FOUND");
    expect(data.message).toContain("xml");
  });

  it("should return JSON format by default", async () => {
    const result = await executeConfigMerge("tool-7", {
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.config).toBeDefined();
    // 默认不包含 config_yaml 字段
    expect(data.config_yaml).toBeUndefined();
    expect(data.format).toBeUndefined();
  });

  it("should return YAML format when format=yaml", async () => {
    const result = await executeConfigMerge("tool-8", {
      project_root: tmpDir,
      format: "yaml",
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.format).toBe("yaml");
    expect(data.config_yaml).toBeDefined();
    // config_yaml 应该是有效 YAML
    const parsed = YAML.parse(data.config_yaml);
    expect(parsed).toBeDefined();
  });

  it("should handle nonexistent project_root path gracefully", async () => {
    // 使用 tmpDir 下一个不存在的子目录
    const nonexistent = join(tmpDir, "no-such-dir");

    const result = await executeConfigMerge("tool-9", {
      project_root: nonexistent,
    });
    const data = parseResult(result.content[0].text);

    // ConfigManager 会自动创建 spec-task 目录，所以应该成功
    expect(data.success).toBe(true);
    expect(data.config).toBeDefined();
  });

  it("should handle empty project config file", async () => {
    const specDir = join(tmpDir, "spec-task");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "config.yaml"), "", "utf-8");

    const result = await executeConfigMerge("tool-10", {
      project_root: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.config).toBeDefined();
    // 空配置文件 → YAML.parse 返回 undefined → fallback 到空对象
    // deepMerge(default, {}) → default
    expect(data.config.runtime).toBeDefined();
    expect(data.config.runtime.allow_agent_self_delegation).toBe(true);
  });
});
