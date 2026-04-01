import { readFile, stat } from "fs/promises";
import { join, dirname } from "path";
import YAML from "yaml";
import type {
  SchemaArtifact,
  ArtifactState,
  ArtifactStatus,
  ArtifactInstructions,
  SchemaStatusResult,
} from "../types.js";

/**
 * 从 spec-task 目录推断 schema.yaml 的路径。
 * 仅从 taskDir 推断，不做跨目录 fallback。
 * 跨目录发现由调用方（hook/tool）通过显式传入 schemaPath 处理。
 */
async function resolveSchemaPath(taskDir: string): Promise<string | null> {
  const parts = taskDir.split(/[/\\]/);
  const specTaskIdx = parts.lastIndexOf("spec-task");
  if (specTaskIdx === -1) return null;
  const candidate = join(parts.slice(0, specTaskIdx + 1).join("/"), "schemas", "agent-task", "schema.yaml");
  if ((await safeStat(candidate))?.isFile()) return candidate;
  return null;
}

/**
 * 推断 schemas/agent-task/ 目录的路径（用于读取 templates 等）。
 * 仅从 taskDir 推断，不做跨目录 fallback。
 */
async function resolveSchemaDir(taskDir: string): Promise<string | null> {
  const parts = taskDir.split(/[/\\]/);
  const specTaskIdx = parts.lastIndexOf("spec-task");
  if (specTaskIdx === -1) return null;
  const candidate = join(parts.slice(0, specTaskIdx + 1).join("/"), "schemas", "agent-task");
  if ((await safeStat(candidate))?.isDirectory()) return candidate;
  return null;
}

/**
 * 搜索插件安装目录中的 schema.yaml。
 * 用于 extensions 环境（openclaw 加载插件时，schema.yaml 不在 workspace 下）。
 */
function getExtensionsSchemaPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/root";
  const openclawDir = process.env.OPENCLAW_STATE_DIR || join(homeDir, ".openclaw");
  return join(openclawDir, "extensions", "spec-task", "skills", "spec-task", "schemas", "agent-task", "schema.yaml");
}

/** 从 taskDir 推断任务根目录 */
function resolveTaskRoot(taskDir: string): string {
  const parts = taskDir.split(/[/\\]/);
  // taskDir 可能是 .../spec-task/<task-name>/runs/001 或 .../spec-task/<task-name>
  const runsIdx = parts.lastIndexOf("runs");
  if (runsIdx !== -1) {
    return parts.slice(0, runsIdx).join("/");
  }
  return taskDir;
}

async function safeStat(path: string): Promise<import("fs").Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

export class SchemaReader {
  private schemaPath: string | null = null;
  private schemaDir: string | null = null;
  private taskDir: string | null = null;
  private artifacts: SchemaArtifact[] = [];
  private dagValid = false;

  /**
   * 创建 SchemaReader 实例。
   * @param schemaPath schema.yaml 的绝对路径。如果为 null，会从 taskDir 推断。
   * @param taskDir 任务 run 目录的绝对路径（用于推断 schema 路径和任务根目录）
   */
  constructor(schemaPath: string | null, taskDir?: string) {
    if (schemaPath) {
      this.schemaPath = schemaPath;
      this.schemaDir = dirname(schemaPath);
    }
    this.taskDir = taskDir ?? null;
  }

