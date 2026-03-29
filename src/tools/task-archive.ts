import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { join, basename } from "path";
import type { TaskArchiveParams, TaskStatusData } from "../types.js";
import { SPEC_TASK_ERRORS } from "../types.js";
import { StatusStore } from "../core/status-store.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const TaskArchiveParamsSchema = {
  type: "object",
  required: ["task_dir"],
  properties: {
    task_dir: { type: "string", description: "Task directory path (required)" },
    agent_workspace: { type: "string" },
    project_root: { type: "string" },
    agent_name: { type: "string" },
    dry_run: { type: "boolean", description: "Preview only" },
  },
};

interface ArchiveAction {
  action: string;
  file: string;
  status: string;
}

/**
 * 读取 brief.md 文件内容（用于归档标题）。
 */
async function readBrief(taskDir: string): Promise<string> {
  try {
    const content = await readFile(join(taskDir, "brief.md"), "utf-8");
    return content.trim().split("\n")[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * 生成历史记录文件内容。
 */
function buildHistoryContent(data: TaskStatusData, brief: string, agentName: string): string {
  const lines: string[] = [];
  lines.push(`# ${brief || data.title}`);
  lines.push("");
  lines.push(`- **Task ID**: ${data.task_id}`);
  lines.push(`- **Status**: ${data.status}`);
  lines.push(`- **Assigned To**: ${data.assigned_to}`);
  lines.push(`- **Created**: ${data.created}`);
  lines.push(`- **Updated**: ${data.updated}`);
  lines.push(`- **Completed**: ${data.completed_at ?? "N/A"}`);
  lines.push(`- **Agent**: ${agentName}`);
  lines.push("");

  if (data.progress.total > 0) {
    lines.push("## Progress");
    lines.push("");
    lines.push(`- Total: ${data.progress.total}`);
    lines.push(`- Completed: ${data.progress.completed}`);
    lines.push(`- Percentage: ${data.progress.percentage}%`);
    lines.push("");
  }

  if (data.outputs.length > 0) {
    lines.push("## Outputs");
    lines.push("");
    for (const output of data.outputs) {
      lines.push(`- ${output}`);
    }
    lines.push("");
  }

  if (data.errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const err of data.errors) {
      lines.push(`- [${err.step}] ${err.message} (retry#${err.retry_count}, ${err.timestamp})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 生成经验教训文件内容。
 */
function buildLessonsContent(data: TaskStatusData, brief: string): string {
  const lines: string[] = [];
  lines.push(`# Lessons: ${brief || data.title}`);
  lines.push("");
  lines.push(`- **Task ID**: ${data.task_id}`);
  lines.push(`- **Status**: ${data.status}`);
  lines.push("");

  if (data.errors.length > 0) {
    lines.push("## Errors Encountered");
    lines.push("");
    for (const err of data.errors) {
      lines.push(`- [${err.step}] ${err.message}`);
    }
    lines.push("");
  }

  if (data.blocked_by.length > 0) {
    lines.push("## Blockers");
    lines.push("");
    for (const block of data.blocked_by) {
      lines.push(`- ${block.task}: ${block.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function executeTaskArchive(
  _id: string,
  params: TaskArchiveParams
): Promise<ToolResponse> {
  const {
    task_dir,
    agent_workspace = process.cwd(),
    project_root = process.cwd(),
    agent_name = "agent",
    dry_run = false,
  } = params;

  const store = new StatusStore();

  let data: TaskStatusData;
  try {
    data = await store.loadStatus(task_dir);
  } catch {
    return formatError(
      SPEC_TASK_ERRORS.TASK_NOT_FOUND,
      `Task not found at ${task_dir}`,
    );
  }

  const taskName = basename(task_dir);
  const brief = await readBrief(task_dir);
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // 历史文件路径
  const historyDir = join(agent_workspace, "memory", "task-history", date);
  const historyFile = join(historyDir, `${taskName}.md`);

  // 经验教训文件路径
  const lessonsDir = join(agent_workspace, "memory", "task-lessons");
  const lessonsFile = join(lessonsDir, `${taskName}.md`);

  // dry_run 模式：只返回计划，不写入
  if (dry_run) {
    return formatResult({
      success: true,
      dry_run: true,
      results: [
        { action: "create", file: historyFile, status: "planned" },
        { action: "create_or_append", file: lessonsFile, status: "planned" },
      ],
    });
  }

  const actions: ArchiveAction[] = [];

  // 写入历史文件（如果已存在则跳过）
  try {
    await stat(historyFile);
    actions.push({ action: "skip", file: historyFile, status: "already_exists" });
  } catch {
    await mkdir(historyDir, { recursive: true });
    const historyContent = buildHistoryContent(data, brief, agent_name);
    await writeFile(historyFile, historyContent, "utf-8");
    actions.push({ action: "create", file: historyFile, status: "created" });
  }

  // 写入/追加经验教训文件
  const lessonsContent = buildLessonsContent(data, brief);
  try {
    const existing = await readFile(lessonsFile, "utf-8");
    await writeFile(lessonsFile, existing + "\n---\n\n" + lessonsContent, "utf-8");
    actions.push({ action: "append", file: lessonsFile, status: "appended" });
  } catch {
    await mkdir(lessonsDir, { recursive: true });
    await writeFile(lessonsFile, lessonsContent, "utf-8");
    actions.push({ action: "create", file: lessonsFile, status: "created" });
  }

  return formatResult({
    success: true,
    dry_run: false,
    results: actions,
  });
}
