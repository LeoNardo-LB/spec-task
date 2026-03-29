import { mkdir, readFile, stat } from "fs/promises";
import { join, resolve } from "path";

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
}