  /** 解析 schema.yaml，构建 DAG */
  async parse(): Promise<SchemaArtifact[]> {
    // 如果没有显式指定 schemaPath，从 taskDir 推断
    if (!this.schemaPath && this.taskDir) {
      const resolved = await resolveSchemaPath(this.taskDir);
      if (resolved) {
        this.schemaPath = resolved;
        this.schemaDir = dirname(resolved);
      } else {
        // taskDir 中有 spec-task 路径段但 schema.yaml 不存在
        // 仅在 taskDir 位于 ~/.openclaw/ 下时（即真实 openclaw 运行环境）才尝试 extensions 目录
        // 避免在开发/测试环境（/tmp/xxx/spec-task/...）中意外匹配
        const homeDir = process.env.HOME || process.env.USERPROFILE || "/root";
        const openclawDir = process.env.OPENCLAW_STATE_DIR || join(homeDir, ".openclaw");
        if (this.taskDir.startsWith(openclawDir)) {
          const extPath = getExtensionsSchemaPath();
          if ((await safeStat(extPath))?.isFile()) {
            this.schemaPath = extPath;
            this.schemaDir = dirname(extPath);
          }
        }
      }
    }

    if (!this.schemaPath) {
      this.artifacts = [];
      return [];
    }

    const content = await safeReadFile(this.schemaPath);
    if (!content) {
      this.artifacts = [];
      return [];
    }

    try {
      const data = YAML.parse(content);
      if (!data || !Array.isArray(data.artifacts)) {
        this.artifacts = [];
        return [];
      }
      this.artifacts = data.artifacts.map((a: Record<string, unknown>) => ({
        id: String(a.id ?? ""),
        generates: String(a.generates ?? ""),
        description: String(a.description ?? ""),
        template: String(a.template ?? ""),
        instruction: String(a.instruction ?? ""),
        requires: Array.isArray(a.requires) ? a.requires.map(String) : [],
      }));
      this.dagValid = true;
      return this.artifacts;
    } catch {
      this.artifacts = [];
      return [];
    }
  }

  /** 确保已解析 */
  private async ensureParsed(): Promise<void> {
    if (!this.dagValid) {
      await this.parse();
    }
  }

  /** 查询单个构件信息 */
  getArtifact(id: string): SchemaArtifact | null {
    return this.artifacts.find(a => a.id === id) ?? null;
  }

  /** 获取所有有效 artifact ID 列表 */
  getArtifactIds(): string[] {
    return this.artifacts.map(a => a.id);
  }

  /**
   * 推断所有构件的状态（核心方法，等价于 openspec status --json）
   * @param taskRoot 任务根目录（包含 brief.md、plan.md 等）
   * @param stepsData 可选，status.yaml 中的 steps 数组（用于判断 steps 构件状态）
   */
  async getStatus(taskRoot: string, stepsData?: unknown[]): Promise<SchemaStatusResult> {
    await this.ensureParsed();
    if (this.artifacts.length === 0) {
      return { artifacts: [], nextReady: [], completed: [], hasCycle: false };
    }

    // 检查循环依赖
    const hasCycle = this.detectCycle();
    if (hasCycle) {
      return { artifacts: [], nextReady: [], completed: [], hasCycle: true };
    }

    // 推断每个构件状态
    const statusMap = new Map<string, ArtifactState>();
    const statuses: ArtifactStatus[] = [];

    for (const artifact of this.artifacts) {
      // 普通构件：检查文件是否存在
      const filePath = join(taskRoot, artifact.generates);
      const fileStat = await safeStat(filePath);
      if (fileStat) {
        statusMap.set(artifact.id, "done");
      } else {
        statusMap.set(artifact.id, "ready");
      }

      statuses.push({
        id: artifact.id,
        state: statusMap.get(artifact.id)!,
        generates: artifact.generates,
      });
    }

    // 修正 blocked 状态：如果依赖未满足，从 ready 改为 blocked
    for (const artifact of this.artifacts) {
      if (statusMap.get(artifact.id) === "done") continue;
      const allDepsDone = artifact.requires.every(dep => statusMap.get(dep) === "done");
      if (!allDepsDone) {
        statusMap.set(artifact.id, "blocked");
        // 更新 statuses 数组
        const entry = statuses.find(s => s.id === artifact.id);
        if (entry) entry.state = "blocked";
      }
    }

    const completed = statuses.filter(s => s.state === "done").map(s => s.id);
    const nextReady = statuses.filter(s => s.state === "ready").map(s => s.id);

    return { artifacts: statuses, nextReady, completed, hasCycle: false };
  }

  /** 获取下一个就绪的构件（按拓扑序） */
  getNextReady(statusResult: SchemaStatusResult): string[] {
    return statusResult.nextReady;
  }

