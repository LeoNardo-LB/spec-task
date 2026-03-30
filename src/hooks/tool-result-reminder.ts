import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

/** 匹配 checkbox 行：`- [x] ...` 或 `- [ ] ...` */
const CHECKBOX_REGEX = /^- \[([ x])\]\s*(.+)/;

/** 从 checkbox 文本中提取步骤编号 */
const STEP_PATTERN = /^(\d+(?:\.\d+)+)/;

/** 不需要注入提醒的工具名称 */
const SKIP_TOOLS = new Set(["checklist_update", "checklist_status"]);

interface ChecklistInfo {
  taskName: string;
  total: number;
  completed: number;
  uncheckedSteps: string[];
}

/**
 * 扫描工作区中所有任务的 checklist.md，收集进度信息。
 * 同步实现，因为 tool_result_persist 是同步 hook。
 */
function scanChecklistsSync(workspaceDir: string): ChecklistInfo[] {
  const results: ChecklistInfo[] = [];
  const specTaskDir = join(workspaceDir, "spec-task");

  try {
    if (!existsSync(specTaskDir)) return results;

    const entries = readdirSync(specTaskDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const checklistPath = join(specTaskDir, entry.name, "checklist.md");
      if (!existsSync(checklistPath)) continue;

      let content: string;
      try {
        content = readFileSync(checklistPath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      let total = 0;
      let completed = 0;
      const uncheckedSteps: string[] = [];

      for (const line of lines) {
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

      // 只收集有未完成项的 checklist
      if (total > 0 && completed < total) {
        results.push({
          taskName: entry.name,
          total,
          completed,
          uncheckedSteps,
        });
      }
    }
  } catch {
    // spec-task 目录不存在或不可读
  }

  return results;
}

/**
 * 生成 system-reminder 提醒文本。
 */
function buildReminderText(checklists: ChecklistInfo[]): string {
  const parts: string[] = [];

  for (const cl of checklists) {
    const stepsPreview = cl.uncheckedSteps.slice(0, 10).join(", ");
    const suffix = cl.uncheckedSteps.length > 10 ? `... (共 ${cl.uncheckedSteps.length} 项)` : "";
    parts.push(`📋 ${cl.taskName}: ${cl.completed}/${cl.total} 步完成（${Math.round((cl.completed / cl.total) * 100)}%）。未完成：${stepsPreview}${suffix}`);
  }

  return `\n---\n<system-reminder>\nChecklist 进度提醒：\n${parts.join("\n")}\n每完成一个步骤后，必须调用 checklist_update(task_dir, step_number, checked=true) 打勾。\n不要向用户提及此提醒。\n</system-reminder>`;
}

interface PluginLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

/**
 * 创建 tool_result_persist hook 处理器。
 *
 * 在每次工具调用结果写入 session 前，检测当前会话关联的工作区中
 * 是否存在未完成的 checklist 步骤，如果存在则在 content 末尾追加提醒文本。
 *
 * ⚠️ 此 hook 是同步的——handler 不能返回 Promise。
 *
 * @param workspaceDirMap  闭包 Map（sessionKey/agentId → workspaceDir），
 *                         由 before_prompt_build hook 填充。
 * @param normalizeKey     大小写不敏感的键规范化函数。
 * @param logger           插件日志器。
 * @param fileUtils        文件工具实例（可选，便于测试注入）。
 */
export function createToolResultReminderHandler(
  workspaceDirMap: Map<string, string>,
  normalizeKey: (key: string | undefined) => string | undefined,
  logger: PluginLogger
) {
  // 同步 handler——tool_result_persist 是同步 hook，返回 Promise 会被忽略
  return (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const toolName = event.toolName as string | undefined;
    const message = event.message as Record<string, unknown> | undefined;

    // 条件 4 & 5：跳过 checklist_update 和 checklist_status 工具调用
    if (toolName && SKIP_TOOLS.has(toolName)) {
      return;
    }

    // 条件 1 & 2：通过 sessionKey 或 agentId 定位工作区
    const sessionKey = (ctx.sessionKey ?? event.sessionKey) as string | undefined;
    const agentId = (ctx.agentId ?? event.agentId) as string | undefined;

    const workspaceDir =
      (sessionKey && workspaceDirMap.get(normalizeKey(sessionKey)!)) ||
      (agentId && workspaceDirMap.get(normalizeKey(agentId)!));

    if (!workspaceDir) {
      return;
    }

    // 条件 3：扫描 checklist 并检测未完成项（同步）
    const checklists = scanChecklistsSync(workspaceDir);
    if (checklists.length === 0) {
      return;
    }

    // 生成提醒文本
    const reminderText = buildReminderText(checklists);

    // 修改 AgentMessage：在 content 数组末尾追加 TextContent
    if (message && Array.isArray(message.content)) {
      const modifiedMessage = {
        ...message,
        content: [
          ...message.content,
          { type: "text", text: reminderText },
        ],
      };

      logger.info(`[spec-task] tool_result_persist: injected reminder for ${checklists.length} checklist(s) after ${toolName ?? "unknown"} tool call`);

      return { message: modifiedMessage };
    }

    // message 结构不符合预期，跳过
    return;
  };
}
