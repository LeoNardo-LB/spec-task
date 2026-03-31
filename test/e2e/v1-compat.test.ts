import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { StatusStore } from "../../src/core/status-store.js";
import { executeTaskTransition } from "../../src/tools/task-transition.js";
import { executeTaskVerify } from "../../src/tools/task-verify.js";
import { executeTaskResume } from "../../src/tools/task-resume.js";
import { executeTaskArchive } from "../../src/tools/task-archive.js";
import { createTestEnv } from "./helpers.js";
import type { TaskStatus, TaskStatusData } from "../../src/types.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * v1.0 Python 生成的 status.yaml 原始内容。
 * 关键 v1.0 差异：
 *   - affected_steps: {}  （空对象，而非 { invalidated: [], modified: [], added: [] }）
 *   - 时间戳带时区后缀：'2026-03-28T18:03:04.007543+00:00'
 *   - elapsed_minutes: 0.1 （浮点数）
 *   - parent: null
 */
const V10_COMPLETED_YAML = `task_id: final-e2e
title: 最终端到端验证
created: '2026-03-28T18:03:04.007543+00:00'
updated: '2026-03-28T18:03:30.625910+00:00'
status: completed
assigned_to: main
started_at: '2026-03-28T18:03:25.156612+00:00'
completed_at: '2026-03-28T18:03:30.626143+00:00'
progress:
  total: 0
  completed: 0
  current_step: ''
  percentage: 0
parent: null
depth: 0
children: []
outputs:
- /home/leonardo123/.openclaw/workspace/spec-task/final-e2e/outputs/repeater.py
timing:
  estimated_minutes: null
  elapsed_minutes: 0.1
errors: []
alerts: []
blocked_by: []
verification:
  status: passed
  criteria:
  - criterion: repeat(ab,3)==ababab
    result: passed
    evidence: test_repeat_normal PASSED
    reason: ''
  verified_at: '2026-03-28T18:03:30.625895+00:00'
  verified_by: main
revisions:
- id: 1
  type: created
  timestamp: '2026-03-28T18:03:04.007705+00:00'
  trigger: task_creation
  summary: Task 'final-e2e' created
  impact: minor
  changes: []
  affected_steps: {}
  resume_from: ''
  status_before: pending
  status_after: pending
`;

/**
 * v1.0 格式但状态为 pending 的 YAML（用于可转换测试）。
 */
const V10_PENDING_YAML = `task_id: compat-pending
title: V1.0 兼容性待办任务
created: '2026-03-28T18:03:04.007543+00:00'
updated: '2026-03-28T18:03:30.625910+00:00'
status: pending
assigned_to: agent
started_at: null
completed_at: null
progress:
  total: 3
  completed: 0
  current_step: ''
  percentage: 0
parent: null
depth: 0
children: []
outputs: []
timing:
  estimated_minutes: 15
  elapsed_minutes: 0.5
errors: []
alerts: []
blocked_by: []
verification:
  status: pending
  criteria: []
  verified_at: null
  verified_by: null
revisions:
- id: 1
  type: created
  timestamp: '2026-03-28T18:03:04.007705+00:00'
  trigger: task_creation
  summary: Task 'compat-pending' created
  impact: minor
  changes: []
  affected_steps: {}
  resume_from: ''
  status_before: pending
  status_after: pending
`;

/** 将 v1.0 YAML 写入指定任务目录 */
async function writeV10Status(taskDir: string, yamlContent: string): Promise<void> {
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "status.yaml"), yamlContent, "utf-8");
  // checklist.md 是 transition 计算进度所必需的
  await writeFile(join(taskDir, "checklist.md"), "- [ ] 1.1 Step\n- [ ] 1.2 Step\n- [ ] 1.3 Step\n", "utf-8");
}

/** 解析 ToolResponse 为 JSON 对象 */
function parseResponse(response: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(response.content[0].text);
}

/** 验证 revision 包含 v1.0 的核心字段 */
function expectV10RevisionFields(rev: any): void {
  expect(rev).toBeDefined();
  expect(rev.id).toBeDefined();
  expect(rev.type).toBeDefined();
  expect(rev.trigger).toBeDefined();
  expect(rev.summary).toBeDefined();
  expect(rev.timestamp).toBeDefined();
}

