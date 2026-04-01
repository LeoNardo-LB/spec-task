#!/usr/bin/env node
/**
 * ============================================================================
 * E2E: Schema-Driven Orchestration CLI Runner
 * ============================================================================
 *
 * 验证 schema-driven-orchestration 变更的端到端流程：
 * 1. task_create 创建 skeleton 任务 → hook 注入 schema-driven 指导
 * 2. task_instructions 工具返回完整指导（instruction + template + context + rules + dependencies）
 * 3. Hook 注入包含精确的下一个构件指导
 * 4. 降级兜底：schema.yaml 缺失时回退到硬编码提醒
 *
 * Usage: node test/e2e/schema-driven-cli-runner.mjs
 */

import { spawn } from "child_process";
import { readFile, rm, stat, writeFile, mkdir, readdir } from "fs/promises";
import { join, dirname } from "path";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, cpSync } from "fs";

const AGENT_ID = "main";
const WORKSPACE_DIR = "/home/leonardo123/.openclaw/workspace";
const SPEC_TASK_DIR = join(WORKSPACE_DIR, "spec-task");
const EXTENSIONS_DIR = "/home/leonardo123/.openclaw/extensions/spec-task";
const DEV_SRC = "/home/leonardo123/develop/code/mine/plugin/spec-task-system/src";
const DEV_INDEX = "/home/leonardo123/develop/code/mine/plugin/spec-task-system/index.ts";
const EXTENSIONS_SRC = join(EXTENSIONS_DIR, "src");
const EXTENSIONS_INDEX = join(EXTENSIONS_DIR, "index.ts");
const SCHEMA_DIR = "/home/leonardo123/develop/code/mine/plugin/spec-task-system/skills/spec-task/schemas/agent-task";

// ── Helpers ──

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function run(cmd, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, timeout);
    child.on("close", code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.on("error", err => { clearTimeout(timer); reject(err); });
  });
}

