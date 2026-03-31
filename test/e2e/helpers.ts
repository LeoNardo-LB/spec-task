import { mkdir, rm, readFile, writeFile, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import type { TaskStatusData, TaskStatus, RevisionType } from "../../src/types.js";

// Re-export expect for type-safe assertions in test helpers
import { expect } from "vitest";

export interface TestEnv {
  projectRoot: string;
  agentWorkspace: string;
  specTaskDir: string;
  cleanup: () => Promise<void>;
}

/** 创建隔离的 E2E 测试环境（临时目录 + spec-task/ + agent-workspace/memory/） */
export async function createTestEnv(): Promise<TestEnv> {
  const dir = join(tmpdir(), `spec-task-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const specTaskDir = join(dir, "spec-task");
  const memoryDir = join(dir, "agent-workspace", "memory");
  await mkdir(specTaskDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(specTaskDir, "config.yaml"), YAML.stringify({
    context: "e2e-test",
    runtime: { allow_agent_self_delegation: true, task_timeout: 60 },
    archive: { record_history: true, generate_lessons: true },
  }), "utf-8");
  return {
    projectRoot: dir, agentWorkspace: join(dir, "agent-workspace"), specTaskDir,
    cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

/** 读取任务 status.yaml */
export async function readStatus(taskDir: string): Promise<TaskStatusData> {
  const content = await readFile(join(taskDir, "status.yaml"), "utf-8");
  return YAML.parse(content) as TaskStatusData;
}

/** 写入文档或 checklist */
export async function writeFile_(
  taskDir: string, filename: string, content: string
): Promise<void> {
  await writeFile(join(taskDir, filename), content, "utf-8");
}

export const writeArtifact = writeFile_;
export const writeChecklist = writeFile_;

/** 在 status.yaml 上执行状态转换（模拟 task_transition） */
export async function transitionTask(
  taskDir: string, newStatus: TaskStatus,
  opts: { summary?: string; revisionType?: string; trigger?: string;
    assignedTo?: string; blockType?: "soft_block" | "hard_block"; blockReason?: string } = {}
): Promise<void> {
  const content = await readFile(join(taskDir, "status.yaml"), "utf-8");
  const data = YAML.parse(content) as TaskStatusData;
  const oldStatus = data.status;
  data.status = newStatus;
  data.updated = new Date().toISOString();
  if (newStatus === "running" && !data.started_at) data.started_at = data.updated;
  if (["completed", "cancelled"].includes(newStatus)) data.completed_at = data.updated;
  if (opts.assignedTo) data.assigned_to = opts.assignedTo;

  const revId = data.revisions.length > 0
    ? Math.max(...data.revisions.map((r: any) => r.id)) + 1 : 1;
  data.revisions.push({
    id: revId, type: (opts.revisionType ?? "status_change") as RevisionType,
    timestamp: data.updated, trigger: opts.trigger ?? "e2e-test",
    summary: opts.summary ?? `${oldStatus} → ${newStatus}`,
    block_type: opts.blockType ?? null, block_reason: opts.blockReason ?? null,
  });
  await writeFile(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
}

/** 添加错误记录（模拟 task_log error） */
export async function logError(taskDir: string, step: string, message: string): Promise<void> {
  const content = await readFile(join(taskDir, "status.yaml"), "utf-8");
  const data = YAML.parse(content) as TaskStatusData;
  data.errors.push({ step, message, retry_count: 0, timestamp: new Date().toISOString() });
  data.updated = new Date().toISOString();
  await writeFile(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
}

/** 添加/移除阻塞（模拟 task_log add-block/remove-block） */
export async function addBlock(taskDir: string, blockingTask: string, reason: string): Promise<void> {
  const content = await readFile(join(taskDir, "status.yaml"), "utf-8");
  const data = YAML.parse(content) as TaskStatusData;
  if (!data.blocked_by.some(b => b.task === blockingTask)) {
    data.blocked_by.push({ task: blockingTask, reason });
    data.updated = new Date().toISOString();
    await writeFile(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
  }
}

export async function removeBlock(taskDir: string, blockingTask: string): Promise<void> {
  const content = await readFile(join(taskDir, "status.yaml"), "utf-8");
  const data = YAML.parse(content) as TaskStatusData;
  data.blocked_by = data.blocked_by.filter(b => b.task !== blockingTask);
  data.updated = new Date().toISOString();
  await writeFile(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
}

/** 添加验收标准 / 执行 finalize（模拟 task_verify） */
export async function addCriterion(
  taskDir: string, criterion: string, result: "passed" | "failed", evidence = ""
): Promise<void> {
  const content = await readFile(join(taskDir, "status.yaml"), "utf-8");
  const data = YAML.parse(content) as TaskStatusData;
  data.verification.criteria.push({ criterion, result, evidence, reason: "" });
  data.updated = new Date().toISOString();
  await writeFile(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
}

export async function finalizeVerification(
  taskDir: string, verifiedBy = "e2e-test"
): Promise<{ autoCompleted: boolean }> {
  const content = await readFile(join(taskDir, "status.yaml"), "utf-8");
  const data = YAML.parse(content) as TaskStatusData;
  const allPassed = data.verification.criteria.length > 0
    && data.verification.criteria.every(c => c.result === "passed");
  data.verification.status = allPassed ? "passed" : "failed";
  data.verification.verified_at = new Date().toISOString();
  data.verification.verified_by = verifiedBy;
  let autoCompleted = false;
  if (allPassed && data.status === "running") {
    data.status = "completed"; data.completed_at = data.updated; autoCompleted = true;
    const revId = data.revisions.length > 0
      ? Math.max(...data.revisions.map((r: any) => r.id)) + 1 : 1;
    data.revisions.push({
      id: revId, type: "status_change", timestamp: data.updated, trigger: "task_verify",
      summary: "Auto-completed: all verification criteria passed",
      block_type: null, block_reason: null,
    });
  }
  await writeFile(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
  return { autoCompleted };
}

/** 创建任务（模拟 task_create） */
export async function createTask(
  specTaskDir: string, taskName: string,
  opts: { title?: string; assignedTo?: string } = {}
): Promise<{ taskDir: string; taskId: string }> {
  const taskDir = join(specTaskDir, taskName);
  await mkdir(taskDir, { recursive: true });
  const now = new Date().toISOString();
  const statusData: TaskStatusData = {
    task_id: taskName, title: opts.title ?? taskName, created: now, updated: now,
    status: "pending", assigned_to: opts.assignedTo ?? "",
    started_at: null, completed_at: null,
    progress: { total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 },
    children: [], outputs: [], steps: [],
    timing: { elapsed_minutes: null },
    errors: [], alerts: [], blocked_by: [],
    verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
    revisions: [{
      id: 1, type: "created", timestamp: now, trigger: opts.assignedTo ?? "e2e-test",
      summary: "Task created", block_type: null, block_reason: null,
    }],
  };
  await writeFile(join(taskDir, "status.yaml"), YAML.stringify(statusData), "utf-8");
  return { taskDir, taskId: taskName };
}

export function expectStatus(data: TaskStatusData, status: TaskStatus): void {
  expect(data.status).toBe(status);
}
export function expectRevisionCount(data: TaskStatusData, count: number): void {
  expect(data.revisions).toHaveLength(count);
}
export async function expectFileExists(path: string): Promise<void> {
  expect((await stat(path)).isFile()).toBe(true);
}