// ============================================================================
// Test Suite
// ============================================================================

describe("E2E: v1.0 Compatibility", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // -------------------------------------------------------------------------
  // Test 1: Load v1.0 status.yaml with affected_steps as {}
  // -------------------------------------------------------------------------
  it("should load v1.0 status.yaml with affected_steps as empty object {}", async () => {
    const taskDir = join(env.specTaskDir, "final-e2e");
    await writeV10Status(taskDir, V10_COMPLETED_YAML);

    const store = new StatusStore();
    const data = await store.loadStatus(taskDir);

    // 基本字段
    expect(data.task_id).toBe("final-e2e");
    expect(data.title).toBe("最终端到端验证");
    expect(data.status).toBe("completed");
    expect(data.assigned_to).toBe("main");
    expect(data.children).toEqual([]);
    expect(data.outputs).toHaveLength(1);
    expect(data.outputs[0]).toContain("repeater.py");

    // v1.0 时间戳（Python ISO with timezone）
    expect(data.created).toBe("2026-03-28T18:03:04.007543+00:00");
    expect(data.updated).toBe("2026-03-28T18:03:30.625910+00:00");
    expect(data.started_at).toBe("2026-03-28T18:03:25.156612+00:00");
    expect(data.completed_at).toBe("2026-03-28T18:03:30.626143+00:00");

    // v1.0 浮点 elapsed_minutes
    expect(data.timing.elapsed_minutes).toBe(0.1);

    // v1.0 验证数据
    expect(data.verification.status).toBe("passed");
    expect(data.verification.criteria).toHaveLength(1);
    expect(data.verification.criteria[0].criterion).toBe("repeat(ab,3)==ababab");
    expect(data.verification.criteria[0].result).toBe("passed");
    expect(data.verification.verified_by).toBe("main");

    // v1.0 revision 核心字段
    expect(data.revisions).toHaveLength(1);
    expectV10RevisionFields(data.revisions[0]);
  });

  // -------------------------------------------------------------------------
  // Test 2: Transition on v1.0 status.yaml → new revision has v2.0 format
  // -------------------------------------------------------------------------
  it("should transition v1.0 pending task and create revision with v2.0 affected_steps", async () => {
    const taskDir = join(env.specTaskDir, "compat-pending");
    await writeV10Status(taskDir, V10_PENDING_YAML);

    // 先验证原始数据是 v1.0 格式
    const store = new StatusStore();
    const originalData = await store.loadStatus(taskDir);
    expect(originalData.status).toBe("pending");
    expect(originalData.timing.elapsed_minutes).toBe(0.5);
    expect(originalData.revisions).toHaveLength(1);
    expectV10RevisionFields(originalData.revisions[0]);

    // 执行 pending → assigned 转换
    const result = await executeTaskTransition("compat-t2", {
      task_dir: taskDir,
      status: "assigned",
      trigger: "compat-test",
      summary: "v1.0 compat transition",
    });
    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.old_status).toBe("pending");
    expect(parsed.new_status).toBe("assigned");

    // 验证：原始 v1.0 revision 保持不变
    const afterData = await store.loadStatus(taskDir);
    expect(afterData.revisions).toHaveLength(2);

    // 原始 revision 核心字段
    expectV10RevisionFields(afterData.revisions[0]);

    // 新创建的 revision 核心字段
    expect(afterData.revisions[1].type).toBe("status_change");
  });

  // -------------------------------------------------------------------------
  // Test 3: Verify get on v1.0 completed task
  // -------------------------------------------------------------------------
  it("should return verification criteria from v1.0 completed task via get action", async () => {
    const taskDir = join(env.specTaskDir, "final-e2e");
    await writeV10Status(taskDir, V10_COMPLETED_YAML);

    const result = await executeTaskVerify("compat-t3", {
      task_dir: taskDir,
      action: { action: "get" },
    });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.verification).toBeDefined();
    expect(parsed.verification.status).toBe("passed");
    expect(parsed.verification.criteria).toHaveLength(1);

    const criterion = parsed.verification.criteria[0];
    expect(criterion.criterion).toBe("repeat(ab,3)==ababab");
    expect(criterion.result).toBe("passed");
    expect(criterion.evidence).toBe("test_repeat_normal PASSED");
    expect(criterion.reason).toBe("");

    // 验证 verified_at 和 verified_by 正确解析
    expect(parsed.verification.verified_at).toBe("2026-03-28T18:03:30.625895+00:00");
    expect(parsed.verification.verified_by).toBe("main");
  });

  // -------------------------------------------------------------------------
  // Test 4: Resume on v1.0 completed task → returns "已完成"
  // -------------------------------------------------------------------------
  it("should return '已完成' next_action for v1.0 completed task via resume", async () => {
    const taskDir = join(env.specTaskDir, "final-e2e");
    await writeV10Status(taskDir, V10_COMPLETED_YAML);

    const result = await executeTaskResume("compat-t4", {
      task_dir: taskDir,
    });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("completed");
    expect(parsed.next_action).toContain("已完成");

    // 验证完整返回结构
    expect(parsed.details).toBeDefined();
    expect(parsed.details.task_id).toBe("final-e2e");
    expect(parsed.details.title).toBe("最终端到端验证");
    expect(parsed.details.created).toBe("2026-03-28T18:03:04.007543+00:00");
    expect(parsed.details.assigned_to).toBe("main");

    // 验证 outputs 保留
    expect(parsed.outputs).toHaveLength(1);
    expect(parsed.outputs[0]).toContain("repeater.py");

    // 验证 revisions 包含 v1.0 原始数据
    expect(parsed.revisions).toHaveLength(1);
    expectV10RevisionFields(parsed.revisions[0]);
  });

  // -------------------------------------------------------------------------
  // Test 5: Archive v1.0 completed task with dry_run
  // -------------------------------------------------------------------------
  it("should successfully dry_run archive on v1.0 completed task", async () => {
    const taskDir = join(env.specTaskDir, "final-e2e");
    await writeV10Status(taskDir, V10_COMPLETED_YAML);

    const result = await executeTaskArchive("compat-t5", {
      task_dir: taskDir,
      agent_workspace: env.agentWorkspace,
      dry_run: true,
    });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.results).toHaveLength(2);

    // 验证 dry_run 结果结构
    expect(parsed.results[0].action).toBe("create");
    expect(parsed.results[0].status).toBe("planned");
    expect(parsed.results[1].action).toBe("create_or_append");
    expect(parsed.results[1].status).toBe("planned");

    // 验证路径包含任务名
    expect(parsed.results[0].file).toContain("final-e2e");
    expect(parsed.results[1].file).toContain("final-e2e");
  });

  // -------------------------------------------------------------------------
  // Test 6: Round-trip — load v1.0 → save → reload → data integrity
  // -------------------------------------------------------------------------
  it("should preserve data integrity through load → save → reload round-trip", async () => {
    const taskDir = join(env.specTaskDir, "round-trip");
    await writeV10Status(taskDir, V10_COMPLETED_YAML);

    const store = new StatusStore();

    // Step 1: Load v1.0
    const loaded = await store.loadStatus(taskDir);
    expect(loaded.task_id).toBe("final-e2e");
    expect(loaded.status).toBe("completed");
    expect(loaded.timing.elapsed_minutes).toBe(0.1);
    expect(loaded.verification.status).toBe("passed");
    expect(loaded.revisions).toHaveLength(1);
    expectV10RevisionFields(loaded.revisions[0]);

    // Step 2: Save (auto-updates `updated` timestamp)
    const originalUpdated = loaded.updated;
    await store.saveStatus(taskDir, loaded);

    // Step 3: Reload
    const reloaded = await store.loadStatus(taskDir);

    // 验证核心数据完整性
    expect(reloaded.task_id).toBe(loaded.task_id);
    expect(reloaded.title).toBe(loaded.title);
    expect(reloaded.status).toBe(loaded.status);
    expect(reloaded.assigned_to).toBe(loaded.assigned_to);
    expect(reloaded.children).toEqual(loaded.children);
    expect(reloaded.outputs).toEqual(loaded.outputs);

    // 时间戳
    expect(reloaded.created).toBe(loaded.created);
    expect(reloaded.started_at).toBe(loaded.started_at);
    expect(reloaded.completed_at).toBe(loaded.completed_at);
    // `updated` 应该被 saveStatus 自动刷新
    expect(reloaded.updated).not.toBe(originalUpdated);
    expect(new Date(reloaded.updated).getTime()).toBeGreaterThan(
      new Date(originalUpdated).getTime()
    );

    // 浮点 elapsed_minutes 保持不变
    expect(reloaded.timing.elapsed_minutes).toBe(0.1);

    // 验证数据
    expect(reloaded.verification.status).toBe(loaded.verification.status);
    expect(reloaded.verification.criteria).toHaveLength(1);
    expect(reloaded.verification.criteria[0].criterion).toBe(
      loaded.verification.criteria[0].criterion
    );
    expect(reloaded.verification.verified_at).toBe(loaded.verification.verified_at);
    expect(reloaded.verification.verified_by).toBe(loaded.verification.verified_by);

    // Revisions（核心字段）
    expect(reloaded.revisions).toHaveLength(1);
    expect(reloaded.revisions[0].id).toBe(1);
    expect(reloaded.revisions[0].type).toBe("created");
    expect(reloaded.revisions[0].trigger).toBe("task_creation");

    // 其他数组字段
    expect(reloaded.errors).toEqual(loaded.errors);
    expect(reloaded.alerts).toEqual(loaded.alerts);
    expect(reloaded.blocked_by).toEqual(loaded.blocked_by);
  });

  // -------------------------------------------------------------------------
  // Test 7: v1.0 YAML with multiple v1.0 revisions → all preserve {} format
  // -------------------------------------------------------------------------
  it("should preserve {} affected_steps for all v1.0 revisions after new transition", async () => {
    // 构建含多个 v1.0 revision 的 YAML
    const multiRevYaml = `task_id: multi-rev-v10
title: 多版本 v1.0 任务
created: '2026-03-28T10:00:00.000000+00:00'
updated: '2026-03-28T10:05:00.000000+00:00'
status: pending
assigned_to: agent
started_at: null
completed_at: null
progress:
  total: 2
  completed: 0
  current_step: ''
  percentage: 0
parent: null
depth: 0
children: []
outputs: []
timing:
  estimated_minutes: 10
  elapsed_minutes: 0.3
errors: []
alerts: []
blocked_by: []
verification:
  status: pending
  criteria: []
  verified_at: null
  verified_by: null
revisions:
- id: 1
  type: created
  timestamp: '2026-03-28T10:00:00.000000+00:00'
  trigger: task_creation
  summary: Task created
  impact: minor
  changes: []
  affected_steps: {}
  resume_from: ''
  status_before: pending
  status_after: pending
- id: 2
  type: user_request
  timestamp: '2026-03-28T10:02:00.000000+00:00'
  trigger: user
  summary: User modified requirements
  impact: major
  changes:
  - artifact: spec
    action: modified
    detail: Updated spec section 3
  affected_steps: {}
  resume_from: '2.1'
  status_before: pending
  status_after: pending
`;

    const taskDir = join(env.specTaskDir, "multi-rev-v10");
    await writeV10Status(taskDir, multiRevYaml);

    const store = new StatusStore();
    const before = await store.loadStatus(taskDir);
    expect(before.revisions).toHaveLength(2);
    expectV10RevisionFields(before.revisions[0]);
    expectV10RevisionFields(before.revisions[1]);

    // 执行转换
    await executeTaskTransition("compat-t7", {
      task_dir: taskDir,
      status: "assigned",
      trigger: "v10-compat",
    });

    const after = await store.loadStatus(taskDir);
    expect(after.revisions).toHaveLength(3);

    // 两个原始 v1.0 revision 核心字段
    expectV10RevisionFields(after.revisions[0]);
    expectV10RevisionFields(after.revisions[1]);

    // 新 revision 核心字段
    expect(after.revisions[2].type).toBe("status_change");
  });
});