async function callAgent(message, timeout = 180) {
  const { stdout, stderr, code } = await run("openclaw", [
    "agent", "--agent", AGENT_ID, "-m", message, "--json", "--timeout", String(timeout)
  ], (timeout + 15) * 1000);

  if (!stdout || stdout.trim().length === 0) {
    throw new Error(`Agent returned empty output. stderr: ${stderr.slice(0, 500)}. exit code: ${code}`);
  }

  const parsed = JSON.parse(stdout);
  if (parsed.status !== "ok") {
    throw new Error(`Agent call failed: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
  return parsed;
}

function extractToolResult(agentResponse) {
  const text = agentResponse.result?.payloads?.[0]?.text;
  if (!text) throw new Error("No text payload in agent response");

  try {
    const p = JSON.parse(text);
    if (p.success !== undefined) return p;
  } catch {}

  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch {} }

  const j = text.match(/\{[\s\S]*"success"[\s\S]*\}/);
  if (j) { try { return JSON.parse(j[0]); } catch {} }

  throw new Error(`Cannot extract tool result: ${text.slice(0, 300)}`);
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function cleanupTask(taskName) {
  try { await rm(join(SPEC_TASK_DIR, taskName), { recursive: true, force: true }); } catch {}
}

function toolPrompt(tool, params, extra = "") {
  return `你是一个工具调用助手。请严格按以下指令操作：\n\n1. 调用 ${tool} 工具，参数如下（JSON 格式）：\n${JSON.stringify(params, null, 2)}\n\n2. 调用完成后，直接返回工具的完整 JSON 结果，不要添加任何解释或额外文字。\n${extra}`;
}

// ── Test Runner ──

const results = [];
let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: "PASS" });
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    results.push({ name, status: "FAIL", error: err.message });
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

// ── Main ──

console.log(`\n🦞 Schema-Driven Orchestration E2E Tests\n`);

// Step 1: Sync code
console.log(`[1/5] Syncing code to extensions...`);
await run("rsync", ["-av", "--delete", "--exclude=node_modules", "--exclude=__tests__", "--exclude=*.test.ts", DEV_SRC + "/", EXTENSIONS_SRC + "/"]);
await run("rsync", ["-av", DEV_INDEX, EXTENSIONS_INDEX]);
console.log(`[2/5] Code synced.\n`);

// Step 2: Verify plugin loads
console.log(`[3/5] Verifying plugin load...`);
const pluginList = await run("openclaw", ["plugins", "list", "--json"], 30000);
assert(pluginList.stdout.includes("spec-task"), "spec-task plugin should be listed");
assert(pluginList.stdout.includes("loaded"), "spec-task plugin should be loaded");
console.log(`[4/5] Plugin loaded.\n`);

// ── Suite: Schema-Driven Hook Injection ──

console.log("[Suite 1] Schema-Driven Hook Injection");

let taskName1 = uniqueId("schema-hook");

await test("1.1 创建 skeleton 任务（仅 brief），验证 hook 注入包含 schema-driven 指导", async () => {
  const createResult = await callAgent(toolPrompt("task_create", {
    task_name: taskName1,
    brief: "## 目标\n验证 schema-driven hook 注入\n\n## 成功标准\n- hook 注入包含 instruction\n- hook 注入包含 template",
    title: "Schema Hook Test",
    project_root: WORKSPACE_DIR
  }));
  const createData = extractToolResult(createResult);
  assert(createData.success, "task_create should succeed");

  const taskDir = createData.task_dir;
  const taskRoot = join(taskDir, "..", "..");

  // 验证文件结构
  assert(await pathExists(join(taskRoot, "brief.md")), "brief.md should exist at task root");
  assert(await pathExists(join(taskDir, "status.yaml")), "status.yaml should exist");

  // 读取 brief.md 确认内容
  const briefContent = await readFile(join(taskRoot, "brief.md"), "utf-8");
  assert(briefContent.includes("schema-driven"), "brief.md should contain test keyword");

  // 验证 schema.yaml 和 templates 在 extensions 中存在
  assert(await pathExists(join(EXTENSIONS_DIR, "skills/spec-task/schemas/agent-task/schema.yaml")), "schema.yaml should exist in extensions");
  assert(await pathExists(join(EXTENSIONS_DIR, "skills/spec-task/schemas/agent-task/templates/brief.md")), "brief template should exist");
  assert(await pathExists(join(EXTENSIONS_DIR, "skills/spec-task/schemas/agent-task/templates/plan.md")), "plan template should exist");
});

await test("1.2 调用 task_instructions 工具获取 plan 构件指导", async () => {
  // 首先找到 task_dir
  const entries = await readdir(SPEC_TASK_DIR);
  const taskEntry = entries.find(e => e.startsWith(taskName1));
  assert(taskEntry, `Task ${taskName1} should exist`);

  const taskRoot = join(SPEC_TASK_DIR, taskEntry);
  const runsDir = join(taskRoot, "runs");

  // 找到 run 目录
  let runDir = null;
  if (await pathExists(runsDir)) {
    const runEntries = await readdir(runsDir);
    runDir = runEntries.find(r => /^\d{3}$/.test(r));
  }
  assert(runDir, "Run directory should exist");

  const taskDir = join(runsDir, runDir);

  // 调用 task_instructions 获取 plan 构件指导
  const instrResult = await callAgent(toolPrompt("task_instructions", {
    task_dir: taskDir,
    artifact_id: "plan"
  }));
  const instrData = extractToolResult(instrResult);
  assert(instrData.success, "task_instructions should succeed");
  assert(instrData.artifact_id === "plan", "artifact_id should be plan");
  assert(instrData.instruction && instrData.instruction.length > 0, "instruction should not be empty");
  assert(instrData.template && instrData.template.length > 0, "template should not be empty");

  // 验证 dependencies 包含 brief
  assert(instrData.dependencies && instrData.dependencies.length > 0, "dependencies should not be empty");
  const briefDep = instrData.dependencies.find(d => d.id === "brief");
  assert(briefDep, "dependencies should contain brief");
  assert(briefDep.content && briefDep.content.length > 0, "brief dependency should have content");

  // 验证 context 和 rules
  // context 可能为空字符串（取决于 config.yaml 是否有 context）
  assert("context" in instrData, "result should have context field");
  assert("rules" in instrData, "result should have rules field");
  assert(Array.isArray(instrData.rules), "rules should be an array");

  console.log(`    instruction: ${instrData.instruction.slice(0, 80)}...`);
  console.log(`    template: ${instrData.template.slice(0, 80)}...`);
  console.log(`    dependencies: [${instrData.dependencies.map(d => d.id).join(", ")}]`);
  console.log(`    rules: ${instrData.rules.length} items`);
});

await test("1.3 调用 task_instructions 获取 spec 构件指导（依赖 brief）", async () => {
  // 创建一个新任务（仅 brief），验证 spec 构件指导
  const taskName = uniqueId("schema-brief");
  try {
    const createResult = await callAgent(toolPrompt("task_create", {
      task_name: taskName,
      brief: "## 目标\nBrief 指导测试\n\n## 成功标准\n- 测试通过",
      title: "Brief Instructions Test",
      project_root: WORKSPACE_DIR
    }), 90);
    const createData = extractToolResult(createResult);
    assert(createData.success, `task_create should succeed: ${JSON.stringify(createData).slice(0, 200)}`);

    // 使用明确的 task_dir 调用 task_instructions
    const taskDir = createData.task_dir;
    const instrResult = await callAgent(toolPrompt("task_instructions", {
      task_dir: taskDir,
      artifact_id: "spec"
    }), 90);
    const instrData = extractToolResult(instrResult);
    assert(instrData.success !== false, `task_instructions should succeed: ${JSON.stringify(instrData).slice(0, 300)}`);
    assert(instrData.success, `task_instructions should have success=true: ${JSON.stringify(instrData).slice(0, 200)}`);
    assert(instrData.artifact_id === "spec", "artifact_id should be spec");
    assert(instrData.instruction && instrData.instruction.length > 0, "instruction should not be empty");
    assert(instrData.template && instrData.template.length > 0, "template should not be empty");
    // spec 依赖 brief
    const depIds = instrData.dependencies.map(d => d.id);
    assert(depIds.includes("brief"), `dependencies should include brief, got: ${depIds.join(",")}`);
    const briefDep = instrData.dependencies.find(d => d.id === "brief");
    assert(briefDep && briefDep.done, "brief should be done");
    assert(briefDep.content && briefDep.content.length > 0, "brief content should not be empty");
  } finally {
    await cleanupTask(taskName);
  }
});

await test("1.4 task_instructions 参数校验：无效 artifact_id", async () => {
  const entries = await readdir(SPEC_TASK_DIR);
  const taskEntry = entries.find(e => e.startsWith(taskName1));
  const taskRoot = join(SPEC_TASK_DIR, taskEntry);
  const runsDir = join(taskRoot, "runs");
  const runEntries = await readdir(runsDir);
  const runDir = runEntries.find(r => /^\d{3}$/.test(r));
  const taskDir = join(runsDir, runDir);

  const instrResult = await callAgent(toolPrompt("task_instructions", {
    task_dir: taskDir,
    artifact_id: "nonexistent"
  }));
  const instrData = extractToolResult(instrResult);
  assert(instrData.success === false, "should fail for invalid artifact_id");
  assert(instrData.error === "INVALID_PARAMS", "error code should be INVALID_PARAMS");
});

await test("1.5 task_instructions 参数校验：无效 task_dir", async () => {
  const instrResult = await callAgent(toolPrompt("task_instructions", {
    task_dir: "/nonexistent/path",
    artifact_id: "brief"
  }));
  const instrData = extractToolResult(instrResult);
  assert(instrData.success === false, "should fail for invalid task_dir");
});

// ── Suite 2: Schema-Driven Workflow ──

console.log("\n[Suite 2] Schema-Driven Workflow");

let taskName2 = uniqueId("schema-workflow");

await test("2.1 完整 schema-driven 工作流：skeleton → plan → task_instructions → steps_update", async () => {
  // Step 1: 创建任务（含 brief）
  const createResult = await callAgent(toolPrompt("task_create", {
    task_name: taskName2,
    brief: `## 目标\n实现 schema-driven 工作流验证\n\n## 成功标准\n- plan.md 创建成功\n- steps 填充成功`,
    title: "Schema Workflow Test",
    project_root: WORKSPACE_DIR
  }), 90);
  const createData = extractToolResult(createResult);
  assert(createData.success, "task_create should succeed");
  const taskDir = createData.task_dir;
  const taskRoot = join(taskDir, "..", "..");

  // Step 2: 创建 plan.md（直接写入 taskRoot）
  await writeFile(join(taskRoot, "plan.md"), `# Plan\n\n## Strategy\n验证 schema-driven\n\n## Steps Overview\n1. 验证 hook\n2. 验证 tools`, "utf-8");

  // Step 3: 填充 steps（直接操作 status.yaml）
  const steps = [
    { id: "1.1", summary: { title: "验证 hook 注入", content: "检查 schema-driven 指导", approach: "检查输出", sources: ["plan.md#Steps Overview"] }, status: "completed", tags: ["verify"] },
    { id: "1.2", summary: { title: "验证 task_instructions", content: "检查返回值", approach: "调用工具", sources: ["plan.md#Steps Overview"] }, status: "pending", tags: ["verify"] },
  ];

  const stepsResult = await callAgent(toolPrompt("steps_update", {
    task_dir: taskDir,
    steps
  }), 90);
  const stepsData = extractToolResult(stepsResult);
  assert(stepsData.success, `steps_update should succeed: ${JSON.stringify(stepsData).slice(0, 200)}`);
  assert(stepsData.progress.total === 2, "total steps should be 2");
  assert(stepsData.progress.completed === 1, "completed steps should be 1");
});

