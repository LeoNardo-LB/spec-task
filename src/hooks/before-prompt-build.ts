import type { ArtifactName, SpecTaskConfig, TrackingLevel, Step } from "../types.js";
import { ConfigManager } from "../core/config.js";
import { FileUtils } from "../file-utils.js";
import { join } from "path";
import { readdir } from "fs/promises";
import YAML from "yaml";

/** 缺失 checklist 强提醒 */
const MISSING_CHECKLIST_ALERT = `🚨 当前任务缺少 checklist！请立即创建进度追踪清单。
使用 checklist_write 工具写入 checklist 内容。步骤应包含 [spawn:agent-name] 或 [check:type] 标识符。`;

/** System Prompt 层打勾指引（静态，可被 prompt caching） */
const CHECKLIST_GUIDE = `## Checklist 进度追踪规则
你拥有 checklist_read 和 checklist_write 工具。
- checklist_read：读取结构化步骤数据和进度统计（只读）
- checklist_write：全量覆盖 checklist.md 并自动更新 status.yaml 中的步骤状态

**执行纪律（强制）**：
- 必须按步骤编号顺序逐步完成所有步骤，禁止跳步
- 每完成一个步骤后必须立即使用 checklist_write 写回更新后的内容
- 不要手动编辑 checklist.md 文件，必须使用 checklist_write 工具
- 可以使用 \`[-]\` 标记跳过的步骤，格式：\`- [-] 1.3 步骤描述 (跳过原因)\`
- 未标记跳过的步骤均视为必须完成，不能自行决定跳过`;

/** 打勾提醒（追加到进度摘要末尾，动态填充 {phase_steps}） */
const CHECKLIST_REMINDER = `⚠️ 当前阶段待完成步骤：{phase_steps}。请按顺序完成后用 checklist_write 写回。禁止跳过未完成步骤。`;

/** 内容缺失提醒（包含 template 格式示例，引导 LLM 补充缺失构件） */
const SKELETON_FILL_REMINDER = `请在下次 task_create 时传入完整内容，或使用 checklist_write / write 工具补充。

**brief.md 格式参考：**
## 目标
一句话概括核心目标。
## 成功标准
- 标准1: 可衡量的完成条件

**plan.md 格式参考：**
## 概述
整体执行策略。
## 步骤分解
### 步骤 1: 名称
- 做什么 → 为什么 → 预期产出

**checklist.md 格式参考：**
## 1. 阶段名称
- [ ] 1.1 步骤描述
- [-] 1.2 可跳过的步骤 (跳过原因)`;

/** 根据 tracking level 构建构件要求提醒文本 */
function buildArtifactRequirement(level: TrackingLevel): string {
  switch (level) {
    case "high":
      return "当前追踪级别: high。task_create 时建议同时传入 brief + plan + checklist。";
    case "medium":
      return "当前追踪级别: medium。task_create 时建议同时传入 brief + checklist。";
    default:
      return "当前追踪级别: low。task_create 时建议传入 checklist。";
  }
}

interface ProgressInfo {
  summary: string | null;
  hasMissingChecklist: boolean;
  /** 下一个待完成的步骤编号（取所有 running 任务中编号最小的未完成步骤） */
  nextStep: string | null;
  /** 当前阶段所有未完成步骤（与 nextStep 同级，如 nextStep=1.3 则包含 1.3, 1.4, 1.5...） */
  currentPhaseSteps: string[];
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
async function buildProgressSummary(workspaceDir: string): Promise<ProgressInfo> {
  const fu = new FileUtils();
  const specTaskDir = join(workspaceDir, "spec-task");

  try {
    const entries = await readdir(specTaskDir, { withFileTypes: true });
    const summaryLines: string[] = [];
    let hasMissingChecklist = false;
    let firstUncheckedStep: string | null = null;
    const allUncheckedSteps: string[] = []; // 跨所有 running 任务收集

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // 读取 status.yaml 判断是否为 running
      const statusPath = join(specTaskDir, entry.name, "status.yaml");
      const statusContent = await fu.safeReadFile(statusPath);
      if (!statusContent) continue;

      let statusData: { status?: string; steps?: Step[]; progress?: { total: number; completed: number } };
      try {
        statusData = YAML.parse(statusContent) as typeof statusData;
      } catch {
        continue;
      }

      if (statusData.status !== "running") continue;

      // 从 status.yaml.steps 读取步骤数据
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
          uncheckedSteps.push(s.id);
          allUncheckedSteps.push(s.id);
          if (!firstUncheckedStep) firstUncheckedStep = s.id;
        }
      }

