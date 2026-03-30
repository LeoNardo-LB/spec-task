import { mkdir, readFile, stat } from "fs/promises";
import { join, resolve, basename } from "path";

/**
 * Agent workspace 目录的特征文件。
 * 用于验证一个路径是否是有效的 agent workspace（而非项目根目录）。
 */
const AGENT_WORKSPACE_MARKERS = [
  "IDENTITY.md",
  "AGENTS.md",
  "SOUL.md",
] as const;

/**
 * 项目根目录的特征文件/目录（如果存在这些，说明路径是项目根而非 agent workspace）。
 */
const PROJECT_ROOT_MARKERS = [
  "agents",
  "config",
  "package.json",
] as const;

export class FileUtils {
  /**
   * 安全创建目录（递归，已存在时不报错）。
   */
  async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /**
   * 安全读取文件，不存在时返回 null 而不是抛错。
   */
  async safeReadFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 安全的 stat，文件不存在时返回 null 而不是抛错。
   */
  async safeStat(path: string): Promise<import("fs").Stats | null> {
    try {
      return await stat(path);
    } catch {
      return null;
    }
  }

  /**
   * 解析任务目录路径。
   * 输入 task_name + project_root，输出 {project_root}/spec-task/{task_name}/ 绝对路径。
   */
  resolveTaskDir(taskName: string, projectRoot: string): string {
    return resolve(join(projectRoot, "spec-task", taskName));
  }

  /**
   * 验证路径是否看起来像一个 agent workspace 目录。
   *
   * 判断逻辑：
   * 1. 如果路径中包含 "/agents/" 段，很可能是 agent workspace
   * 2. 如果路径下存在 AGENT_WORKSPACE_MARKERS 中的文件，很可能是 agent workspace
   * 3. 如果路径下存在 PROJECT_ROOT_MARKERS，可能是项目根目录（非 agent workspace）
   *
   * @returns `{ valid: true }` 或 `{ valid: false, reason: string }`
   */
  async validateWorkspacePath(dir: string): Promise<{ valid: true } | { valid: false; reason: string }> {
    const resolved = resolve(dir);

    // 启发式 1：路径中包含 /agents/ 段（如 /workspaces/project/agents/agent-name/）
    const parts = resolved.split("/");
    const agentsIdx = parts.indexOf("agents");
    if (agentsIdx !== -1 && agentsIdx < parts.length - 1) {
      // /agents/ 后面至少还有一段（agent 名称）
      return { valid: true };
    }

    // 启发式 2：路径下存在 agent workspace 特征文件
    for (const marker of AGENT_WORKSPACE_MARKERS) {
      const markerPath = join(resolved, marker);
      const markerStat = await this.safeStat(markerPath);
      if (markerStat && markerStat.isFile()) {
        return { valid: true };
      }
    }

    // 启发式 3：路径名本身是 agent 名（如 coordinator, capital-flow-analyst）
    const dirName = basename(resolved);
    const hasAgentSuffix = /analyst|coordinator|validator|evaluator|officer|adjudicator|agent/i.test(dirName);
    if (hasAgentSuffix) {
      return { valid: true };
    }

    // 启发式 4：检查是否看起来像项目根目录
    let projectRootMarkers = 0;
    for (const marker of PROJECT_ROOT_MARKERS) {
      const markerPath = join(resolved, marker);
      const markerStat = await this.safeStat(markerPath);
      if (markerStat) projectRootMarkers++;
    }
    if (projectRootMarkers >= 2) {
      return {
        valid: false,
        reason: `Path "${resolved}" appears to be a project root (found project-level markers). spec-task directories must be created inside agent workspace directories (e.g., /workspaces/project/agents/agent-name/), not at the project root. Current cwd="${process.cwd()}"`,
      };
    }

    // 既无法确认也无法否认，给出警告但不阻止
    return { valid: true };
  }
}