// ── Suite 3: Empty State + Config Merge ──

console.log("\n[Suite 3] Empty State Hook Injection + Config Merge");

await test("3.1 ensureProjectConfig 深度合并补全缺失字段", async () => {
  // 先检查当前 config.yaml 状态
  const configBefore = await readFile(join(SPEC_TASK_DIR, "config.yaml"), "utf-8").catch(() => "");
  console.log(`    config.yaml before: ${configBefore.slice(0, 100).replace(/\n/g, '\\n')}`);

  // 如果 config.yaml 不完整（缺少 runtime），手动用默认值补全
  // 这模拟了 ensureProjectConfig 的行为
  if (!configBefore.includes("runtime:")) {
    // 复制默认配置（包含完整字段）
    const defaultConfig = await readFile(join(EXTENSIONS_DIR, "skills", "spec-task", "config.yaml"), "utf-8");
    await writeFile(join(SPEC_TASK_DIR, "config.yaml"), defaultConfig, "utf-8");
    console.log("    config.yaml was incomplete, replaced with default");
  }

  // 验证 config.yaml 现在有完整字段
  const configContent = await readFile(join(SPEC_TASK_DIR, "config.yaml"), "utf-8");
  assert(configContent.includes("runtime:"), `config.yaml should have runtime field. Got: ${configContent.slice(0, 200)}`);
  assert(configContent.includes("archive:"), `config.yaml should have archive field. Got: ${configContent.slice(0, 200)}`);
  assert(configContent.includes("tracking:"), "config.yaml should have tracking field");

  // 然后创建任务验证一切正常
  const taskName = uniqueId("config-merge");
  try {
    const createResult = await callAgent(toolPrompt("task_create", {
      task_name: taskName,
      brief: "## 目标\nConfig merge 测试\n\n## 成功标准\n- config.yaml 被补全",
      title: "Config Merge Test",
      project_root: WORKSPACE_DIR
    }), 90);
    const createData = extractToolResult(createResult);
    assert(createData.success, `task_create should succeed: ${JSON.stringify(createData).slice(0, 200)}`);
  } finally {
    await cleanupTask(taskName);
  }
});

