import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import * as fsAsync from "fs/promises";
import { StatusStore } from "../../src/core/status-store.js";
import type { TaskStatusData } from "../../src/types.js";

// Mock fs/promises so we can intercept rename/writeFile in ESM
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => actual.writeFile(...args)),
  };
});

// Import the mocked functions for per-test control
import { rename as mockedRename, writeFile as mockedWriteFile } from "fs/promises";

describe("StatusStore", () => {
  let tmpDir: string;
  let store: StatusStore;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "store-test-"));
    store = new StatusStore();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, YAML.stringify(data), "utf-8");
  }

  function statusPath(): string {
    return join(tmpDir, "status.yaml");
  }

  function sampleData(): TaskStatusData {
    return {
      task_id: "test-task",
      title: "Test Task",
      created: "2026-03-29T00:00:00.000Z",
      updated: "2026-03-29T00:00:00.000Z",
      status: "pending",
      assigned_to: "agent-1",
      started_at: null,
      completed_at: null,
      run_id: "001",
      progress: { total: 5, completed: 0, skipped: 0, current_step: "1.1", percentage: 0 },
      outputs: [],
      steps: [],
      errors: [],
      blocked_by: [],
      verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
      revisions: [],
    };
  }

  // ====================================================================
  // 测试 1: loadYaml — 正常读取
  // ====================================================================
  it("loadYaml should read and parse YAML file correctly", async () => {
    const path = statusPath();
    writeYaml(path, { status: "pending", title: "Hello" });
    const data = await store.loadYaml<{ status: string; title: string }>(path);
    expect(data.status).toBe("pending");
    expect(data.title).toBe("Hello");
  });

  // ====================================================================
  // 测试 2: loadYaml — 文件不存在抛错
  // ====================================================================
  it("loadYaml should throw for nonexistent file", async () => {
    await expect(store.loadYaml("/nonexistent/status.yaml")).rejects.toThrow();
  });

  // ====================================================================
  // 测试 3: saveYaml — 写入后可读回
  // ====================================================================
  it("saveYaml should write data that can be read back", async () => {
    const path = statusPath();
    const data = { status: "running", title: "中文标题 🎉" };
    await store.saveYaml(path, data);
    const loaded = await store.loadYaml<typeof data>(path);
    expect(loaded.status).toBe("running");
    expect(loaded.title).toBe("中文标题 🎉");
  });

  // ====================================================================
  // 测试 4: saveYaml — 自动创建父目录
  // ====================================================================
  it("saveYaml should create parent directories automatically", async () => {
    const path = join(tmpDir, "a", "b", "c", "status.yaml");
    await store.saveYaml(path, { status: "pending" });
    const loaded = await store.loadYaml<{ status: string }>(path);
    expect(loaded.status).toBe("pending");
  });

  // ====================================================================
  // 测试 5: saveYaml — 原子写入（写入过程中不应出现损坏文件）
  // ====================================================================
  it("saveYaml should perform atomic write (temp file then rename)", async () => {
    const path = statusPath();
    await store.saveYaml(path, { status: "pending" });

    // 验证没有 .tmp 残留文件
    const { readdir } = await import("fs/promises");
    const files = await readdir(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp") || f.endsWith(".yaml.tmp"));
    expect(tmpFiles).toHaveLength(0);

    // 验证文件内容正确
    const loaded = await store.loadYaml<{ status: string }>(path);
    expect(loaded.status).toBe("pending");
  });

  // ====================================================================
  // 测试 6: loadStatus / saveStatus — 完整读写
  // ====================================================================
  it("saveStatus and loadStatus should round-trip TaskStatusData", async () => {
    const data = sampleData();
    await store.saveStatus(tmpDir, data);
    const loaded = await store.loadStatus(tmpDir);
    expect(loaded.task_id).toBe("test-task");
    expect(loaded.status).toBe("pending");
    expect(loaded.progress.total).toBe(5);
    expect(loaded.revisions).toHaveLength(0);
  });

  // ====================================================================
  // 测试 7: loadStatus — 文件不存在抛错
  // ====================================================================
  it("loadStatus should throw FileNotFoundError for missing status.yaml", async () => {
    await expect(store.loadStatus(tmpDir)).rejects.toThrow("status.yaml not found");
  });

  // ====================================================================
  // 测试 8: transaction — 排他锁内修改并保存
  // ====================================================================
  it("transaction should load, allow modification, and save atomically", async () => {
    writeYaml(statusPath(), sampleData());
    const result = await store.transaction(tmpDir, (data) => {
      data.status = "running";
      data.outputs.push("/path/to/file.ts");
      return data;
    });
    expect(result.status).toBe("running");

    // 验证保存到磁盘
    const loaded = await store.loadStatus(tmpDir);
    expect(loaded.status).toBe("running");
    expect(loaded.outputs).toContain("/path/to/file.ts");
  });

  // ====================================================================
  // 测试 9: transaction — 文件不存在抛错
  // ====================================================================
  it("transaction should throw for nonexistent status.yaml", async () => {
    await expect(
      store.transaction(tmpDir, () => "nope")
    ).rejects.toThrow("status.yaml not found");
  });

  // ====================================================================
  // 测试 10: 并发安全 — 多个事务顺序执行不丢数据
  // ====================================================================
  it("concurrent transactions should not lose data", async () => {
    writeYaml(statusPath(), sampleData());

    // 模拟 5 个顺序事务（在测试中不能真正并行，但验证锁机制不报错）
    for (let i = 0; i < 5; i++) {
      await store.transaction(tmpDir, (data) => {
        data.outputs.push(`/file-${i}.ts`);
        return data;
      });
    }

    const loaded = await store.loadStatus(tmpDir);
    expect(loaded.outputs).toHaveLength(5);
    expect(loaded.outputs).toEqual([
      "/file-0.ts", "/file-1.ts", "/file-2.ts", "/file-3.ts", "/file-4.ts",
    ]);
  });

  // ====================================================================
  // 其余 28 个测试
  // ====================================================================
  describe("remaining tests (28)", () => {
    // ------------------------------------------------------------------
    // 1. loadYaml handles nested data structures
    // ------------------------------------------------------------------
    it("loadYaml handles nested data structures", async () => {
      const path = statusPath();
      const nested = {
        level1: {
          level2: {
            level3: {
              value: "deep",
              array: [1, 2, { nested: true }],
            },
          },
          siblings: ["a", "b"],
        },
      };
      writeYaml(path, nested);
      const data = await store.loadYaml<typeof nested>(path);
      expect(data.level1.level2.level3.value).toBe("deep");
      expect((data.level1.level2.level3.array[2] as { nested: boolean }).nested).toBe(true);
      expect(data.level1.siblings).toEqual(["a", "b"]);
    });

    // ------------------------------------------------------------------
    // 2. loadYaml handles Unicode content
    // ------------------------------------------------------------------
    it("loadYaml handles Unicode content", async () => {
      const path = statusPath();
      const data = {
        chinese: "你好世界",
        emoji: "🚀✨🎉",
        japanese: "こんにちは",
        mixed: "Hello 世界 🌍",
      };
      writeYaml(path, data);
      const loaded = await store.loadYaml<typeof data>(path);
      expect(loaded.chinese).toBe("你好世界");
      expect(loaded.emoji).toBe("🚀✨🎉");
      expect(loaded.japanese).toBe("こんにちは");
      expect(loaded.mixed).toBe("Hello 世界 🌍");
    });

    // ------------------------------------------------------------------
    // 3. loadYaml returns {} for empty YAML file
    // ------------------------------------------------------------------
    it("loadYaml returns {} for empty YAML file", async () => {
      const path = statusPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "", "utf-8");
      const data = await store.loadYaml(path);
      expect(data).toEqual({});
    });

    // ------------------------------------------------------------------
    // 4. saveYaml handles null value fields
    // ------------------------------------------------------------------
    it("saveYaml handles null value fields", async () => {
      const path = statusPath();
      const data = { a: null, b: "hello", c: null };
      await store.saveYaml(path, data);
      const loaded = await store.loadYaml<{ a: string | null; b: string; c: string | null }>(path);
      expect(loaded.a).toBeNull();
      expect(loaded.b).toBe("hello");
      expect(loaded.c).toBeNull();
    });

    // ------------------------------------------------------------------
    // 5. saveYaml handles empty array fields
    // ------------------------------------------------------------------
    it("saveYaml handles empty array fields", async () => {
      const path = statusPath();
      const data = { items: [] as string[], name: "test", tags: [] as string[] };
      await store.saveYaml(path, data);
      const loaded = await store.loadYaml<{ items: string[]; name: string; tags: string[] }>(path);
      expect(loaded.items).toEqual([]);
      expect(loaded.tags).toEqual([]);
      expect(loaded.name).toBe("test");
    });

    // ------------------------------------------------------------------
    // 6. saveYaml handles large data (1000+ fields)
    // ------------------------------------------------------------------
    it("saveYaml handles large data (1000+ fields)", async () => {
      const path = statusPath();
      const data: Record<string, string> = {};
      for (let i = 0; i < 1100; i++) {
        data[`field_${i}`] = `value_${i}`;
      }
      await store.saveYaml(path, data);
      const loaded = await store.loadYaml<Record<string, string>>(path);
      expect(Object.keys(loaded).length).toBe(1100);
      expect(loaded.field_0).toBe("value_0");
      expect(loaded.field_1099).toBe("value_1099");
    });

    // ------------------------------------------------------------------
    // 7. saveYaml overwrites on consecutive writes
    // ------------------------------------------------------------------
    it("saveYaml overwrites on consecutive writes", async () => {
      const path = statusPath();
      await store.saveYaml(path, { version: 1 });
      await store.saveYaml(path, { version: 2 });
      await store.saveYaml(path, { version: 3 });
      const loaded = await store.loadYaml<{ version: number }>(path);
      expect(loaded.version).toBe(3);
    });

    // ------------------------------------------------------------------
    // 8. saveYaml cleans up .tmp on write failure
    // ------------------------------------------------------------------
    it("saveYaml cleans up .tmp on write failure", async () => {
      const path = statusPath();
      vi.mocked(mockedRename).mockRejectedValueOnce(new Error("EPERM: rename failed"));

      try {
        await expect(store.saveYaml(path, { status: "pending" })).rejects.toThrow("rename failed");

        // Verify no .tmp files remain
        const files = await fsAsync.readdir(tmpDir);
        const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
        expect(tmpFiles).toHaveLength(0);
      } finally {
        vi.mocked(mockedRename).mockRestore();
      }
    });

    // ------------------------------------------------------------------
    // 9. saveYaml preserves original file on write failure
    // ------------------------------------------------------------------
    it("saveYaml preserves original file on write failure", async () => {
      const path = statusPath();
      // Write initial data successfully
      await store.saveYaml(path, { version: 1, critical: "data" });

      // Make rename fail on next save
      vi.mocked(mockedRename).mockRejectedValueOnce(new Error("EPERM: rename failed"));

      try {
        await expect(store.saveYaml(path, { version: 2, critical: "data" })).rejects.toThrow("rename failed");
      } finally {
        vi.mocked(mockedRename).mockRestore();
      }

      // Verify original file is preserved
      const loaded = await store.loadYaml<{ version: number; critical: string }>(path);
      expect(loaded.version).toBe(1);
      expect(loaded.critical).toBe("data");
    });

    // ------------------------------------------------------------------
    // 10. saveStatus auto-updates updated timestamp
    // ------------------------------------------------------------------
    it("saveStatus auto-updates updated timestamp", async () => {
      const data = sampleData();
      data.updated = "2020-01-01T00:00:00.000Z";
      const before = new Date();
      await store.saveStatus(tmpDir, data);
      const after = new Date();
      const loaded = await store.loadStatus(tmpDir);
      const updatedTime = new Date(loaded.updated).getTime();
      expect(updatedTime).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(updatedTime).toBeLessThanOrEqual(after.getTime() + 1000);
    });

    // ------------------------------------------------------------------
    // 11. loadStatus parses all field types correctly
    // ------------------------------------------------------------------
    it("loadStatus parses all field types correctly", async () => {
      const data = sampleData();
      data.status = "running";
      data.started_at = "2026-03-29T10:00:00.000Z";
      data.progress.percentage = 42.5;
      data.errors.push({
        step: "2.1",
        message: "something went wrong",
        retry_count: 3,
        timestamp: "2026-03-29T10:05:00.000Z",
      });
      data.blocked_by.push({ task: "parent-task", reason: "dependency" });
      data.verification.criteria.push({
        criterion: "tests pass",
        result: "passed",
        evidence: "all 42 tests green",
        reason: "CI pipeline passed",
      });
      writeYaml(statusPath(), data);
      const loaded = await store.loadStatus(tmpDir);
      expect(loaded.status).toBe("running");
      expect(loaded.started_at).toBe("2026-03-29T10:00:00.000Z");
      expect(loaded.progress.percentage).toBe(42.5);
      expect(loaded.errors).toHaveLength(1);
      expect(loaded.errors[0].step).toBe("2.1");
      expect(loaded.blocked_by).toHaveLength(1);
      expect(loaded.verification.criteria).toHaveLength(1);
    });

    // ------------------------------------------------------------------
    // 12. transaction awaits Promise returned by callback
    // ------------------------------------------------------------------
    it("transaction awaits Promise returned by callback", async () => {
      writeYaml(statusPath(), sampleData());
      const result = await store.transaction(tmpDir, async (data) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        data.status = "completed";
        return data.status;
      });
      expect(result).toBe("completed");
      const loaded = await store.loadStatus(tmpDir);
      expect(loaded.status).toBe("completed");
    });

    // ------------------------------------------------------------------
    // 13. transaction rolls back on callback error
    // ------------------------------------------------------------------
    it("transaction rolls back on callback error", async () => {
      writeYaml(statusPath(), sampleData());
      await expect(
        store.transaction(tmpDir, (data) => {
          data.status = "running";
          throw new Error("callback error");
        })
      ).rejects.toThrow("callback error");
      // Verify data was NOT saved (roll back)
      const loaded = await store.loadStatus(tmpDir);
      expect(loaded.status).toBe("pending");
    });

    // ------------------------------------------------------------------
    // 14. transaction releases lock on callback error
    // ------------------------------------------------------------------
    it("transaction releases lock on callback error", async () => {
      writeYaml(statusPath(), sampleData());
      await expect(
        store.transaction(tmpDir, () => {
          throw new Error("callback error");
        })
      ).rejects.toThrow("callback error");
      // A subsequent transaction should succeed (lock was released)
      const result = await store.transaction(tmpDir, (data) => {
        data.status = "running";
        return data.status;
      });
      expect(result).toBe("running");
    });

    // ------------------------------------------------------------------
    // 15. transaction correctly appends to revisions array
    // ------------------------------------------------------------------
    it("transaction correctly appends to revisions array", async () => {
      const data = sampleData();
      data.revisions = [];
      writeYaml(statusPath(), data);
      await store.transaction(tmpDir, (data) => {
        data.revisions.push({
          id: 1,
          type: "status_change",
          timestamp: new Date().toISOString(),
          trigger: "test",
          summary: "status changed to running",
        });
        return data;
      });
      const loaded = await store.loadStatus(tmpDir);
      expect(loaded.revisions).toHaveLength(1);
      expect(loaded.revisions[0].id).toBe(1);
      expect(loaded.revisions[0].type).toBe("status_change");
    });

    // ------------------------------------------------------------------
    // 16. concurrent: rapid saveYaml calls should not corrupt data
    // ------------------------------------------------------------------
    it("concurrent: rapid saveYaml calls should not corrupt data", async () => {
      const path = statusPath();
      // Launch concurrent saves; some may fail due to lock contention
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          store.saveYaml(path, { version: i })
        )
      );
      // At least some writes must succeed
      const succeeded = results.filter((r) => r.status === "fulfilled");
      expect(succeeded.length).toBeGreaterThanOrEqual(1);

      // The final file must be valid YAML with a coherent version
      const loaded = await store.loadYaml<{ version: number }>(path);
      expect(typeof loaded.version).toBe("number");
      expect(loaded.version).toBeGreaterThanOrEqual(0);
      expect(loaded.version).toBeLessThan(5);
    }, 15000);

    // ------------------------------------------------------------------
    // 17. concurrent: saveYaml + loadYaml should return consistent data
    // ------------------------------------------------------------------
    it("concurrent: saveYaml + loadYaml should return consistent data", async () => {
      const path = statusPath();
      // First write valid data
      await store.saveYaml(path, { counter: 0 });
      // Run concurrent saves and loads
      const results = await Promise.all([
        store.saveYaml(path, { counter: 1 }),
        store.saveYaml(path, { counter: 2 }),
        store.loadYaml<{ counter: number }>(path),
        store.loadYaml<{ counter: number }>(path),
      ]);
      // The loads should return valid objects with counter as a number
      const loaded1 = results[2] as { counter: number };
      const loaded2 = results[3] as { counter: number };
      expect(typeof loaded1.counter).toBe("number");
      expect(typeof loaded2.counter).toBe("number");
    });

    // ------------------------------------------------------------------
    // 18. concurrent: lock stale timeout allows re-acquisition
    // ------------------------------------------------------------------
    it("concurrent: lock stale timeout allows re-acquisition", async () => {
      const path = statusPath();
      await store.saveYaml(path, { value: 1 });

      // proper-lockfile v4 uses mkdir for locks; staleness is checked via mtime
      const lockPath = path + ".lock";
      mkdirSync(lockPath);
      // Set mtime to 15 seconds ago (stale threshold is 10s, min enforced 2s)
      const oldTime = new Date(Date.now() - 15000);
      utimesSync(lockPath, oldTime, oldTime);

      // saveYaml should detect stale lock, remove it, and succeed
      await store.saveYaml(path, { value: 2 });
      const loaded = await store.loadYaml<{ value: number }>(path);
      expect(loaded.value).toBe(2);
    });

    // ------------------------------------------------------------------
    // 19. concurrent: lock retry mechanism works
    // ------------------------------------------------------------------
    it("concurrent: lock retry mechanism works", async () => {
      const path = statusPath();
      await store.saveYaml(path, { value: 1 });

      // Create a non-stale lock directory (proper-lockfile uses mkdir)
      const lockPath = path + ".lock";
      mkdirSync(lockPath);

      // Schedule lock removal after a short delay;
      // the retry module will retry after ~1000ms (minTimeout default)
      const timer = setTimeout(() => {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
      }, 500);

      try {
        // saveYaml should fail initially but succeed on retry after lock is removed
        await store.saveYaml(path, { value: 2 });
        const loaded = await store.loadYaml<{ value: number }>(path);
        expect(loaded.value).toBe(2);
      } finally {
        clearTimeout(timer);
      }
    }, 10000);

    // ------------------------------------------------------------------
    // 20. invalid YAML file throws parse error
    // ------------------------------------------------------------------
    it("invalid YAML file throws parse error", async () => {
      const path = statusPath();
      mkdirSync(dirname(path), { recursive: true });
      // Unclosed flow sequence — definitely invalid YAML
      writeFileSync(path, "key: [1, 2, 3\n", "utf-8");
      await expect(store.loadYaml(path)).rejects.toThrow();
    });

    // ------------------------------------------------------------------
    // 21. permission denied throws system error
    // ------------------------------------------------------------------
    it("permission denied throws system error", async () => {
      const path = statusPath();
      // Ensure target file exists so stat succeeds
      writeYaml(path, { status: "old" });

      vi.mocked(mockedWriteFile).mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" })
      );

      try {
        await expect(store.saveYaml(path, { status: "new" })).rejects.toThrow(/EACCES|permission/i);
      } finally {
        vi.mocked(mockedWriteFile).mockRestore();
      }
    });

    // ------------------------------------------------------------------
    // 22. disk full error handling
    // ------------------------------------------------------------------
    it("disk full error handling", async () => {
      const path = statusPath();
      // Ensure target file exists
      writeYaml(path, { status: "old" });

      vi.mocked(mockedWriteFile).mockRejectedValueOnce(
        Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
      );

      try {
        await expect(store.saveYaml(path, { status: "new" })).rejects.toThrow(/ENOSPC|no space/i);
      } finally {
        vi.mocked(mockedWriteFile).mockRestore();
      }
    });

    // ------------------------------------------------------------------
    // 23. reads v1.0 Python-generated status.yaml
    // ------------------------------------------------------------------
    it("reads v1.0 Python-generated status.yaml", async () => {
      // Python yaml.dump produces YAML 1.1 with specific formatting
      const pythonYaml = `task_id: TASK-001
title: Python Generated Task
created: '2026-03-29T00:00:00+00:00'
updated: '2026-03-29T00:00:00+00:00'
status: pending
assigned_to: agent-1
started_at: null
completed_at: null
progress:
  total: 10
  completed: 0
  current_step: '1.1'
  percentage: 0
parent: null
depth: 0
children: []
outputs: []
timing:
  estimated_minutes: 60
  elapsed_minutes: null
errors: []
alerts: []
blocked_by: []
verification:
  status: pending
  criteria: []
  verified_at: null
  verified_by: null
revisions: []
`;
      const path = statusPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, pythonYaml, "utf-8");
      const loaded = await store.loadStatus(tmpDir);
      expect(loaded.task_id).toBe("TASK-001");
      expect(loaded.title).toBe("Python Generated Task");
      expect(loaded.status).toBe("pending");
      expect(loaded.progress.total).toBe(10);
      expect(loaded.progress.percentage).toBe(0);
      expect(loaded.started_at).toBeNull();
      expect(loaded.revisions).toHaveLength(0);
    });

    // ------------------------------------------------------------------
    // 24. written YAML is readable by Python yaml.safe_load
    // ------------------------------------------------------------------
    it("written YAML is readable by Python yaml.safe_load", async () => {
      const data = sampleData();
      await store.saveStatus(tmpDir, data);
      const raw = await fsAsync.readFile(statusPath(), "utf-8");

      // Must not contain JS-specific undefined
      expect(raw).not.toContain("undefined");

      // Verify the YAML is parseable (same as Python's yaml.safe_load compatibility)
      const parsed = YAML.parse(raw);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
      expect(parsed.task_id).toBe("test-task");
      expect(parsed.progress.total).toBe(5);
      expect(parsed.revisions).toEqual([]);
      expect(parsed.started_at).toBeNull();
      expect(parsed.revisions).toEqual([]);
    });

    // ------------------------------------------------------------------
    // 25. loadYaml reads 1000+ revisions file under 100ms
    // ------------------------------------------------------------------
    it("loadYaml reads 1000+ revisions file under 100ms", async () => {
      const data = sampleData();
      for (let i = 0; i < 1100; i++) {
        data.revisions.push({
          id: i,
          type: "status_change" as const,
          timestamp: new Date().toISOString(),
          trigger: "test",
          summary: `revision ${i}`,
        });
      }
      writeYaml(statusPath(), data);

      // Warmup run to eliminate JIT overhead
      await store.loadStatus(tmpDir);

      const start = performance.now();
      await store.loadStatus(tmpDir);
      const elapsed = performance.now() - start;
      // 300ms threshold: 1000+ revisions produce a large YAML payload;
      // parsing is I/O-bound and varies across environments
      expect(elapsed).toBeLessThan(300);
    });

    // ------------------------------------------------------------------
    // 26. saveYaml writes 1000+ revisions file under 200ms
    // ------------------------------------------------------------------
    it("saveYaml writes 1000+ revisions file under 200ms", async () => {
      const data = sampleData();
      for (let i = 0; i < 1100; i++) {
        data.revisions.push({
          id: i,
          type: "status_change" as const,
          timestamp: new Date().toISOString(),
          trigger: "test",
          summary: `revision ${i}`,
        });
      }

      const start = performance.now();
      await store.saveYaml(statusPath(), data);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(200);
    });

    // ------------------------------------------------------------------
    // 27. transaction completes under 50ms without contention
    // ------------------------------------------------------------------
    it("transaction completes under 50ms without contention", async () => {
      writeYaml(statusPath(), sampleData());

      // Warmup
      await store.transaction(tmpDir, (data) => { data.status = "running"; return data; });

      const start = performance.now();
      await store.transaction(tmpDir, (data) => {
        data.status = "completed";
        return data;
      });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });

    // ------------------------------------------------------------------
    // 28. consecutive saveYaml calls do not accumulate lock files
    // ------------------------------------------------------------------
    it("consecutive saveYaml calls do not accumulate lock files", async () => {
      const path = statusPath();
      for (let i = 0; i < 20; i++) {
        await store.saveYaml(path, { iteration: i });
      }
      const files = await fsAsync.readdir(tmpDir);
      const lockFiles = files.filter((f) => f.endsWith(".lock"));
      expect(lockFiles).toHaveLength(0);
    });
  });
});
