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

/** 写入文档到指定目录 */
export async function writeFile_(
  dir: string, filename: string, content: string
): Promise<void> {
  await writeFile(join(dir, filename), content, "utf-8");
}

export const writeArtifact = writeFile_;

/** 在 status.yaml 上执行状态转换（模拟 task_transition） */
export async function transitionTask(
  taskDir: string, newStatus: TaskStatus,
  opts: { summary?: string; revisionType?: string; trigger?: string;
    assignedTo?: string } = {}
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
): Promise<{ autoCompleted: boolean; autoCompleteSkippedReason?: string }> {
  const content = await readFile(join(taskDir, "status.yaml"), "utf-8");
  const data = YAML.parse(content) as TaskStatusData;
  const allPassed = data.verification.criteria.length > 0
    && data.verification.criteria.every(c => c.result === "passed");
  data.verification.status = allPassed ? "passed" : "failed";
  data.verification.verified_at = new Date().toISOString();
  data.verification.verified_by = verifiedBy;

  // 检查 steps 完整性（与 executeTaskVerify 行为一致）
  const steps = (data.steps ?? []) as Array<{ status: string }>;
  const hasIncompleteSteps = steps.length === 0 || steps.some(s => s.status !== "completed" && s.status !== "skipped");

  let autoCompleted = false;
  if (allPassed && data.status === "running") {
    if (hasIncompleteSteps) {
      // Steps 不完整，不自动推进 status
      autoCompleted = false;
      await writeFile(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
      return { autoCompleted: false, autoCompleteSkippedReason: "任务没有完整的步骤数据（steps 为空或存在未完成的步骤），不自动推进状态" };
    } else {
      data.status = "completed"; data.completed_at = data.updated; autoCompleted = true;
      const revId = data.revisions.length > 0
        ? Math.max(...data.revisions.map((r: any) => r.id)) + 1 : 1;
      data.revisions.push({
        id: revId, type: "status_change", timestamp: data.updated, trigger: "task_verify",
        summary: "Auto-completed: all verification criteria passed",
      });
    }
  }
  await writeFile(join(taskDir, "status.yaml"), YAML.stringify(data), "utf-8");
  return { autoCompleted };
}

/**
 * 创建任务（模拟 task_create）。
 *
 * v0.3.0 目录结构：
 *   taskRoot = specTaskDir/<name>/        ← brief.md, plan.md 等构件
 *   taskDir  = taskRoot/runs/001/          ← status.yaml
 *
 * 返回 taskRoot（构件写入）和 taskDir（状态操作）。
 */
export async function createTask(
  specTaskDir: string, taskName: string,
  opts: { title?: string; assignedTo?: string; brief?: string } = {}
): Promise<{ taskRoot: string; taskDir: string; taskId: string }> {
  const taskRoot = join(specTaskDir, taskName);
  const runDir = join(taskRoot, "runs", "001");
  await mkdir(runDir, { recursive: true });

  // 写入 brief.md 到任务根目录
  if (opts.brief) {
    await writeFile(join(taskRoot, "brief.md"), opts.brief, "utf-8");
  }

  const now = new Date().toISOString();
  const statusData: TaskStatusData = {
    task_id: taskName, title: opts.title ?? taskName, created: now, updated: now,
    status: "pending", assigned_to: opts.assignedTo ?? "",
    started_at: null, completed_at: null,
    run_id: "001",
    progress: { total: 0, completed: 0, skipped: 0, current_step: "", percentage: 0 },
    outputs: [], steps: [],
    errors: [], blocked_by: [],
    verification: { status: "pending", criteria: [], verified_at: null, verified_by: null },
    revisions: [{
      id: 1, type: "created", timestamp: now, trigger: opts.assignedTo ?? "e2e-test",
      summary: "Task created",
    }],
  };
  await writeFile(join(runDir, "status.yaml"), YAML.stringify(statusData), "utf-8");
  return { taskRoot, taskDir: runDir, taskId: taskName };
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
