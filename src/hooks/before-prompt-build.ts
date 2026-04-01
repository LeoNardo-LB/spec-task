import type { ArtifactName, SpecTaskConfig, TrackingLevel, Step } from "../types.js";
import { ConfigManager } from "../core/config.js";
import { FileUtils } from "../file-utils.js";
import { SchemaReader } from "../core/schema-reader.js";
import { join } from "path";
import { readdir, stat } from "fs/promises";
import YAML from "yaml";

/** 步骤为空强提醒——当 running/assigned 任务的 steps:[] 时注入，提示 LLM 立即调用 steps_update */
function buildMissingStepsAlert(tone: ToneConfig): string {
  return `${tone.warnIcon} 检测到任务的步骤数据为空（steps: []）。
task_create 只创建 brief.md / plan.md / status.yaml，**不会自动填充步骤**。
${tone.verb}立即调用 steps_update，将 plan.md 中的 Steps Overview 解析为结构化步骤写入 status.yaml。
每步必须包含 id、summary（title/content/approach/sources）、status、tags。格式见上方 STEPS_GUIDE。`;
}

/** 文档编写前置条件——强制 LLM 先探索代码库再编写 brief/plan */
function buildExploreBeforeWrite(tone: ToneConfig): string {
  const forceTag = tone.forceLabel;
  return `## 文档编写前置条件${forceTag}

在编写 brief.md 和 plan.md 之前，**${tone.verb}先完成信息收集**。禁止在上下文为空时直接编写文档。

**探索清单（必须全部完成）：**
1. **探索代码库** — 阅读与任务相关的源文件，理解现有架构、命名约定、目录结构
2. **识别约束** — 找出技术约束、依赖关系、已有接口、不可修改的模块
3. **评估方案** — 如果有多种实现路径，简要对比优劣（记录在 plan.md 的 Key Decisions 章节中）
4. **收集证据** — 记录关键发现：文件路径、函数签名、数据结构、已有测试模式

探索产出不要求写文件，但**探索结果必须体现在文档质量中**：
- brief.md 的 Scope 和 Context 章节应基于实际代码库观察
- plan.md 的 Key Decisions 章节必须基于方案对比（不是凭空想象）
- plan.md 的 Steps Overview 中每步必须引用实际存在的文件路径和函数名

**执行方式**：使用文件读取工具浏览代码库，重点关注与任务直接相关的模块。探索完成后立即编写 brief.md，然后编写 plan.md。`;
}

/** System Prompt 层打勾指引（静态，可被 prompt caching） */
function buildStepsGuide(tone: ToneConfig): string {
  const forceTag = tone.forceLabel;
  return `${tone.stepsTitle}
你拥有 steps_read 和 steps_update 工具。
- steps_read：读取结构化步骤数据和进度统计（只读）
- steps_update：全量替换 status.yaml 中的步骤数据，自动计算进度

**执行纪律${forceTag}**：
- 必须按步骤编号顺序逐步完成所有步骤，禁止跳步
- 每完成一个步骤后必须立即使用 steps_update 写回更新后的步骤数据
- 未标记跳过的步骤均视为必须完成，不能自行决定跳过

**步骤质量规范${forceTag}**：
每一步的 summary 必须提供自包含的执行上下文，使执行者无需回头翻阅 brief/plan 即可理解和执行。

- **title**（标题）：动宾结构 + 具体对象。说明步骤的作用和目标。
  ✅ "在 run-utils.ts 中实现 getNextRunId() 目录编号分配"
  ❌ "实现工具" / "工具开发"
- **content**（内容）：包含 ① 做什么（目标）② 关键参数/输入 ③ 实现思路概述 ④ 验证方式。
  ✅ "在 src/core/ 新建 run-utils.ts，实现 getNextRunId() 扫描 runs/ 目录获取下一个递增编号（已有 001,002 则返回 003）。使用 fs.readdir + 正则 /^\\d{3}$/ 过滤目录名。完成后运行 npm test -- run-utils 验证。"
  ❌ "实现功能" / "写代码"
- **approach**（实施方式）：具体技术策略，包含工具/库/算法选择。
  ✅ "使用 fs.readdir 扫描 runs/ 子目录，过滤匹配 /^\\d{3}$/ 的目录名，取 max 编号 +1 并零填充至 3 位"
  ❌ "使用 Node.js"
- **sources**（来源引用）：必须引用 brief.md/plan.md 的对应章节。格式：\`文件名.md#标题文本\`（相对路径 + markdown heading，标题文本必须与文档中 \`##\` 后的内容完全一致）。
  - 引用 brief.md 中的章节（如 Intent/意图、Scope/范围、Success Criteria/成功标准、Context/背景）
  - 引用 plan.md 中的章节（如 Strategy/策略、Key Decisions/关键决策、Steps Overview/步骤概览）
  ✅ ["brief.md#Scope", "plan.md#Steps Overview"] 或 ["brief.md#范围", "plan.md#步骤概览"]（取决于文档实际使用的标题语言）
  ❌ []（空数组）`;
}