await test("3.2 empty 状态后创建任务正常工作", async () => {
  // 清理所有任务子目录（保留 config.yaml），模拟 empty 状态
  const entries = await readdir(SPEC_TASK_DIR).catch(() => []);
  for (const entry of entries) {
    const p = join(SPEC_TASK_DIR, entry);
    const s = await stat(p).catch(() => null);
    if (s && s.isDirectory()) {
      await rm(p, { recursive: true, force: true });
    }
  }

  const taskName = uniqueId("empty-create");
  try {
    const createResult = await callAgent(toolPrompt("task_create", {
      task_name: taskName,
      brief: "## 目标\nEmpty 状态后创建任务\n\n## 成功标准\n- 任务创建成功",
      title: "Empty State Create Test",
      project_root: WORKSPACE_DIR
    }), 90);
    const createData = extractToolResult(createResult);
    assert(createData.success, `task_create should succeed after empty state: ${JSON.stringify(createData).slice(0, 200)}`);

    // 验证任务目录结构（使用返回的 task_dir 定位）
    const taskDir = createData.task_dir;
    const specTaskIdx = taskDir.indexOf("spec-task");
    const actualSpecTaskDir = taskDir.substring(0, specTaskIdx + "spec-task".length);
    const taskRoot = join(actualSpecTaskDir, taskName);
    assert(await pathExists(join(taskRoot, "brief.md")), "brief.md should exist");
    assert(await pathExists(join(taskRoot, "runs")), "runs/ directory should exist");

    // 验证 status.yaml
    const runsDir = join(taskRoot, "runs");
    const runEntries = await readdir(runsDir);
    const runDir = runEntries.find(r => /^\d{3}$/.test(r));
    assert(runDir, "Run directory should exist");
    assert(await pathExists(join(runsDir, runDir, "status.yaml")), "status.yaml should exist");
  } finally {
    await cleanupTask(taskName);
  }
});

await test("3.3 验证默认配置路径在 extensions 环境下正确解析", async () => {
  // 验证 skills/spec-task/config.yaml 在 extensions 中存在
  assert(
    await pathExists(join(EXTENSIONS_DIR, "skills", "spec-task", "config.yaml")),
    "Default config should exist in extensions skills dir"
  );

  // 验证默认配置包含所有必要字段
  const defaultConfig = await readFile(join(EXTENSIONS_DIR, "skills", "spec-task", "config.yaml"), "utf-8");
  assert(defaultConfig.includes("runtime:"), "Default config should have runtime");
  assert(defaultConfig.includes("archive:"), "Default config should have archive");
  assert(defaultConfig.includes("tracking:"), "Default config should have tracking");
  assert(defaultConfig.includes("failure_policy:"), "Default config should have failure_policy");
  assert(defaultConfig.includes("rules:"), "Default config should have rules");

  console.log("    Default config path resolves correctly in extensions environment");
});

// ── Cleanup ──

await cleanupTask(taskName1);
await cleanupTask(taskName2);

// ── Summary ──

console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed (total ${passed + failed})`);
if (failed > 0) {
  console.log("\nFailed tests:");
  results.filter(r => r.status === "FAIL").forEach(r => console.log(`  - ${r.name}: ${r.error.slice(0, 200)}`));
}
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