  /**
   * 获取指定构件的完整指导（等价于 openspec instructions <id> --json）
   */
  async getInstructions(
    artifactId: string,
    taskRoot: string,
    stepsData?: unknown[],
  ): Promise<ArtifactInstructions | null> {
    await this.ensureParsed();
    const artifact = this.getArtifact(artifactId);
    if (!artifact) return null;

    // 读取 config.yaml 的 context 和 rules
    const specTaskDir = this.findSpecTaskDir(taskRoot);
    const actualConfigPath = specTaskDir ? join(specTaskDir, "config.yaml") : null;
    const configContent = actualConfigPath ? await safeReadFile(actualConfigPath) : null;
    let context = "";
    let rules: string[] = [];

    if (configContent) {
      try {
        const configData = YAML.parse(configContent);
        context = String(configData.context ?? "");
        const rulesObj = configData.rules;
        if (rulesObj && typeof rulesObj === "object" && !Array.isArray(rulesObj)) {
          const artifactRules = rulesObj[artifactId];
          if (Array.isArray(artifactRules)) {
            rules = artifactRules.map(String);
          }
        }
      } catch {
        // 静默忽略
      }
    }

    // 读取依赖构件的内容
    const deps: ArtifactInstructions["dependencies"] = [];
    for (const depId of artifact.requires) {
      const depArtifact = this.getArtifact(depId);
      if (!depArtifact) {
        deps.push({ id: depId, done: false, content: null });
        continue;
      }
      const depPath = join(taskRoot, depArtifact.generates);
      const depContent = await safeReadFile(depPath);
      deps.push({
        id: depId,
        done: depContent !== null,
        content: depContent,
      });
    }

    // 读取模板内容
    let template = "";
    // 优先从 schemaDir（可能已在 parse 中解析）读取模板
    if (this.schemaDir) {
      const templatePath = join(this.schemaDir, "templates", artifact.template);
      template = (await safeReadFile(templatePath)) ?? "";
    }
    // fallback: 从 taskDir 推断
    if (!template && specTaskDir) {
      const templatePath = join(specTaskDir, "schemas", "agent-task", "templates", artifact.template);
      template = (await safeReadFile(templatePath)) ?? "";
    }

    // 模板缺失时从 instruction 提取 fallback
    if (!template && artifact.instruction) {
      const codeBlockMatch = artifact.instruction.match(/```[\s\S]*?\n([\s\S]*?)```/);
      template = codeBlockMatch ? codeBlockMatch[1].trimEnd() : artifact.instruction;
    }

    return {
      artifact_id: artifactId,
      instruction: artifact.instruction,
      template,
      context,
      rules,
      dependencies: deps,
    };
  }

  /** 读取 config.yaml 的 context */
  async getContext(taskRoot: string): Promise<string> {
    const specTaskDir = this.findSpecTaskDir(taskRoot);
    if (!specTaskDir) return "";
    const configContent = await safeReadFile(join(specTaskDir, "config.yaml"));
    if (!configContent) return "";
    try {
      const configData = YAML.parse(configContent);
      return String(configData.context ?? "");
    } catch {
      return "";
    }
  }

  /** 读取 config.yaml 的指定构件 rules */
  async getRules(artifactId: string, taskRoot: string): Promise<string[]> {
    const specTaskDir = this.findSpecTaskDir(taskRoot);
    if (!specTaskDir) return [];
    const configContent = await safeReadFile(join(specTaskDir, "config.yaml"));
    if (!configContent) return [];
    try {
      const configData = YAML.parse(configContent);
      const rulesObj = configData.rules;
      if (rulesObj && typeof rulesObj === "object" && !Array.isArray(rulesObj)) {
        const artifactRules = rulesObj[artifactId];
        if (Array.isArray(artifactRules)) {
          return artifactRules.map(String);
        }
      }
      return [];
    } catch {
      return [];
    }
  }

  /** 检测循环依赖 */
  private detectCycle(): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (node: string): boolean => {
      visited.add(node);
      recursionStack.add(node);

      const artifact = this.artifacts.find(a => a.id === node);
      if (!artifact) return false;

      for (const dep of artifact.requires) {
        if (!visited.has(dep)) {
          if (dfs(dep)) return true;
        } else if (recursionStack.has(dep)) {
          return true;
        }
      }

      recursionStack.delete(node);
      return false;
    };

    for (const artifact of this.artifacts) {
      if (!visited.has(artifact.id)) {
        if (dfs(artifact.id)) return true;
      }
    }

    return false;
  }

  /** 从 taskRoot 向上查找 spec-task/ 目录 */
  private findSpecTaskDir(taskRoot: string): string | null {
    const parts = taskRoot.split(/[/\\]/);
    const idx = parts.lastIndexOf("spec-task");
    if (idx === -1) return null;
    return parts.slice(0, idx + 1).join("/");
  }
}
