import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { executeTaskRecall, STOP_WORDS } from "../../src/tools/task-recall.js";

describe("executeTaskRecall", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T10:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "task-recall-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function parseResult(raw: string): any {
    return JSON.parse(raw);
  }

  it("should filter out stop words from keywords", async () => {
    // "the quick brown fox" → "the" 是停用词，应被过滤
    const historyDir = join(tmpDir, "memory", "task-history");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      join(historyDir, "quick-fox.md"),
      "The quick brown fox jumps over the lazy dog.\nQuick action was taken.",
      "utf-8",
    );

    const result = await executeTaskRecall("tool-1", {
      keywords: "the quick brown fox",
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.keywords).not.toContain("the");
    expect(data.keywords).toContain("quick");
    expect(data.keywords).toContain("brown");
    expect(data.keywords).toContain("fox");
  });

  it("should give higher weight to filename matches", async () => {
    const historyDir = join(tmpDir, "memory", "task-history");
    mkdirSync(historyDir, { recursive: true });

    // 文件名匹配 "authentication" → +3 权重
    writeFileSync(
      join(historyDir, "authentication-fix.md"),
      "Fixed a bug in the login system.\n",
      "utf-8",
    );

    // 文件名不匹配，但内容包含 "authentication"
    writeFileSync(
      join(historyDir, "general-notes.md"),
      "The authentication module needs improvement. The authentication flow is complex.\n",
      "utf-8",
    );

    const result = await executeTaskRecall("tool-2", {
      keywords: "authentication",
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results.length).toBe(2);
    // 文件名匹配的排第一
    expect(data.results[0].file).toContain("authentication-fix.md");
    expect(data.results[0].score).toBeGreaterThan(data.results[1].score);
  });

  it("should return empty results when no matches found", async () => {
    const historyDir = join(tmpDir, "memory", "task-history");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      join(historyDir, "unrelated.md"),
      "Some random content about gardening.\n",
      "utf-8",
    );

    const result = await executeTaskRecall("tool-3", {
      keywords: "quantum physics",
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.total_matches).toBe(0);
    expect(data.results).toEqual([]);
  });

  it("should sort results by score descending", async () => {
    const historyDir = join(tmpDir, "memory", "task-history");
    mkdirSync(historyDir, { recursive: true });

    writeFileSync(join(historyDir, "low.md"), "database\n", "utf-8");
    writeFileSync(join(historyDir, "medium.md"), "database database\n", "utf-8");
    writeFileSync(join(historyDir, "high.md"), "database database database\n", "utf-8");

    const result = await executeTaskRecall("tool-4", {
      keywords: "database",
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.results.length).toBe(3);
    expect(data.results[0].score).toBeGreaterThanOrEqual(data.results[1].score);
    expect(data.results[1].score).toBeGreaterThanOrEqual(data.results[2].score);
  });

  it("should respect top limit parameter", async () => {
    const historyDir = join(tmpDir, "memory", "task-history");
    mkdirSync(historyDir, { recursive: true });

    for (let i = 1; i <= 10; i++) {
      writeFileSync(join(historyDir, `task-${i}.md`), `Task about api endpoint ${i}\n`, "utf-8");
    }

    const result = await executeTaskRecall("tool-5", {
      keywords: "api",
      agent_workspace: tmpDir,
      top: 3,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results.length).toBe(3);
    expect(data.total_matches).toBe(10);
  });

  it("should handle special characters in keywords", async () => {
    const historyDir = join(tmpDir, "memory", "task-history");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      join(historyDir, "special.md"),
      "Handle C++ template errors and fix regex patterns.\n",
      "utf-8",
    );

    const result = await executeTaskRecall("tool-6", {
      keywords: "C++ regex",
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    expect(data.results[0].file).toContain("special.md");
  });

  it("should search in task-history directory", async () => {
    const historyDir = join(tmpDir, "memory", "task-history");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      join(historyDir, "deploy-task.md"),
      "Deploy the application to production server.\n",
      "utf-8",
    );

    const result = await executeTaskRecall("tool-7", {
      keywords: "deploy production",
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results.length).toBe(1);
    expect(data.results[0].file).toContain("deploy-task.md");
  });

  it("should search in task-lessons directory", async () => {
    const lessonsDir = join(tmpDir, "memory", "task-lessons");
    mkdirSync(lessonsDir, { recursive: true });
    writeFileSync(
      join(lessonsDir, "error-handling.md"),
      "Lesson learned: always validate input before processing.\n",
      "utf-8",
    );

    const result = await executeTaskRecall("tool-8", {
      keywords: "validate input",
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results.length).toBe(1);
    expect(data.results[0].file).toContain("error-handling.md");
  });

  it("should extract relevant snippet from matched content", async () => {
    const historyDir = join(tmpDir, "memory", "task-history");
    mkdirSync(historyDir, { recursive: true });
    const content = "Some preamble text that is not relevant.\n" +
      "The authentication module was refactored to use JWT tokens instead of sessions.\n" +
      "More trailing text here.\n";
    writeFileSync(join(historyDir, "auth-refactor.md"), content, "utf-8");

    const result = await executeTaskRecall("tool-9", {
      keywords: "authentication",
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results[0].snippet).toContain("authentication");
    expect(data.results[0].snippet.length).toBeLessThanOrEqual(250); // snippet has max length
  });

  it("should use agent_workspace parameter for search path", async () => {
    const customWorkspace = join(tmpDir, "custom-workspace");
    const historyDir = join(customWorkspace, "memory", "task-history");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      join(historyDir, "custom-task.md"),
      "Custom workspace task about caching.\n",
      "utf-8",
    );

    const result = await executeTaskRecall("tool-10", {
      keywords: "caching",
      agent_workspace: customWorkspace,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results.length).toBe(1);
    expect(data.results[0].file).toContain("custom-task.md");
  });

  it("should return empty results when workspace directories do not exist", async () => {
    const result = await executeTaskRecall("tool-11", {
      keywords: "anything",
      agent_workspace: join(tmpDir, "nonexistent"),
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.total_matches).toBe(0);
    expect(data.results).toEqual([]);
  });

  it("should be case-insensitive when searching", async () => {
    const historyDir = join(tmpDir, "memory", "task-history");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      join(historyDir, "case-test.md"),
      "DATABASE connection pooling was optimized.\n",
      "utf-8",
    );

    const result = await executeTaskRecall("tool-12", {
      keywords: "Database",
      agent_workspace: tmpDir,
    });
    const data = parseResult(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.results.length).toBe(1);
    expect(data.results[0].file).toContain("case-test.md");
  });
});
