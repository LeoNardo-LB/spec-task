import { readdir, stat, readFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import type { DetectorResult, SkeletonTask, ArtifactName } from "./types.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

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
   * L3 skeleton:  有 status.yaml 但缺 brief/spec/plan/checklist
   * L4 in_progress: 有非终态任务且文档完整
   * L5 all_done:  所有任务都是终态
   */
  async detect(workspaceDir: string, requiredArtifacts?: readonly ArtifactName[]): Promise<DetectorResult> {
    const required: readonly ArtifactName[] = requiredArtifacts ?? ["checklist"];
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
      const statusFile = join(taskDir, "status.yaml");

      const statusStat = await safeStat(statusFile);
      if (!statusStat) continue;

      let statusData: any;
      try {
        const content = await readFile(statusFile, "utf-8");
        statusData = YAML.parse(content);
      } catch {
        continue; // YAML 解析失败 → 静默跳过
      }

      // 跳过终态任务
      if (TERMINAL_STATUSES.has(statusData.status)) continue;

      // 检查骨架：status.yaml 存在但缺少关键文档
      const missing: ArtifactName[] = [];
      for (const artifact of required) {
        const artifactFile = join(taskDir, `${artifact}.md`);
        const exists = await safeStat(artifactFile);
        if (!exists) missing.push(artifact);
      }

      if (missing.length > 0) {
        skeletonTasks.push({
          name: taskName,
          dir: taskDir,
          missing,
          status: statusData.status ?? null,
        });
      } else {
        incompleteTasks.push({ name: taskName, status: statusData.status });
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