/** 打勾提醒（追加到进度摘要末尾，动态填充 {phase_steps}） */
const STEPS_REMINDER = `⚠️ 当前阶段待完成步骤：{phase_steps}。请按顺序完成后用 steps_update 写回。禁止跳过未完成步骤。`;

/** 内容缺失提醒（包含 template 格式示例，引导 LLM 补充缺失构件） */
const SKELETON_FILL_REMINDER = `请在下次 task_create 时传入完整内容，或使用 steps_update 工具补充步骤。

**brief.md 格式参考：**
## Intent
为什么做这个任务？解决什么问题？为谁解决？
## Scope
In scope: 明确在范围内的内容
Out of scope: 明确不在范围内的内容
## Success Criteria
- [ ] 标准 1（可衡量的完成条件）
## Context
任务背景信息、约束条件、参考资料

**plan.md 格式参考：**
## Strategy
用什么策略完成任务？
## Key Decisions
关键技术决策。每个 Decision 包含：
- **选择**：采用什么方案
- **替代方案**：考虑过但未采用的方案（说明否决原因）
- **理由**：为什么选择当前方案
## Tools Required
| 工具/API | 用途 | 备注 |
## Dependencies
依赖其他什么任务或外部条件
## Steps Overview
每步包含：操作动词 + 目标文件路径 + 函数/接口名 + 行为描述 + 验证方式
1. 新建 \`src/core/run-utils.ts\`：实现 \`getNextRunId(taskDir)\` 扫描 runs/ 子目录获取下一个递增编号 → 运行 \`npm test -- run-utils\` 验证
2. 重写 \`src/tools/task-create.ts\`：判断任务目录是否存在，不存在则创建任务目录 + runs/001/ + status.yaml → 运行对应测试验证

**steps 格式规范（重要）：**
每个步骤包含 summary: { title, content, approach, sources }，必须提供自包含的执行上下文。

- **title**：动宾结构 + 具体对象。说明步骤的作用。引用具体文件路径/函数名。
- **content**：① 做什么（目标）② 关键参数/输入 ③ 实现思路概述 ④ 验证方式
- **approach**：具体技术策略（工具/库/算法选择）
- **sources**：必须引用 brief.md/plan.md 对应章节。格式 \`文件名.md#标题文本\`，标题文本必须与文档中 \`##\` 后的内容完全一致。
  - brief.md 典型章节：Intent/意图、Scope/范围、Success Criteria/成功标准、Context/背景
  - plan.md 典型章节：Strategy/策略、Key Decisions/关键决策、Steps Overview/步骤概览
  - 格式：\`["brief.md#Scope", "plan.md#Steps Overview"]\`（或中文标题 \`["brief.md#范围", "plan.md#步骤概览"]\`，取决于文档实际标题）

**高质量步骤示例：**
\`\`\`yaml
- id: "1.1"
  summary:
    title: "在 run-utils.ts 中实现 getNextRunId() 目录编号分配"
    content: "在 src/core/ 新建 run-utils.ts，实现 getNextRunId(taskDir) 扫描 runs/ 子目录获取下一个递增编号（已有 001,002 则返回 003）。使用 fs.readdir + 正则 /^\\d{3}$/ 过滤。完成后运行 npm test -- run-utils 验证。"
    approach: "fs.readdir 扫描 → 过滤 \\d{3} 目录名 → Math.max(...ids) + 1 → padStart(3, '0')"
    sources:
      - "plan.md#Steps Overview"
      - "brief.md#Scope"
  status: pending
  tags: ["core", "runs"]
\`\`\``;

/** 文本截断提示后缀 */
const TRUNCATION_SUFFIX = `\n\n⚠️ 指导内容过长，已截断。请调用 \`task_instructions\` 工具获取完整指导。`;

/** 默认截断阈值（字符数） */
const DEFAULT_TRUNCATION_LIMIT = 2000;

/**
 * 截断文本并在末尾追加提示。
 * 如果文本长度不超过 maxLen，原样返回。
 * 如果超过，截断到 maxLen 并追加 TRUNCATION_SUFFIX。
 */
