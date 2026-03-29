import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FileUtils } from "../src/file-utils.js";

describe("FileUtils", () => {
  let tmpDir: string;
  let fu: FileUtils;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spec-task-test-"));
    fu = new FileUtils();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("ensureDir", () => {
    it("should create a directory that does not exist", async () => {
      const dir = join(tmpDir, "a", "b", "c");
      await fu.ensureDir(dir);
      const { stat } = await import("fs/promises");
      const s = await stat(dir);
      expect(s.isDirectory()).toBe(true);
    });

    it("should not throw if directory already exists", async () => {
      const dir = join(tmpDir, "existing");
      const { mkdir } = await import("fs/promises");
      await mkdir(dir);
      await expect(fu.ensureDir(dir)).resolves.not.toThrow();
    });
  });

  describe("safeReadFile", () => {
    it("should return file content when file exists", async () => {
      const filePath = join(tmpDir, "test.txt");
      const { writeFile } = await import("fs/promises");
      await writeFile(filePath, "hello world", "utf-8");
      const content = await fu.safeReadFile(filePath);
      expect(content).toBe("hello world");
    });

    it("should return null when file does not exist", async () => {
      const content = await fu.safeReadFile(join(tmpDir, "nonexistent.txt"));
      expect(content).toBeNull();
    });
  });

  describe("safeStat", () => {
    it("should return Stats when file exists", async () => {
      const filePath = join(tmpDir, "exists.txt");
      const { writeFile } = await import("fs/promises");
      await writeFile(filePath, "data", "utf-8");
      const s = await fu.safeStat(filePath);
      expect(s).not.toBeNull();
      expect(s!.isFile()).toBe(true);
    });

    it("should return null when file does not exist", async () => {
      const s = await fu.safeStat(join(tmpDir, "ghost.txt"));
      expect(s).toBeNull();
    });
  });

  describe("resolveTaskDir", () => {
    it("should return correct task directory path", () => {
      const result = fu.resolveTaskDir("my-task", "/project");
      expect(result).toBe("/project/spec-task/my-task");
    });

    it("should handle trailing slashes in project root", () => {
      const result = fu.resolveTaskDir("my-task", "/project/");
      expect(result).toBe("/project/spec-task/my-task");
    });
  });
});
