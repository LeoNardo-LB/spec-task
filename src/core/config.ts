import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import YAML from "yaml";
import type { SpecTaskConfig } from "../types.js";
import { CONTEXT_FILES } from "../types.js";

export class ConfigManager {
  /**
   * 深度合并两个配置（list 整体替换，dict 递归合并）。
   * 等价于 v1.0 的 deep_merge()。
   */
  deepMerge(base: SpecTaskConfig, override: Partial<SpecTaskConfig>): SpecTaskConfig {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (
        key in result &&
        typeof result[key] === "object" &&
        result[key] !== null &&
        !Array.isArray(result[key]) &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        result[key] = this.deepMerge(
          result[key] as SpecTaskConfig,
          value as Partial<SpecTaskConfig>
        );
      } else {
        result[key] = value;
      }
    }
    return result as SpecTaskConfig;
  }

  /**
   * 从项目身份文件提取 context（首段 ≤200 字符）。
   * 等价于 v1.0 的 _extract_context()。
   */
  async extractContext(projectRoot: string): Promise<string> {
    for (const filename of CONTEXT_FILES) {
      const filepath = join(projectRoot, filename);
      try {
        await stat(filepath);
      } catch {
        continue;
      }

      try {
        const content = (await readFile(filepath, "utf-8")).trim();
        const lines = content.split("\n");
        const paragraphLines: string[] = [];

        for (const line of lines) {
          const stripped = line.trim();
          // Skip empty lines, markdown headers, and HTML comments
          if (!stripped || stripped.startsWith("#") || stripped.startsWith("<!--")) {
            continue;
          }
          paragraphLines.push(stripped);
          if (paragraphLines.join("\n").length >= 200) {
            break;
          }
        }

        if (paragraphLines.length > 0) {
          let text = paragraphLines.join("\n");
          if (text.length > 200) {
            text = text.slice(0, 197) + "...";
          }
          return text;
        }
      } catch {
        // 静默跳过任何读取异常
        continue;
      }
    }
    return "";
  }

  /**
   * 确保项目级 spec-task/config.yaml 存在且包含所有默认字段。
   * 如果文件已存在但缺少字段（如 runtime/archive），会深度合并补全。
   */
  async ensureProjectConfig(
    projectRoot: string,
    defaultConfig: SpecTaskConfig
  ): Promise<void> {
    const projectConfigPath = join(projectRoot, "spec-task", "config.yaml");

    // 从身份文件提取 context
    const context = await this.extractContext(projectRoot);
    const mergedDefault: SpecTaskConfig = { ...defaultConfig };
    if (context) {
      mergedDefault.context = context;
    }

    try {
      const exists = await stat(projectConfigPath);
      if (exists) {
        // 已存在：读取并深度合并，补全缺失字段
        try {
          const existingContent = await readFile(projectConfigPath, "utf-8");
          const existingConfig = (YAML.parse(existingContent) as SpecTaskConfig) ?? {};
          const merged = this.deepMerge(mergedDefault, existingConfig);
          // 仅当合并结果与原文件不同时才写入（避免无意义的文件更新）
          const newContent = YAML.stringify(merged);
          if (existingContent.trim() !== newContent.trim()) {
            await writeFile(projectConfigPath, newContent, "utf-8");
          }
        } catch {
          // YAML 解析失败，用默认值重写
          const dir = join(projectRoot, "spec-task");
          await mkdir(dir, { recursive: true });
          await writeFile(projectConfigPath, YAML.stringify(mergedDefault), "utf-8");
        }
        return;
      }
    } catch {
      // 不存在，继续生成
    }

    // 写入新配置
    const dir = join(projectRoot, "spec-task");
    await mkdir(dir, { recursive: true });
    await writeFile(projectConfigPath, YAML.stringify(mergedDefault), "utf-8");
  }

  /**
   * 获取默认配置文件路径。
   * 默认配置从插件内置 skills/spec-task/config.yaml 自动加载。
   * 从 src/core/ 上溯两级到插件根目录，再进入 skills/spec-task/。
   */
  getDefaultConfigPath(): string {
    return join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "..", "skills", "spec-task", "config.yaml"
    );
  }

  /**
   * 加载合并后的配置。
   * 等价于 v1.0 的 load_merged_config()。
   * 默认配置从插件内置 skills/spec-task/config.yaml 自动加载。
   */
  async loadMergedConfig(projectRoot: string): Promise<SpecTaskConfig> {
    let defaultConfig: SpecTaskConfig = {};
    try {
      const defaultConfigPath = this.getDefaultConfigPath();
      const content = await readFile(defaultConfigPath, "utf-8");
      defaultConfig = (YAML.parse(content) as SpecTaskConfig) ?? {};
    } catch {
      // 默认配置文件不存在，使用空配置
      defaultConfig = {
        runtime: {
          allow_agent_self_delegation: true,
          task_timeout: 60,
        },
        archive: {
          record_history: true,
          generate_lessons: true,
          auto_archive: false,
        },
      };
    }

    await this.ensureProjectConfig(projectRoot, defaultConfig);

    const projectConfigPath = join(projectRoot, "spec-task", "config.yaml");
    let projectConfig: SpecTaskConfig = {};
    try {
      const content = await readFile(projectConfigPath, "utf-8");
      projectConfig = YAML.parse(content) ?? {};
    } catch {
      // YAML 解析失败，使用默认配置
      return { ...defaultConfig };
    }

    return this.deepMerge(defaultConfig, projectConfig);
  }
}
