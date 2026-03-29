import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { TaskRecallParams } from "../types.js";
import { formatResult, formatError, type ToolResponse } from "../tool-utils.js";

export const TaskRecallParamsSchema = {
  type: "object",
  required: ["keywords"],
  properties: {
    keywords: { type: "string", description: "Search keywords (required)" },
    project_root: { type: "string" },
    agent_workspace: { type: "string" },
    top: { type: "number", description: "Max results (default: 5)" },
  },
};

/** 常见英文停用词集合 */
export const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "been", "has", "have", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "not", "no", "nor", "so",
  "if", "then", "than", "that", "this", "these", "those", "am",
]);

interface SearchResult {
  file: string;
  score: number;
  snippet: string;
}

/**
 * 从关键词中过滤停用词，返回有效搜索词列表。
 * 支持拆分 kebab-case、snake_case、CamelCase 命名格式（等价于 v1.0）。
 */
function filterStopWords(keywords: string): string[] {
  // 拆分各种命名格式：kebab-case、snake_case、CamelCase、空格/分隔符
  const raw = keywords
    .replace(/[-_\s]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return raw.filter((w) => !STOP_WORDS.has(w) && w.length > 0);
}

/**
 * 从文件内容中提取包含关键词的片段（前后各 60 字符）。
 */
function extractSnippet(content: string, terms: string[], maxLen = 200): string {
  const lowerContent = content.toLowerCase();
  let bestIdx = -1;

  // 找到第一个匹配的位置
  for (const term of terms) {
    const idx = lowerContent.indexOf(term);
    if (idx !== -1) {
      bestIdx = idx;
      break;
    }
  }

  if (bestIdx === -1) {
    return content.slice(0, maxLen);
  }

  const start = Math.max(0, bestIdx - 60);
  const end = Math.min(content.length, start + maxLen);
  let snippet = content.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  return snippet;
}

/**
 * 递归搜索目录下所有 .md 文件。
 */
async function findMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await findMdFiles(fullPath)));
      } else if (entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch {
    // 目录不存在，忽略
  }
  return results;
}

export async function executeTaskRecall(
  _id: string,
  params: TaskRecallParams
): Promise<ToolResponse> {
  const {
    keywords,
    agent_workspace = process.cwd(),
    top = 5,
  } = params;

  if (!keywords || keywords.trim() === "") {
    return formatError("INVALID_PARAMS", "keywords is required");
  }

  const terms = filterStopWords(keywords);
  if (terms.length === 0) {
    return formatResult({
      success: true,
      keywords: [],
      total_matches: 0,
      results: [],
    });
  }

  // 搜索 task-history 和 task-lessons 目录
  const searchDirs = [
    join(agent_workspace, "memory", "task-history"),
    join(agent_workspace, "memory", "task-lessons"),
  ];

  const allFiles = new Map<string, string>();
  for (const dir of searchDirs) {
    const files = await findMdFiles(dir);
    for (const file of files) {
      if (!allFiles.has(file)) {
        allFiles.set(file, file);
      }
    }
  }

  // 评分
  const scored: SearchResult[] = [];
  for (const filePath of allFiles.keys()) {
    try {
      const content = await readFile(filePath, "utf-8");
      const fileName = filePath.split("/").pop() ?? filePath;
      const fileNameLower = fileName.toLowerCase();
      const contentLower = content.toLowerCase();

      let score = 0;
      for (const term of terms) {
        // 内容中出现的次数
        let idx = 0;
        let count = 0;
        while ((idx = contentLower.indexOf(term, idx)) !== -1) {
          count++;
          idx += term.length;
        }
        score += count;

        // 文件名匹配权重 ×3
        if (fileNameLower.includes(term)) {
          score += 3;
        }
      }

      if (score > 0) {
        const snippet = extractSnippet(content, terms);
        scored.push({ file: filePath, score, snippet });
      }
    } catch {
      // 读取失败，跳过
    }
  }

  // 按分数降序排列，取 top N
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, top);

  return formatResult({
    success: true,
    keywords: terms,
    total_matches: scored.length,
    results,
  });
}