export function truncateWithContext(text: string, maxLen: number = DEFAULT_TRUNCATION_LIMIT): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + TRUNCATION_SUFFIX;
}

/**
 * 语气配置：根据 tracking level 决定文案的强制程度。
 * - low:    推荐（建议性，不阻塞）
 * - medium: 强烈推荐（强调重要性，不阻塞）
 * - high:   必须（强制执行，违反即错误）
 */
export interface ToneConfig {
  /** 构件要求前缀 */
  requirement: string;
  /** 动作词：建议 / 强烈建议 / 必须 */
  verb: string;
  /** 警告图标：💡 / ⚠️ / 🚫 */
  warnIcon: string;
  /** 强制标记词 */
  forceLabel: string;
  /** STEPS_GUIDE 标题前缀 */
  stepsTitle: string;
}

export function getToneConfig(level: TrackingLevel): ToneConfig {
  switch (level) {
    case "high":
      return {
        requirement: "当前追踪级别: high（强制）。task_create 时必须同时传入 brief + plan。",
        verb: "必须",
        warnIcon: "🚫",
        forceLabel: "（强制）",
        stepsTitle: "## Steps 进度追踪规则（强制执行）",
      };
    case "medium":
      return {
        requirement: "当前追踪级别: medium（强烈推荐）。task_create 时强烈建议同时传入 brief。",
        verb: "强烈建议",
        warnIcon: "⚠️",
        forceLabel: "（强烈建议）",
        stepsTitle: "## Steps 进度追踪规则",
      };
    default:
      return {
        requirement: "当前追踪级别: low（推荐）。task_create 时建议传入 brief。",
        verb: "建议",
        warnIcon: "💡",
        forceLabel: "（建议）",
        stepsTitle: "## Steps 进度追踪规则",
      };
  }
}

/** 根据 tracking level 构建构件要求提醒文本 */
function buildArtifactRequirement(level: TrackingLevel): string {
  return getToneConfig(level).requirement;
}

/** 子 Agent 合规规则：告知 subagent 必须使用 spec-task 及前三步操作 */
export function buildSubagentCompliance(tone: ToneConfig): string {
  return `${tone.warnIcon} **子 Agent 合规${tone.forceLabel}**：
作为子 agent（被 coordinator 通过 sessions_spawn 派发）时，${tone.verb}使用 spec-task 管理任务，不存在例外。
1. 第一步调用 \`config_merge\`，第二步调用 \`task_recall\`，第三步调用 \`task_create\`
2. 创建时${tone.verb}同时传入 \`brief\` + \`plan\` 参数
3. 工作区已有 spec-task/ 目录时，优先用 \`task_resume\` 检查可恢复任务`;
}

/** 精简版 8 步工作流概览：让 agent 了解完整流程 */
export function buildWorkflowOverview(tone: ToneConfig): string {
  return `${tone.warnIcon} **spec-task 工作流${tone.forceLabel}**：
${tone.verb}按以下步骤执行：
\`config_merge\` → \`task_recall\` → \`task_create\` → 探索收集 → 填充文档 → \`task_transition(running)\` → 执行步骤(steps_update) → \`task_verify\` → \`task_archive\``;
}

/** 目录结构说明：让 agent 知道文件放在哪 */
export function buildDirectoryStructure(): string {
  return `📁 **目录结构**：
\`\`\`
spec-task/
├── config.yaml              # 项目级配置
└── <task-name>/             # 任务根目录
    ├── brief.md             # 任务简报
    ├── plan.md              # 执行计划
    └── runs/
        └── 001/
            └── status.yaml  # 运行时状态
\`\`\`
> task_create 返回的 task_dir 指向 run 目录（如 runs/001/），后续工具调用均使用该路径。`;
}

interface ProgressInfo {
  summary: string | null;
  hasMissingChecklist: boolean;
  /** 下一个待完成的步骤编号（取所有 running 任务中编号最小的未完成步骤） */
  nextStep: string | null;
  /** 当前阶段所有未完成步骤（与 nextStep 同级，如 nextStep=1.3 则包含 1.3, 1.4, 1.5...） */
  currentPhaseSteps: string[];
  /** steps 全部完成的任务名列表 */
  completedTasks: string[];
  /** 接近完成的任务（≥50% 步完成且 verification !== passed） */
  nearCompletionTasks: Array<{
    name: string;
    runName: string;
    completed: number;
    total: number;
    percentage: number;
  }>;
}

