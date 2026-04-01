import { readdir } from "fs/promises";
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import YAML from "yaml";
import { TERMINAL_STATUSES } from "../types.js";

/**
 * Get the next run ID for a task directory.
 * Scans runs/ subdirectory for existing run folders (001, 002, ...).
 * Returns "001" if no runs exist or runs/ doesn't exist.
 */
export async function getNextRunId(taskDir: string): Promise<string> {
  const runsDir = join(taskDir, "runs");
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    const runDirs = entries
      .filter(e => e.isDirectory() && /^\d{3}$/.test(e.name))
      .map(e => parseInt(e.name, 10))
      .sort((a, b) => a - b);

    if (runDirs.length === 0) return "001";
    const maxId = runDirs[runDirs.length - 1];
    return String(maxId + 1).padStart(3, "0");
  } catch {
    return "001";
  }
}

/**
 * Check if a task has any active (non-terminal) runs.
 * Returns array of active run IDs.
 */
export async function getActiveRuns(taskDir: string): Promise<string[]> {
  const runsDir = join(taskDir, "runs");

  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    const activeRuns: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{3}$/.test(entry.name)) continue;

      const statusPath = join(runsDir, entry.name, "status.yaml");
      try {
        const content = await readFile(statusPath, "utf-8");
        const data = YAML.parse(content);
        if (data && !TERMINAL_STATUSES.has(data.status)) {
          activeRuns.push(entry.name);
        }
      } catch {
        // status.yaml doesn't exist or can't be parsed, skip
      }
    }

    return activeRuns;
  } catch {
    return [];
  }
}

/**
 * Resolve the run directory path.
 */
export function resolveRunDir(taskName: string, runId: string, projectRoot: string): string {
  return resolve(join(projectRoot, "spec-task", taskName, "runs", runId));
}

/**
 * Resolve the task root directory path.
 */
export function resolveTaskRoot(taskName: string, projectRoot: string): string {
  return resolve(join(projectRoot, "spec-task", taskName));
}