      if (total > 0 && completed < total) {
        const pct = Math.round((completed / total) * 100);
        summaryLines.push(`  - ${entry.name} (running): ${completed}/${total} 步完成（${pct}%）`);
        summaryLines.push(`    未完成: ${uncheckedSteps.join(", ")}`);
      }
    }

    if (summaryLines.length === 0) return { summary: null, hasMissingChecklist, nextStep: firstUncheckedStep, currentPhaseSteps: [] };

    // 筛选当前阶段（与 firstUncheckedStep 同顶级编号）的所有未完成步骤
    const currentPhaseSteps = firstUncheckedStep
      ? allUncheckedSteps.filter(s => s.split(".")[0] === firstUncheckedStep.split(".")[0])
      : [];

    return {
      summary: `\n📋 当前进度：\n${summaryLines.join("\n")}`,
      hasMissingChecklist,
      nextStep: firstUncheckedStep,
      currentPhaseSteps,
    };
  } catch {
    return { summary: null, hasMissingChecklist: false, nextStep: null, currentPhaseSteps: [] };
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
 * 创建 before_prompt_build hook 处理器。
 *
 * 双层注入策略：
 * - prependSystemContext（System Prompt 层）：静态打勾指引，可被 prompt caching
 * - prependContext（User Message 层）：动态进度摘要 + 打勾提醒
 *
 * @param logger          插件日志器
 * @param detector        骨架检测器实例
 * @param config          插件配置（enforceOnSubAgents 开关）
 * @param workspaceDirMap 闭包 Map，用于将 workspaceDir 传递给 before_tool_call hook。
 *                         PluginHookToolContext 没有 workspaceDir 字段，需要在
 *                         before_prompt_build（PluginHookAgentContext 有 workspaceDir）
 *                         中记录映射，供 before_tool_call 查找。
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

    // 根据 tracking level 构建 requiredArtifacts（供 detector 使用）
    const TRACKING_ARTIFACTS: Record<TrackingLevel, ArtifactName[]> = {
      low: ["checklist"],
      medium: ["brief", "checklist"],
      high: ["brief", "plan", "checklist"],
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

      case "empty":
        // 无活跃任务：不注入 prependSystemContext
        return { prependContext: "📋 无活跃任务。" };

      case "skeleton": {
        const lines = result.skeleton_tasks.map(
          t => `  - ${t.name}: 缺少 ${t.missing.join(", ")}`
        );

        const warning = `📝 检测到以下任务缺少构件文件：\n${lines.join("\n")}\n${SKELETON_FILL_REMINDER}`;

        // 根据 tracking level 构建构件要求提醒
        const artifactRequirement = buildArtifactRequirement(trackingLevel);

        const progress = await buildProgressSummary(workspaceDir);
        const parts: string[] = [warning];
        if (progress.summary) {
          parts.push(progress.summary);
          parts.push(CHECKLIST_REMINDER.replace("{phase_steps}", progress.currentPhaseSteps.join(", ")));
        }
        if (progress.hasMissingChecklist) parts.push(MISSING_CHECKLIST_ALERT);
        return {
          prependSystemContext: `${artifactRequirement}\n\n${CHECKLIST_GUIDE}`,
          prependContext: parts.join("\n"),
        };
      }

      case "in_progress": {
        const progress = await buildProgressSummary(workspaceDir);
        const parts: string[] = [];
        if (progress.summary) {
          parts.push(progress.summary);
          parts.push(CHECKLIST_REMINDER.replace("{phase_steps}", progress.currentPhaseSteps.join(", ")));
        }
        if (progress.hasMissingChecklist) parts.push(MISSING_CHECKLIST_ALERT);
        if (parts.length === 0) return {};

        const artifactRequirement = buildArtifactRequirement(trackingLevel);
        return {
          prependSystemContext: `${artifactRequirement}\n\n${CHECKLIST_GUIDE}`,
          prependContext: parts.join("\n"),
        };
      }

      case "all_done":
        // 所有任务已完成：不注入 prependSystemContext
        return {};
    }
  };
}