/**
 * 扫描工作区中所有 running 任务的 status.yaml.steps，生成进度摘要。
 * 同时检测是否存在缺少 steps 数据的 running 任务。
 *
 * 输出格式：
 * 📋 当前进度：
 *   - task-name (running): 2/5 步完成（40%）
 *     未完成: 2.3, 3.1
 *
 * 仅在有未完成步骤时才输出 summary（全部完成则返回 null）。
 */
async function safeStat(path: string): Promise<import("fs").Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function buildProgressSummary(workspaceDir: string): Promise<ProgressInfo> {
  const fu = new FileUtils();
  const specTaskDir = join(workspaceDir, "spec-task");

  try {
    const entries = await readdir(specTaskDir, { withFileTypes: true });
    const summaryLines: string[] = [];
    let hasMissingChecklist = false;
    let firstUncheckedStep: string | null = null;
    const allUncheckedSteps: string[] = []; // 跨所有 running 任务收集
    const allCompletedTasks: string[] = []; // steps 全部完成的任务
    const allNearCompletionTasks: Array<{ name: string; runName: string; completed: number; total: number; percentage: number }> = []; // 接近完成的任务

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const taskDir = join(specTaskDir, entry.name);

      // Check for runs/ subdirectory
      const runsDir = join(taskDir, "runs");
      const runsStat = await safeStat(runsDir);
      if (runsStat && runsStat.isDirectory()) {
        // Scan runs/ subdirectories
        let runEntries: string[];
        try {
          const runDirEntries = await readdir(runsDir, { withFileTypes: true });
          runEntries = runDirEntries.filter(r => r.isDirectory() && /^\d{3}$/.test(r.name)).map(r => r.name);
        } catch { continue; }

        for (const runName of runEntries) {
          const statusPath = join(runsDir, runName, "status.yaml");
          const statusContent = await fu.safeReadFile(statusPath);
          if (!statusContent) continue;

          let statusData: { status?: string; steps?: Step[]; progress?: { total: number; completed: number }; verification?: { status: string } };
          try {
            statusData = YAML.parse(statusContent) as typeof statusData;
          } catch { continue; }

          if (statusData.status !== "running" && statusData.status !== "assigned") continue;

          const steps = statusData.steps;
          if (!steps || !Array.isArray(steps) || steps.length === 0) {
            hasMissingChecklist = true;
            continue;
          }

          const total = steps.length;
          const completed = steps.filter((s: Step) => s.status === "completed").length;
          const uncheckedSteps: string[] = [];

          for (const s of steps) {
            if (s.status === "pending") {
              const label = s.summary?.title ?? s.id;
              uncheckedSteps.push(label);
              allUncheckedSteps.push(s.id);
              if (!firstUncheckedStep) firstUncheckedStep = s.id;
            }
          }

          if (total > 0 && completed < total) {
            const pct = Math.round((completed / total) * 100);
            if (pct >= 50 && (!statusData.verification?.status || statusData.verification.status !== "passed")) {
              allNearCompletionTasks.push({ name: entry.name, runName, completed, total, percentage: pct });
            }
            summaryLines.push(`  - ${entry.name}/${runName} (${statusData.status}): ${completed}/${total} 步完成（${pct}%）`);
            summaryLines.push(`    未完成: ${uncheckedSteps.join(", ")}`);
          } else if (total > 0 && statusData.verification?.status === "passed") {
            // 全部完成且已验收：标记已完成任务
            allCompletedTasks.push(entry.name);
          } else if (total > 0) {
            // 全部完成但验收未通过：接近完成
            allNearCompletionTasks.push({ name: entry.name, runName, completed, total, percentage: 100 });
          }
          break; // Only need one active run per task
        }
      } else {
        // Legacy: no runs/ directory — check for direct status.yaml
        const statusPath = join(taskDir, "status.yaml");
        const statusContent = await fu.safeReadFile(statusPath);
        if (!statusContent) continue;

        let statusData: { status?: string; steps?: Step[]; progress?: { total: number; completed: number }; verification?: { status: string } };
        try {
          statusData = YAML.parse(statusContent) as typeof statusData;
        } catch { continue; }

        if (statusData.status !== "running" && statusData.status !== "assigned") continue;

        const steps = statusData.steps;
        if (!steps || !Array.isArray(steps) || steps.length === 0) {
          hasMissingChecklist = true;
          continue;
        }

        const total = steps.length;
        const completed = steps.filter((s: Step) => s.status === "completed").length;
        const uncheckedSteps: string[] = [];

        for (const s of steps) {
          if (s.status === "pending") {
            const label = s.summary?.title ?? s.id;
            uncheckedSteps.push(label);
            allUncheckedSteps.push(s.id);
            if (!firstUncheckedStep) firstUncheckedStep = s.id;
          }
        }

        if (total > 0 && completed < total) {
          const pct = Math.round((completed / total) * 100);
          if (pct >= 50 && (!statusData.verification?.status || statusData.verification.status !== "passed")) {
            allNearCompletionTasks.push({ name: entry.name, runName: "", completed, total, percentage: pct });
          }
          summaryLines.push(`  - ${entry.name} (${statusData.status}): ${completed}/${total} 步完成（${pct}%）`);
          summaryLines.push(`    未完成: ${uncheckedSteps.join(", ")}`);
        } else if (total > 0 && statusData.verification?.status === "passed") {
          allCompletedTasks.push(entry.name);
        } else if (total > 0) {
          // 全部完成但验收未通过：接近完成
          allNearCompletionTasks.push({ name: entry.name, runName: "", completed, total, percentage: 100 });
        }
      }
    }

    if (summaryLines.length === 0 && allCompletedTasks.length === 0 && allNearCompletionTasks.length === 0) return { summary: null, hasMissingChecklist, nextStep: firstUncheckedStep, currentPhaseSteps: [], completedTasks: [], nearCompletionTasks: [] };

    // 筛选当前阶段（与 firstUncheckedStep 同顶级编号）的所有未完成步骤
    const currentPhaseSteps = firstUncheckedStep
      ? allUncheckedSteps.filter(s => s.split(".")[0] === firstUncheckedStep.split(".")[0])
      : [];

    return {
      summary: `\n📋 当前进度：\n${summaryLines.join("\n")}`,
      hasMissingChecklist,
      nextStep: firstUncheckedStep,
      currentPhaseSteps,
      completedTasks: allCompletedTasks,
      nearCompletionTasks: allNearCompletionTasks,
    };
  } catch {
    return { summary: null, hasMissingChecklist: false, nextStep: null, currentPhaseSteps: [], completedTasks: [], nearCompletionTasks: [] };
  }
}

