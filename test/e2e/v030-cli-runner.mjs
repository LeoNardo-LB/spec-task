#!/usr/bin/env node
/**
 * Standalone CLI E2E runner for v0.3.0 tests.
 * This script runs outside of vitest's process to avoid stdout interception issues.
 * 
 * Usage: node v030-cli-runner.mjs <test-name> [args...]
 * 
 * Exit codes: 0 = pass, 1 = fail, 2 = error
 */

import { spawn } from "child_process";
import { readFile, rm, stat, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { readFileSync } from "fs";
import YAML from "yaml";

const AGENT_ID = "main";
const WORKSPACE_DIR = "/home/leonardo123/.openclaw/workspace";
const SPEC_TASK_DIR = join(WORKSPACE_DIR, "spec-task");
const DEV_SRC = "/home/leonardo123/develop/code/mine/plugin/spec-task-system/src";
const EXTENSIONS_SRC = "/home/leonardo123/.openclaw/extensions/spec-task/src";
const DEV_INDEX = "/home/leonardo123/develop/code/mine/plugin/spec-task-system/index.ts";
const EXTENSIONS_INDEX = "/home/leonardo123/.openclaw/extensions/spec-task/index.ts";

// ── Helpers ──

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function run(cmd, args, timeout = 120000) {
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

async function syncCode() {
  await run("rsync", ["-av", "--delete", "--exclude=node_modules", "--exclude=__tests__", "--exclude=*.test.ts", DEV_SRC + "/", EXTENSIONS_SRC + "/"]);
  await run("rsync", ["-av", DEV_INDEX, EXTENSIONS_INDEX]);
}

async function callAgent(message, timeout = 120) {
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
  
  // Try direct JSON
  try {
    const p = JSON.parse(text);
    if (p.success !== undefined) return p;
  } catch {}
  
  // Try JSON in code block
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch {} }
  
  // Try finding JSON object
  const j = text.match(/\{[\s\S]*"success"[\s\S]*\}/);
  if (j) { try { return JSON.parse(j[0]); } catch {} }
  
  throw new Error(`Cannot extract tool result: ${text.slice(0, 300)}`);
}

async function readStatus(taskDir) {
  return YAML.parse(await readFile(join(taskDir, "status.yaml"), "utf-8"));
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function cleanupTask(taskName) {
  try { await rm(join(SPEC_TASK_DIR, taskName), { recursive: true, force: true }); } catch {}
}

async function cleanupArchive(taskName) {
  try { await rm(join(WORKSPACE_DIR, "memory", "task-history"), { recursive: true, force: true }); } catch {}
  try { await rm(join(WORKSPACE_DIR, "memory", "task-lessons", `${taskName}.md`), { force: true }); } catch {}
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

const testName = process.argv[2];
const allTests = process.argv[3] === "--all";

console.log(`\n🦞 v0.3.0 CLI E2E Tests`);
console.log(`   Test: ${testName || "ALL"}\n`);
console.log(`[1/5] Syncing code...`);
await syncCode();
console.log(`[2/5] Code synced.\n`);

// ── Suite 1: steps_update / steps_read ──

if (!testName || testName === "steps-io") {
  console.log("[Suite 1] steps_update / steps_read");
  
  let taskName1 = uniqueId("steps-io");
  
  await test("1.1 创建任务后 steps_update 写入含 summary 的步骤，steps_read 读回验证", async () => {
    const createResult = await callAgent(toolPrompt("task_create", {
      task_name: taskName1, brief: "## 目标\n测试 steps_update 和 steps_read", title: "Steps I/O Test"
    }));
    const createData = extractToolResult(createResult);
    assert(createData.success, "task_create should succeed");
    assert(createData.run_id === "001", "first run should be 001");
    const taskDir = createData.task_dir;
    
    assert(await pathExists(join(taskDir, "status.yaml")), "status.yaml should exist");
    assert(await pathExists(join(taskDir, "..", "..", "brief.md")), "brief.md should exist");
    
    const steps = [
      { id: "1.1", summary: { title: "设置开发环境", content: "安装依赖并配置 TS", approach: "npm install + tsc --init", sources: ["brief#目标"] }, status: "completed", tags: ["setup"] },
      { id: "1.2", summary: { title: "编写核心模块", content: "实现状态机和存储层", approach: "有限状态机 + YAML 持久化", sources: ["brief#目标"] }, status: "pending", tags: ["core"] },
      { id: "1.3", summary: { title: "编写测试", content: "覆盖边界条件", approach: "Vitest 参数化测试", sources: ["brief#目标"] }, status: "skipped", tags: ["test"] },
    ];
    
    const updateResult = await callAgent(toolPrompt("steps_update", { task_dir: taskDir, steps }));
    const updateData = extractToolResult(updateResult);
    assert(updateData.success, "steps_update should succeed");
    assert(updateData.progress.total === 3, "total should be 3");
    assert(updateData.progress.completed === 1, "completed should be 1");
    assert(updateData.progress.skipped === 1, "skipped should be 1");
    
    const readResult = await callAgent(toolPrompt("steps_read", { task_dir: taskDir }));
    const readData = extractToolResult(readResult);
    assert(readData.success, "steps_read should succeed");
    assert(readData.steps.length === 3, "should have 3 steps");
    assert(readData.steps[0].summary.title === "设置开发环境", "step 1.1 title should match");
    assert(readData.steps[0].summary.content.includes("安装依赖"), "step 1.1 content should match");
    assert(readData.steps[0].summary.approach.includes("npm install"), "step 1.1 approach should match");
    assert(readData.steps[0].summary.sources[0] === "brief#目标", "step 1.1 sources should match");
    assert(readData.steps[0].status === "completed", "step 1.1 should be completed");
    assert(readData.steps[0].completed_at !== null, "completed step should have completed_at");
    
    const status = await readStatus(taskDir);
    assert(status.steps.length === 3, "status.yaml should have 3 steps");
    assert(status.steps[0].summary.title === "设置开发环境", "status.yaml step title should match");
    
    await cleanupTask(taskName1);
  });
  
  await test("1.2 steps_update 全量替换后 progress 正确重算", async () => {
    const tn = uniqueId("steps-progress");
    const cr = await callAgent(toolPrompt("task_create", { task_name: tn, brief: "## 目标\nProgress test", title: "Progress Test" }));
    const cd = extractToolResult(cr);
    const td = cd.task_dir;
    
    const newSteps = [
      { id: "2.1", summary: { title: "A", content: "a", approach: "a", sources: [] }, status: "completed" },
      { id: "2.2", summary: { title: "B", content: "b", approach: "b", sources: [] }, status: "completed" },
      { id: "2.3", summary: { title: "C", content: "c", approach: "c", sources: [] }, status: "completed" },
      { id: "2.4", summary: { title: "D", content: "d", approach: "d", sources: [] }, status: "skipped" },
      { id: "2.5", summary: { title: "E", content: "e", approach: "e", sources: [] }, status: "pending" },
    ];
    
    const ur = await callAgent(toolPrompt("steps_update", { task_dir: td, steps: newSteps }));
    const ud = extractToolResult(ur);
    assert(ud.progress.total === 5, "total should be 5");
    assert(ud.progress.completed === 3, "completed should be 3");
    assert(ud.progress.skipped === 1, "skipped should be 1");
    // percentage = completed / total = 3/5 = 60%
    assert(Math.abs(ud.progress.percentage - 60) < 1, `percentage should be 60, got ${ud.progress.percentage}`);
    
    const st = await readStatus(td);
    assert(st.steps.length === 5, "should have 5 steps in status.yaml");
    
    await cleanupTask(tn);
  });
}

// ── Suite 2: Runs Isolation ──

if (!testName || testName === "runs-iso") {
  console.log("[Suite 2] Runs Isolation");
  
  await test("2.1 首次创建 runs/001，归档后再次创建 runs/002，两者独立", async () => {
    const tn = uniqueId("runs-iso");
    
    // Create run 001
    const cr1 = await callAgent(toolPrompt("task_create", { task_name: tn, brief: "## 目标\n测试 runs 隔离", title: "Runs Iso" }));
    const cd1 = extractToolResult(cr1);
    assert(cd1.run_id === "001", "first run should be 001");
    const td1 = cd1.task_dir;
    
    // Complete run 001
    await callAgent(toolPrompt("task_transition", { task_dir: td1, status: "assigned" }));
    await callAgent(toolPrompt("task_transition", { task_dir: td1, status: "running" }));
    await callAgent(toolPrompt("task_transition", { task_dir: td1, status: "completed" }));
    
    // Archive
    await callAgent(toolPrompt("task_archive", { task_dir: td1, agent_workspace: WORKSPACE_DIR, project_root: WORKSPACE_DIR }));
    
    // Create run 002
    const cr2 = await callAgent(toolPrompt("task_create", { task_name: tn, brief: "## 目标\n第二次执行", title: "Runs Iso 2" }));
    const cd2 = extractToolResult(cr2);
    assert(cd2.run_id === "002", "second run should be 002");
    const td2 = cd2.task_dir;
    
    // Verify both dirs exist
    const taskRoot = join(SPEC_TASK_DIR, tn);
    assert(await pathExists(join(taskRoot, "runs", "001")), "runs/001 should exist");
    assert(await pathExists(join(taskRoot, "runs", "002")), "runs/002 should exist");
    
    // Verify independence
    const s1 = await readStatus(join(taskRoot, "runs", "001"));
    const s2 = await readStatus(join(taskRoot, "runs", "002"));
    assert(s1.status === "completed", "run 001 should be completed");
    assert(s2.status === "pending", "run 002 should be pending");
    
    // Write steps to run 002
    await callAgent(toolPrompt("steps_update", { task_dir: td2, steps: [
      { id: "1.1", summary: { title: "Run2 Only", content: "test", approach: "test", sources: [] }, status: "pending" }
    ]}));
    
    const s2updated = await readStatus(td2);
    assert(s2updated.steps.length === 1, "run 002 should have 1 step");
    
    const s1updated = await readStatus(join(taskRoot, "runs", "001"));
    assert(s1updated.steps.length === 0, "run 001 should still have 0 steps (independent)");
    
    await cleanupTask(tn);
    await cleanupArchive(tn);
  });
}

// ── Suite 3: Full Lifecycle ──

if (!testName || testName === "lifecycle") {
  console.log("[Suite 3] Full Lifecycle");
  
  await test("3.1 完整生命周期: create → steps_update → transition → verify → archive → spec.md", async () => {
    const tn = uniqueId("lifecycle");
    
    // Create
    const cr = await callAgent(toolPrompt("task_create", {
      task_name: tn, brief: "## 目标\n实现用户认证模块\nJWT认证和刷新令牌",
      plan: "## 计划\n1. 设计架构\n2. 实现JWT签发\n3. 实现刷新令牌\n4. 测试",
      title: "Auth Module", assigned_to: "coding-agent"
    }));
    const cd = extractToolResult(cr);
    const td = cd.task_dir;
    const taskRoot = join(td, "..", "..");
    
    assert(await pathExists(join(taskRoot, "brief.md")), "brief.md should exist");
    assert(await pathExists(join(taskRoot, "plan.md")), "plan.md should exist");
    
    // Transition
    await callAgent(toolPrompt("task_transition", { task_dir: td, status: "assigned", trigger: "coordinator" }));
    await callAgent(toolPrompt("task_transition", { task_dir: td, status: "running", trigger: "coding-agent" }));
    
    let status = await readStatus(td);
    assert(status.status === "running", "should be running");
    assert(status.started_at !== null, "should have started_at");
    
    // Steps
    const steps = [
      { id: "1.1", summary: { title: "设计认证架构", content: "JWT + Refresh Token 双令牌", approach: "RS256, access 15min, refresh 7d", sources: ["brief#目标"] }, status: "completed", tags: ["design"] },
      { id: "1.2", summary: { title: "实现 JWT 签发", content: "access + refresh token 签发", approach: "jsonwebtoken, RS256", sources: ["brief#目标", "plan#计划"] }, status: "completed", tags: ["impl"] },
      { id: "1.3", summary: { title: "实现刷新令牌", content: "refresh token 轮换", approach: "每次刷新签发新 token", sources: ["plan#计划"] }, status: "completed", tags: ["impl"] },
      { id: "1.4", summary: { title: "编写测试", content: "覆盖签发验证刷新", approach: "Vitest 参数化", sources: ["plan#计划"] }, status: "pending", tags: ["test"] },
    ];
    await callAgent(toolPrompt("steps_update", { task_dir: td, steps }));
    
    // Log error
    await callAgent(toolPrompt("task_log", { task_dir: td, action: { action: "error", step: "1.2", message: "RSA key gen failed, retried" } }));
    
    // Log output
    await callAgent(toolPrompt("task_log", { task_dir: td, action: { action: "output", step: "1.2", message: "src/auth/jwt.ts" } }));
    
    // Complete remaining
    const finalSteps = steps.map(s => s.id === "1.4" ? { ...s, status: "completed" } : s);
    await callAgent(toolPrompt("steps_update", { task_dir: td, steps: finalSteps }));
    
    await callAgent(toolPrompt("task_transition", { task_dir: td, status: "completed", trigger: "coding-agent" }));
    
    // Verify
    await callAgent(toolPrompt("task_verify", { task_dir: td, action: { action: "add-criterion", criterion: "JWT signing works", result: "passed", evidence: "12 tests passed" } }));
    await callAgent(toolPrompt("task_verify", { task_dir: td, action: { action: "add-criterion", criterion: "Refresh rotation works", result: "passed", evidence: "Integration test passed" } }));
    await callAgent(toolPrompt("task_verify", { task_dir: td, action: { action: "finalize", verified_by: "coding-agent" } }));
    
    status = await readStatus(td);
    assert(status.status === "completed", "should be completed");
    assert(status.verification.status === "passed", "verification should be passed");
    
    // Archive
    const ar = await callAgent(toolPrompt("task_archive", { task_dir: td, agent_workspace: WORKSPACE_DIR, project_root: WORKSPACE_DIR, agent_name: "coding-agent" }));
    const ad = extractToolResult(ar);
    assert(ad.success, "archive should succeed");
    assert(ad.results.length >= 2, "should have at least 2 results");
    
    // Verify spec.md
    const specPath = join(taskRoot, "spec.md");
    assert(await pathExists(specPath), "spec.md should be auto-generated");
    const specContent = await readFile(specPath, "utf-8");
    assert(specContent.length > 50, "spec.md should have content");
    
    await cleanupTask(tn);
    await cleanupArchive(tn);
  });
}

// ── Suite 4: Spec Auto-Extraction ──

if (!testName || testName === "spec-extract") {
  console.log("[Suite 4] Spec Auto-Extraction");
  
  await test("4.1 归档含 steps/errors/outputs 后 spec.md 自动生成含关键信息", async () => {
    const tn = uniqueId("spec-extract");
    
    const cr = await callAgent(toolPrompt("task_create", {
      task_name: tn, brief: "## 目标\n实现数据库连接池\nPostgreSQL 连接池", title: "DB Pool"
    }));
    const cd = extractToolResult(cr);
    const td = cd.task_dir;
    const taskRoot = join(td, "..", "..");
    
    await callAgent(toolPrompt("task_transition", { task_dir: td, status: "assigned" }));
    await callAgent(toolPrompt("task_transition", { task_dir: td, status: "running" }));
    
    const steps = [
      { id: "1.1", summary: { title: "选型：pg-pool", content: "评估了 pg-pool/knex/typeorm", approach: "pg-pool 原生连接池，性能优", sources: ["brief#目标"] }, status: "completed", tags: ["design"] },
      { id: "1.2", summary: { title: "实现连接池配置", content: "最大连接数、超时、回收", approach: "max=20, idleTimeoutMillis=30000", sources: ["brief#目标"] }, status: "completed", tags: ["impl"] },
    ];
    await callAgent(toolPrompt("steps_update", { task_dir: td, steps }));
    
    await callAgent(toolPrompt("task_log", { task_dir: td, action: { action: "error", step: "1.2", message: "idleTimeoutMillis 单位是毫秒不是秒" } }));
    await callAgent(toolPrompt("task_log", { task_dir: td, action: { action: "output", step: "1.1", message: "src/db/pool.ts" } }));
    
    await callAgent(toolPrompt("task_transition", { task_dir: td, status: "completed" }));
    await callAgent(toolPrompt("task_archive", { task_dir: td, agent_workspace: WORKSPACE_DIR, project_root: WORKSPACE_DIR }));
    
    const specPath = join(taskRoot, "spec.md");
    assert(await pathExists(specPath), "spec.md should exist");
    const specContent = await readFile(specPath, "utf-8");
    assert(specContent.includes("pg-pool"), "spec.md should contain pg-pool from approach");
    assert(specContent.length > 50, "spec.md should have substantial content");
    
    await cleanupTask(tn);
    await cleanupArchive(tn);
  });
}

// ── Summary ──

console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailed tests:");
  results.filter(r => r.status === "FAIL").forEach(r => console.log(`  - ${r.name}: ${r.error.slice(0, 100)}`));
}
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
