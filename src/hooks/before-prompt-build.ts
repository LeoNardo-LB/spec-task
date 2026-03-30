import type { ArtifactName } from "../types.js";
import { ConfigManager } from "../core/config.js";
import { FileUtils } from "../file-utils.js";
import { join } from "path";
import { readdir } from "fs/promises";

/** L1 自动初始化提醒模板 */
const INIT_REMINDER = `⚠️ 强制要求：你收到任何任务时，必须先加载 spec-task 技能，并严格按照技能中的工作流程管理任务。不允许跳过。`;

/** L2 轻量提醒模板 */
const LIGHT_REMINDER = `⚠️ 强制要求：你收到任何任务时，必须先加载 spec-task 技能，并严格按照技能中的工作流程管理任务。不允许跳过。`;

/** 介入级别阈值映射 */
const INTERVENTION_THRESHOLDS: Record<string, number> = {
  low: 20,
  medium: 10,
  high: 3,
};

/**
 * 构建介入评估提示词。
 * 引导 LLM 对任务做最大拆分（X.Y.Z），统计叶子节点数与阈值对比。
 */
function buildInterventionPrompt(level: string, threshold: number): string {
  return `在开始执行任务前，你需要先评估任务复杂度：

1. 将任务尽可能细分为子步骤，使用 X.Y.Z 编号格式：
   - X = 功能模块 / 阶段（## H2 级别）
   - Y = 模块内子任务
   - Z = 子任务的具体操作步骤（叶子节点）

2. 统计叶子节点总数（最底层 Z 级步骤的数量）

3. 判断规则（当前介入级别：${level}，阈值：${threshold} 步）：
   - 叶子节点数 ≥ ${threshold} → 必须启动 spec-task 流程（config_merge → task_recall → task_create → 填充文档 → 执行）
   - 叶子节点数 < ${threshold} → 可以直接执行，但拆分结果仍有参考价值

示例：
- "修复登录按钮颜色错误" → 1.1（1 步）< ${threshold} → 直接执行
- "给 API 添加分页功能" → 1.1, 1.2, 2.1, 2.2, 2.3, 3.1, 4.1, 4.2（8 步）< ${threshold} → 直接执行
- "实现用户注册功能" → 1.1, 1.2, 1.3, 2.1, 2.2, 3.1, 3.2, 3.3, 4.1, 4.2, 5.1, 5.2（12 步）≥ ${threshold} → 启动 spec-task

注意：不确定时往"需要 spec-task"方向判断。`;
}

/**
 * 构建 L3 骨架警告内容。
 */
function buildSkeletonWarning(skeletonTasks: Array<{ name: string; missing: ArtifactName[] }>): string {
  const lines = skeletonTasks.map(t => `  - ${t.name}: 缺少 ${t.missing.join(", ")}`);
  return `🚨 SPEC-TASK 强制要求：检测到以下任务只有骨架（status.yaml）但缺少核心文档：

${lines.join("\n")}

你必须立即为这些任务填充缺失的文档：
1. 使用 config_merge 工具检查配置
2. 使用 task_create 工具创建任务（如未创建）
3. 按 brief → spec → plan → checklist 拓扑序填充内容
4. 不允许"先做再说"——没有 plan 的任务不允许进入 running 状态

这是不可协商的工作流要求。跳过此步骤将导致验收失败。`;
}

/**
 * 构建 L4 恢复提醒内容。
 */
function buildResumeReminder(tasks: Array<{ name: string; status: string }>): string {
  const lines = tasks.map(t => `  - ${t.name} (${t.status})`);
  return `📋 SPEC-TASK: 你有未完成的任务：
${lines.join("\n")}

优先恢复这些任务，使用 task_resume 工具获取断点信息。`;
}

/** 匹配 checkbox 行 */
const CHECKBOX_REGEX = /^- \[([ x])\]\s*(.+)/;
/** 提取步骤编号 */
const STEP_PATTERN = /^(\d+(?:\.\d+)+)/;

/**
 * 扫描工作区中所有任务的 checklist.md，生成结构化状态摘要。
 * 用于在 system prompt 中注入 checklist 进度信息，提醒 LLM 及时打勾。
 */
async function buildChecklistStatusSummary(workspaceDir: string): Promise<string | null> {
  const fu = new FileUtils();
  const specTaskDir = join(workspaceDir, "spec-task");

  try {
    const entries = await readdir(specTaskDir, { withFileTypes: true });
    const summaryLines: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const checklistPath = join(specTaskDir, entry.name, "checklist.md");
      const stat = await fu.safeStat(checklistPath);
      if (!stat || !stat.isFile()) continue;

      const content = await fu.safeReadFile(checklistPath);
      if (!content) continue;

      let total = 0;
      let completed = 0;
      const uncheckedSteps: string[] = [];

      for (const line of content.split("\n")) {
        const match = line.match(CHECKBOX_REGEX);
        if (!match) continue;

        const checked = match[1] === "x";
        const text = match[2].trim();
        const stepMatch = text.match(STEP_PATTERN);

        if (stepMatch) {
          total++;
          if (checked) {
            completed++;
          } else {
            uncheckedSteps.push(stepMatch[1]);
          }
        }
      }

      if (total > 0 && completed < total) {
        const stepsPreview = uncheckedSteps.slice(0, 5).join(", ");
        const suffix = uncheckedSteps.length > 5 ? `...` : "";
        summaryLines.push(`  - ${entry.name}: ${completed}/${total} 步完成，未完成: ${stepsPreview}${suffix}`);
      }
    }

    if (summaryLines.length === 0) return null;

    return `\n📋 Checklist 进度（每完成一步必须调用 checklist_update 打勾）：\n${summaryLines.join("\n")}`;
  } catch {
    return null;
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
  interventionLevel?: "low" | "medium" | "high" | "always";
}

/**
 * 创建 before_prompt_build hook 处理器。
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

    const result = await detector.detect(workspaceDir);
    const interventionLevel = config.interventionLevel ?? "high";

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
        // always 级别：无条件强制（现有行为）
        if (interventionLevel === "always") {
          return { prependContext: INIT_REMINDER };
        }
        // 其他级别：注入介入评估提示词
        return { prependContext: buildInterventionPrompt(interventionLevel, INTERVENTION_THRESHOLDS[interventionLevel]) };
      case "empty":
        // always 级别：无条件强制（现有行为）
        if (interventionLevel === "always") {
          return { prependContext: LIGHT_REMINDER };
        }
        // 其他级别：注入介入评估提示词
        return { prependContext: buildInterventionPrompt(interventionLevel, INTERVENTION_THRESHOLDS[interventionLevel]) };
      case "skeleton": {
        const checklistSummary = await buildChecklistStatusSummary(workspaceDir);
        const skeletonWarning = buildSkeletonWarning(result.skeleton_tasks);
        return { prependContext: checklistSummary ? `${skeletonWarning}\n${checklistSummary}` : skeletonWarning };
      }
      case "in_progress": {
        const checklistSummary = await buildChecklistStatusSummary(workspaceDir);
        const resumeReminder = buildResumeReminder(result.incomplete_tasks);
        return { prependContext: checklistSummary ? `${resumeReminder}\n${checklistSummary}` : resumeReminder };
      }
      case "all_done":
        return {};
    }
  };
}