interface PluginLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

interface HookConfig {
  enforceOnSubAgents?: boolean;
}

/**
 * 尝试使用 SchemaReader 进行精确注入。
 * 如果 SchemaReader 不可用（schema.yaml 缺失等），返回 null。
 */
async function trySchemaDrivenInjection(
  workspaceDir: string,
  detectorResult: { level: string; skeleton_tasks: Array<{ name: string; dir: string; missing: string[] }> },
  trackingLevel: TrackingLevel,
): Promise<{ prependContext: string; prependSystemContext?: string } | null> {
  // 从第一个 skeleton 任务的 dir 推断 taskRoot
  const firstTask = detectorResult.skeleton_tasks[0];
  if (!firstTask) return null;

  const taskRoot = firstTask.dir;

  const reader = new SchemaReader(null, taskRoot);
  await reader.parse();

  if (reader.getArtifactIds().length === 0) return null;

  // 推断状态
  const statusResult = await reader.getStatus(taskRoot);
  if (statusResult.hasCycle) return null;

  const nextReady = reader.getNextReady(statusResult);
  if (nextReady.length === 0) return null;

  // 获取第一个就绪构件的指导
  const artifactId = nextReady[0];
  const instructions = await reader.getInstructions(artifactId, taskRoot);
  if (!instructions) return null;

  // 构建注入文本
  const parts: string[] = [];
  parts.push(`📝 下一步：创建 ${artifactId}.md（${instructions.dependencies.length > 0 ? `依赖: [${instructions.dependencies.map(d => d.id).join(", ")}]` : "无依赖"}）`);
  parts.push("");

  if (instructions.context) {
    parts.push(`**项目背景：**\n${instructions.context}`);
    parts.push("");
  }

  parts.push(`**指导：**\n${instructions.instruction}`);
  parts.push("");

  if (instructions.template) {
    parts.push(`**模板结构：**\n\`\`\`\n${instructions.template}\n\`\`\``);
    parts.push("");
  }

  if (instructions.rules.length > 0) {
    parts.push(`**规则：**\n${instructions.rules.map(r => `- ${r}`).join("\n")}`);
    parts.push("");
  }

  parts.push("完成后系统将自动推断状态并注入下一步指导。");

  const artifactRequirement = buildArtifactRequirement(trackingLevel);
  const tone = getToneConfig(trackingLevel);
  const stepsGuide = buildStepsGuide(tone);
  const subagentCompliance = buildSubagentCompliance(tone);

  return {
    prependContext: truncateWithContext(parts.join("\n")),
    prependSystemContext: `${subagentCompliance}\n\n${artifactRequirement}\n\n${stepsGuide}`,
  };
}

