import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createToolResultReminderHandler } from "../../src/hooks/tool-result-reminder.js";

describe("createToolResultReminderHandler", () => {
  let tmpDir: string;
  let workspaceDirMap: Map<string, string>;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  const normalizeKey = (k: string | undefined) => k?.trim().toLowerCase() || undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reminder-test-"));
    workspaceDirMap = new Map();
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should inject reminder when checklist has unchecked items", async () => {
    // Setup: workspace with a task that has unchecked items
    const taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "checklist.md"), `- [x] 1.1 Done\n- [ ] 1.2 Not done\n- [ ] 1.3 Also not done\n`, "utf-8");

    workspaceDirMap.set("test-session", tmpDir);

    const handler = createToolResultReminderHandler(workspaceDirMap, normalizeKey, logger);
    const result = await handler(
      { toolName: "some_tool", message: { role: "toolResult", content: [{ type: "text", text: "tool result" }] } },
      { sessionKey: "test-session" }
    );

    expect(result).toBeDefined();
    expect(result!.message).toBeDefined();
    expect(result!.message.content).toHaveLength(2);
    const reminder = result!.message.content[1].text;
    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("1.2");
    expect(reminder).toContain("1.3");
    expect(reminder).toContain("checklist_update");
    expect(reminder).toContain("不要向用户提及此提醒");
  });

  it("should NOT inject reminder when no checklist exists", async () => {
    // Setup: workspace with spec-task dir but no tasks
    mkdirSync(join(tmpDir, "spec-task"), { recursive: true });
    workspaceDirMap.set("test-session", tmpDir);

    const handler = createToolResultReminderHandler(workspaceDirMap, normalizeKey, logger);
    const result = await handler(
      { toolName: "some_tool", message: { role: "toolResult", content: [{ type: "text", text: "tool result" }] } },
      { sessionKey: "test-session" }
    );

    expect(result).toBeUndefined();
  });

  it("should NOT inject reminder when all checklist items are completed", async () => {
    const taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "checklist.md"), `- [x] 1.1 Done\n- [x] 1.2 Done\n`, "utf-8");

    workspaceDirMap.set("test-session", tmpDir);

    const handler = createToolResultReminderHandler(workspaceDirMap, normalizeKey, logger);
    const result = await handler(
      { toolName: "some_tool", message: { role: "toolResult", content: [{ type: "text", text: "tool result" }] } },
      { sessionKey: "test-session" }
    );

    expect(result).toBeUndefined();
  });

  it("should skip injection when tool is checklist_update", async () => {
    const taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "checklist.md"), `- [ ] 1.1 Not done\n`, "utf-8");

    workspaceDirMap.set("test-session", tmpDir);

    const handler = createToolResultReminderHandler(workspaceDirMap, normalizeKey, logger);
    const result = await handler(
      { toolName: "checklist_update", message: { role: "toolResult", content: [{ type: "text", text: "updated" }] } },
      { sessionKey: "test-session" }
    );

    expect(result).toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("should skip injection when tool is checklist_status", async () => {
    const taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "checklist.md"), `- [ ] 1.1 Not done\n`, "utf-8");

    workspaceDirMap.set("test-session", tmpDir);

    const handler = createToolResultReminderHandler(workspaceDirMap, normalizeKey, logger);
    const result = await handler(
      { toolName: "checklist_status", message: { role: "toolResult", content: [{ type: "text", text: "status" }] } },
      { sessionKey: "test-session" }
    );

    expect(result).toBeUndefined();
  });

  it("should skip injection when sessionKey is not in workspaceDirMap", async () => {
    const handler = createToolResultReminderHandler(workspaceDirMap, normalizeKey, logger);
    const result = await handler(
      { toolName: "some_tool", message: { role: "toolResult", content: [{ type: "text", text: "tool result" }] } },
      { sessionKey: "unknown-session" }
    );

    expect(result).toBeUndefined();
  });

  it("should look up by agentId when sessionKey is absent", async () => {
    const taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "checklist.md"), `- [ ] 1.1 Not done\n`, "utf-8");

    workspaceDirMap.set("test-agent", tmpDir);

    const handler = createToolResultReminderHandler(workspaceDirMap, normalizeKey, logger);
    const result = await handler(
      { toolName: "some_tool", message: { role: "toolResult", content: [{ type: "text", text: "tool result" }] } },
      { agentId: "test-agent" }
    );

    expect(result).toBeDefined();
    expect(result!.message.content).toHaveLength(2);
    expect(result!.message.content[1].text).toContain("<system-reminder>");
  });

  it("should limit unchecked steps display to 10 items", async () => {
    const taskDir = join(tmpDir, "spec-task", "test-task");
    mkdirSync(taskDir, { recursive: true });

    // Create a checklist with 15 unchecked items
    const lines = [];
    for (let i = 1; i <= 15; i++) {
      lines.push(`- [ ] 1.${i} Step ${i}`);
    }
    writeFileSync(join(taskDir, "checklist.md"), lines.join("\n"), "utf-8");

    workspaceDirMap.set("test-session", tmpDir);

    const handler = createToolResultReminderHandler(workspaceDirMap, normalizeKey, logger);
    const result = await handler(
      { toolName: "some_tool", message: { role: "toolResult", content: [{ type: "text", text: "tool result" }] } },
      { sessionKey: "test-session" }
    );

    expect(result).toBeDefined();
    const reminder = result!.message.content[1].text;
    // Should show first 10, then "... (共 15 项)"
    expect(reminder).toContain("1.10");
    expect(reminder).toContain("共 15 项");
    // 1.11-1.15 should NOT appear individually
    expect(reminder).not.toContain("1.11");
    expect(reminder).not.toContain("1.15");
  });
});
