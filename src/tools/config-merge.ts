import YAML from "yaml";
import type { ConfigMergeParams } from "../types.js";
import { SPEC_TASK_ERRORS } from "../types.js";
import { FileUtils } from "../file-utils.js";
import { ConfigManager } from "../core/config.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const ConfigMergeParamsSchema = {
  type: "object",
  properties: {
    project_root: { type: "string", description: "Project root directory (default: cwd)" },
    format: { type: "string", enum: ["json", "yaml"], description: "Output format (default: json)" },
  },
};

export async function executeConfigMerge(
  _id: string,
  params: ConfigMergeParams
): Promise<ToolResponse> {
  const {
    project_root = process.cwd(),
    format = "json",
  } = params;

  if (format !== "json" && format !== "yaml") {
    return formatError(SPEC_TASK_ERRORS.CONFIG_NOT_FOUND, `Unsupported format: ${format}`);
  }

  // 防御：验证 project_root 是 agent workspace 而非项目根目录
  const fu = new FileUtils();
  const wsCheck = await fu.validateWorkspacePath(project_root);
  if (!wsCheck.valid) {
    return formatError(SPEC_TASK_ERRORS.CONFIG_NOT_FOUND, `Invalid project_root: ${wsCheck.reason}`);
  }

  try {
    const cm = new ConfigManager();
    const mergedConfig = await cm.loadMergedConfig(project_root);

    const payload = { success: true, config: mergedConfig };

    if (format === "yaml") {
      return formatResult({ ...payload, format: "yaml", config_yaml: YAML.stringify(mergedConfig) });
    }

    return formatResult(payload);
  } catch (e) {
    return formatError(
      SPEC_TASK_ERRORS.CONFIG_NOT_FOUND,
      e instanceof Error ? e.message : String(e),
    );
  }
}