/**
 * 当 steps 为空时，尝试 SchemaReader 驱动的 steps 填充指导。
 */
async function trySchemaDrivenStepsInjection(
  workspaceDir: string,
  trackingLevel: TrackingLevel,
): Promise<{ prependContext: string; prependSystemContext?: string } | null> {
  // 从 workspaceDir 找到 running 任务的 taskRoot
  const fu = new FileUtils();
  const specTaskDir = join(workspaceDir, "spec-task");

  let taskRoot: string | null = null;
  let taskDir: string | null = null;

  try {
    const entries = await readdir(specTaskDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskDirCandidate = join(specTaskDir, entry.name);

      // 检查 runs/ 子目录
      const runsDir = join(taskDirCandidate, "runs");
      const runsStat = await safeStat(runsDir);
      if (!runsStat || !runsStat.isDirectory()) continue;

      const runEntries = await readdir(runsDir, { withFileTypes: true });
      for (const runEntry of runEntries) {
        if (!runEntry.isDirectory()) continue;
        if (!/^\d{3}$/.test(runEntry.name)) continue;

        const statusPath = join(runsDir, runEntry.name, "status.yaml");
        const content = await fu.safeReadFile(statusPath);
        if (!content) continue;

        try {
          const statusData = YAML.parse(content);
          if (statusData.status === "running" || statusData.status === "assigned") {
            taskDir = join(runsDir, runEntry.name);
            taskRoot = taskDirCandidate;
            break;
          }
        } catch { continue; }
      }
      if (taskRoot) break;
    }
  } catch { return null; }

  if (!taskRoot || !taskDir) return null;

  // 读取 steps 数据
  let stepsData: unknown[] = [];
  const statusPath = join(taskDir, "status.yaml");
  const content = await fu.safeReadFile(statusPath);
  if (content) {
    try {
      const statusData = YAML.parse(content);
      if (Array.isArray(statusData?.steps)) stepsData = statusData.steps;
    } catch { /* ignore */ }
  }

  // 如果 steps 非空则不是 missing
  if (Array.isArray(stepsData) && stepsData.length > 0) return null;

  const reader = new SchemaReader(null, taskDir);
  await reader.parse();
  if (reader.getArtifactIds().length === 0) return null;

  const artifactRequirement = buildArtifactRequirement(trackingLevel);
  const tone = getToneConfig(trackingLevel);
  const stepsGuide = buildStepsGuide(tone);
  const subagentCompliance = buildSubagentCompliance(tone);

  // 构建精确指导
  const parts: string[] = [];
  parts.push(`⚠️ 检测到 running 任务的步骤数据为空（steps: []）。`);
  parts.push("");

  // 检查 plan.md 是否存在
  const planPath = join(taskRoot, "plan.md");
  const planStat = await safeStat(planPath);
  if (planStat) {
    parts.push("plan.md 已存在。请调用 `steps_update` 将 plan.md 中的 Steps Overview 解析为结构化步骤写入 status.yaml：");
  } else {
    parts.push("plan.md 尚未创建。请先通过 `task_create` 或直接编写创建 plan.md，再调用 `steps_update` 填充步骤：");
  }
  parts.push("");

  parts.push("**步骤格式（每步必须包含 summary）：**");
  parts.push("```yaml");
  parts.push("- id: \"1.1\"");
  parts.push("  summary:");
  parts.push("    title: \"动宾结构 + 具体对象\"");
  parts.push("    content: \"① 做什么 ② 关键参数 ③ 实现思路 ④ 验证方式\"");
  parts.push("    approach: \"具体技术策略\"");
  parts.push("    sources: [\"brief.md#Scope\", \"plan.md#Steps Overview\"]");
  parts.push("  status: pending");
  parts.push("  tags: []");
  parts.push("```");
  parts.push("");

  parts.push("💡 可调用 `task_instructions({ task_dir, artifact_id: \"plan\" })` 获取更详细的指导。");

  return {
    prependContext: truncateWithContext(parts.join("\n")),
    prependSystemContext: `${subagentCompliance}\n\n${artifactRequirement}\n\n${stepsGuide}`,
  };
}

/**
 * 当 steps 为空时，尝试 SchemaReader 驱动的 steps 填充指导。
 */
