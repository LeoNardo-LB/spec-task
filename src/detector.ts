import { readdir, stat, readFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { TERMINAL_STATUSES } from "./types.js";
import type { DetectorResult, SkeletonTask, ArtifactName } from "./types.js";

async function safeStat(path: string): Promise<import("fs").Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export class Detector {
  /**
   * 扫描工作区 spec-task 目录，检测任务状态并分类。
   *
   * L1 none:      spec-task/ 目录不存在
   * L2 empty:     目录存在但无任务子目录
    * L3 skeleton:  有 status.yaml 但缺 brief/spec/plan
   * L4 in_progress: 有非终态任务且文档完整
   * L5 all_done:  所有任务都是终态
   */
  async detect(workspaceDir: string, requiredArtifacts?: readonly ArtifactName[]): Promise<DetectorResult> {
    const required: readonly ArtifactName[] = requiredArtifacts ?? ["brief"];
    const specTaskDir = join(workspaceDir, "spec-task");

    // L1: 目录不存在
    const dirStat = await safeStat(specTaskDir);
    if (!dirStat || !dirStat.isDirectory()) {
      return { level: "none", spec_task_dir: null, skeleton_tasks: [], incomplete_tasks: [] };
    }

    // 扫描子目录
    let entries: string[];
    try {
      entries = await readdir(specTaskDir);
    } catch {
      return { level: "none", spec_task_dir: specTaskDir, skeleton_tasks: [], incomplete_tasks: [] };
    }

    const taskDirs = entries.filter(e => {
      if (e.startsWith(".")) return false;
      if (e === "config.yaml") return false;
      return true;
    });

    // L2: 空目录
    if (taskDirs.length === 0) {
      return { level: "empty", spec_task_dir: specTaskDir, skeleton_tasks: [], incomplete_tasks: [] };
    }

    const skeletonTasks: SkeletonTask[] = [];
    const incompleteTasks: Array<{ name: string; status: import("./types.js").TaskStatus }> = [];

    for (const taskName of taskDirs) {
      const taskDir = join(specTaskDir, taskName);

      // Check for runs/ subdirectory
      const runsDir = join(taskDir, "runs");
      const runsStat = await safeStat(runsDir);
      if (!runsStat || !runsStat.isDirectory()) {
        // No runs/ directory — check if it's a legacy task with direct status.yaml
        const legacyStatusFile = join(taskDir, "status.yaml");
        const legacyStat = await safeStat(legacyStatusFile);
        if (!legacyStat) continue;

        let statusData: any;
        try {
          const content = await readFile(legacyStatusFile, "utf-8");
          statusData = YAML.parse(content);
        } catch { continue; }

        if (TERMINAL_STATUSES.has(statusData.status)) continue;

        // Check skeleton for legacy tasks
        const missing: ArtifactName[] = [];
        for (const artifact of required) {
          const artifactFile = join(taskDir, `${artifact}.md`);
          const exists = await safeStat(artifactFile);
          if (!exists) missing.push(artifact);
        }

        if (missing.length > 0) {
          skeletonTasks.push({ name: taskName, dir: taskDir, missing, status: statusData.status ?? null });
        } else {
          incompleteTasks.push({ name: taskName, status: statusData.status });
        }
        continue;
      }

      // Scan runs/ subdirectory for active runs
      let runEntries: import("fs").Dirent[];
      try {
        runEntries = await readdir(runsDir, { withFileTypes: true });
      } catch { continue; }

      let hasActiveRun = false;
      let isSkeleton = false;
      const missing: ArtifactName[] = [];

      for (const artifact of required) {
        const artifactFile = join(taskDir, `${artifact}.md`);
        const exists = await safeStat(artifactFile);
        if (!exists) missing.push(artifact);
      }

      if (missing.length > 0) {
        isSkeleton = true;
      }

      for (const runEntry of runEntries) {
        if (!runEntry.isDirectory()) continue;
        if (!/^\d{3}$/.test(runEntry.name)) continue;

        const statusFile = join(runsDir, runEntry.name, "status.yaml");
        const statusStat = await safeStat(statusFile);
        if (!statusStat) continue;

        let statusData: any;
        try {
          const content = await readFile(statusFile, "utf-8");
          statusData = YAML.parse(content);
        } catch { continue; }

        if (TERMINAL_STATUSES.has(statusData.status)) continue;

        hasActiveRun = true;

        if (isSkeleton) {
          skeletonTasks.push({ name: taskName, dir: taskDir, missing, status: statusData.status ?? null });
        } else {
          incompleteTasks.push({ name: taskName, status: statusData.status });
        }
        break; // Only need one active run per task
      }
    }

    // 分类：skeleton 优先于 in_progress
    if (skeletonTasks.length > 0) {
      return { level: "skeleton", spec_task_dir: specTaskDir, skeleton_tasks: skeletonTasks, incomplete_tasks: [] };
    }

    if (incompleteTasks.length > 0) {
      return { level: "in_progress", spec_task_dir: specTaskDir, skeleton_tasks: [], incomplete_tasks: incompleteTasks };
    }

    return { level: "all_done", spec_task_dir: specTaskDir, skeleton_tasks: [], incomplete_tasks: [] };
  }
}