export function createPromptBuildHandler(
  logger: PluginLogger,
  detector: import("../detector.js").Detector,
  config: HookConfig,
  workspaceDirMap?: Map<string, string>,
  normalizeKey?: (key: string | undefined) => string | undefined
) {
  const cm = new ConfigManager();

  if (config.enforceOnSubAgents === false) {
    return async (_context: Record<string, unknown>) => ({});
  }

  return async (context: Record<string, unknown>, hookCtx: Record<string, unknown>) => {
    // 工作区路径：优先从 hookCtx.workspaceDir（生产环境），fallback 到 context.cwd（单元测试）
    const workspaceDir = (hookCtx?.workspaceDir ?? hookCtx?.cwd ?? context.cwd) as string | undefined;
    if (!workspaceDir) return {};

    // 将 workspaceDir 记录到 Map，供 before_tool_call hook 使用
    if (workspaceDirMap) {
      const agentId = (hookCtx?.agentId ?? context.agentId) as string | undefined;
      const sessionKey = (hookCtx?.sessionKey ?? context.sessionKey) as string | undefined;
      logger.info(`[spec-task] before_prompt_build: workspaceDir=${workspaceDir} agentId=${agentId} sessionKey=${sessionKey}`);
      // 使用规范化键存储，确保 before_tool_call 的大小写不敏感查找能命中
      const norm = normalizeKey ?? ((k: string | undefined) => k?.trim().toLowerCase() || undefined);
      if (agentId) workspaceDirMap.set(norm(agentId)!, workspaceDir);
      if (sessionKey) workspaceDirMap.set(norm(sessionKey)!, workspaceDir);
      // 同时保留原始键，最大化查找命中率
      if (agentId && norm(agentId) !== agentId) workspaceDirMap.set(agentId, workspaceDir);
      if (sessionKey && norm(sessionKey) !== sessionKey) workspaceDirMap.set(sessionKey, workspaceDir);
    }

    // 读取 tracking level（仅用于 hook 提醒级别，不再驱动骨架生成）
    let trackingLevel: TrackingLevel = "low";
    try {
      const config: SpecTaskConfig = await cm.loadMergedConfig(workspaceDir);
      if (config.tracking?.level) {
        trackingLevel = config.tracking.level;
      }
    } catch { /* 配置加载失败，使用默认 low */ }

    // 根据 tracking level 计算语气配置
    const tone = getToneConfig(trackingLevel);
    const stepsGuide = buildStepsGuide(tone);

    // 根据 tracking level 构建 requiredArtifacts（供 detector 使用）
    const TRACKING_ARTIFACTS: Record<TrackingLevel, ArtifactName[]> = {
      low: [],
      medium: ["brief"],
      high: ["brief", "plan"],
    };
    const requiredArtifacts = TRACKING_ARTIFACTS[trackingLevel];

    const result = await detector.detect(workspaceDir, requiredArtifacts);

    switch (result.level) {
      case "none":
        // 自动初始化：创建 spec-task/config.yaml
        try {
          await cm.ensureProjectConfig(workspaceDir, {
            runtime: { allow_agent_self_delegation: true, task_timeout: 60 },
            archive: { record_history: true, generate_lessons: true, auto_archive: false },
          });
          logger.info(`[spec-task] Auto-initialized spec-task/ at ${workspaceDir}`);
        } catch (e) {
          logger.error(`[spec-task] Failed to auto-initialize: ${e}`);
          return {};
        }
        return { prependContext: "✅ spec-task 已就绪。" };

      case "empty": {
        // 无活跃任务：根据追踪等级注入不同语气的引导
        const artifactRequirement = buildArtifactRequirement(trackingLevel);
        const subagentCompliance = buildSubagentCompliance(tone);
        const guideLines: string[] = [];
        if (trackingLevel === "high") {
          guideLines.push("📋 无活跃任务。");
          guideLines.push("");
          guideLines.push("🚫 追踪级别为 high（强制），你必须先调用 `task_create` 创建任务再开始工作。");
          guideLines.push("   创建后系统将自动注入进度追踪和步骤指导。");
        } else if (trackingLevel === "medium") {
          guideLines.push("📋 无活跃任务。");
          guideLines.push("");
          guideLines.push("⚠️ 追踪级别为 medium（强烈推荐），强烈建议调用 `task_create` 创建任务并传入 brief/plan。");
          guideLines.push("   创建后系统将自动注入进度追踪和步骤指导。");
        } else {
          guideLines.push("📋 无活跃任务。");
          guideLines.push("");
          guideLines.push("💡 如需任务追踪，可调用 `task_create` 创建任务并传入 brief/plan。");
          guideLines.push("   创建后系统将自动注入进度追踪和步骤指导。");
          guideLines.push("   （非强制，不影响正常工作流程。）");
        }
        // 新增：工作流概览 + 目录结构（仅 empty 级别注入）
        guideLines.push("");
        guideLines.push(buildWorkflowOverview(tone));
        guideLines.push("");
        guideLines.push(buildDirectoryStructure());
        return {
          prependSystemContext: `${subagentCompliance}\n\n${artifactRequirement}\n\n${stepsGuide}`,
          prependContext: guideLines.join("\n"),
        };
      }

      case "skeleton": {
        const lines = result.skeleton_tasks.map(
          t => `  - ${t.name}: 缺少 ${t.missing.join(", ")}`
        );

        // 尝试 SchemaReader 驱动的精确注入
        const schemaDriven = await trySchemaDrivenInjection(workspaceDir, result, trackingLevel);
        if (schemaDriven) {
          return schemaDriven;
        }

        // Fallback：如果 SchemaReader 不可用，使用硬编码提醒
        const warning = `📝 检测到以下任务缺少构件文件：\n${lines.join("\n")}\n${SKELETON_FILL_REMINDER}`;
        const artifactRequirement = buildArtifactRequirement(trackingLevel);
        const subagentCompliance = buildSubagentCompliance(tone);
        const progress = await buildProgressSummary(workspaceDir);
        const parts: string[] = [buildExploreBeforeWrite(tone), warning];
        if (progress.summary) {
          parts.push(progress.summary);
          parts.push(STEPS_REMINDER.replace("{phase_steps}", progress.currentPhaseSteps.join(", ")));
        }
        if (progress.hasMissingChecklist) parts.push(buildMissingStepsAlert(tone));
        return {
          prependSystemContext: `${subagentCompliance}\n\n${artifactRequirement}\n\n${stepsGuide}`,
          prependContext: parts.join("\n"),
        };
      }

      case "in_progress": {
        const progress = await buildProgressSummary(workspaceDir);
        const parts: string[] = [];

        if (progress.summary) {
          parts.push(progress.summary);
          parts.push(STEPS_REMINDER.replace("{phase_steps}", progress.currentPhaseSteps.join(", ")));
        }
        if (progress.hasMissingChecklist) {
          // 尝试 SchemaReader 驱动的 steps 填充指导
          const schemaDriven = await trySchemaDrivenStepsInjection(workspaceDir, trackingLevel);
          if (schemaDriven) {
            parts.push(schemaDriven.prependContext);
            // 合并 prependSystemContext
            const artifactRequirement = buildArtifactRequirement(trackingLevel);
            const subagentCompliance = buildSubagentCompliance(tone);
            return {
              prependSystemContext: schemaDriven.prependSystemContext ?? `${subagentCompliance}\n\n${artifactRequirement}\n\n${stepsGuide}`,
              prependContext: parts.join("\n"),
            };
          }
          // Fallback
          parts.push(buildMissingStepsAlert(tone));
        }

          // 接近完成的任务：提醒准备验收标准
          if (progress.nearCompletionTasks.length > 0) {
            const nearList = progress.nearCompletionTasks
              .map(t => `  - ${t.name}${t.runName ? "/" + t.runName : ""}: ${t.completed}/${t.total} 步完成（${t.percentage}%）`)
              .join("\n");
            parts.push(`\n📈 以下任务进度过半，即将进入验收阶段：\n${nearList}`);
            parts.push(`${tone.verb}提前准备验收标准。完成所有步骤后调用 task_verify 添加标准并 finalize。`);
          }

          // 方案A: steps 全部完成且已验收时注入下一步操作指引
          if (progress.completedTasks.length > 0) {
            const completedList = progress.completedTasks.map(t => `  - ✅ ${t}`).join("\n");
            parts.push(`\n🎯 以下任务的步骤已全部完成且验收通过：\n${completedList}`);
            parts.push("");
            parts.push(`${tone.verb}按以下顺序完成收尾操作：`);
            parts.push("1. 调用 `task_verify` 添加验收标准并执行 finalize");
            parts.push("2. 验证通过后调用 `task_transition({ status: \"completed\" })` 完成任务");
            parts.push("3. 如需归档，调用 `task_archive`");
          }

        if (parts.length === 0 && !progress.hasMissingChecklist && progress.completedTasks.length === 0 && progress.nearCompletionTasks.length === 0) return {};

        const artifactRequirement = buildArtifactRequirement(trackingLevel);
        const subagentCompliance = buildSubagentCompliance(tone);
        return {
          prependSystemContext: `${subagentCompliance}\n\n${artifactRequirement}\n\n${stepsGuide}`,
          prependContext: parts.join("\n"),
        };
      }

      case "all_done":
        // 所有任务已完成：不注入 prependSystemContext
        return {};
    }
  };
}
