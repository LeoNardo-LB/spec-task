import { readFile, writeFile, rename, mkdir, unlink, stat } from "fs/promises";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import YAML from "yaml";
import lockfile from "proper-lockfile";
import type { TaskStatusData } from "../types.js";

/** 锁配置，等价于 v1.0 的 fcntl.flock 参数 */
const LOCK_OPTIONS = {
  stale: 10000, // 10 秒后视为过期（防止死锁）
  retries: 3, // 获取锁重试 3 次
  retryWait: 100, // 重试间隔 100ms
};

export class StatusStore {
  /**
   * 读取 YAML 文件。
   * 注：proper-lockfile v4.x 不支持共享锁，因此 loadYaml 不加锁。
   * 读操作在 transaction 外使用时，应通过 loadStatus（确保最新数据）或 transaction 保证一致性。
   */
  async loadYaml<T>(path: string): Promise<T> {
    try {
      await stat(path);
    } catch {
      throw new Error(`File not found: ${path}`);
    }

    const content = await readFile(path, "utf-8");
    return (YAML.parse(content) as T) ?? ({} as T);
  }

  /**
   * 排他锁 + 原子写入。
   * 等价于 v1.0 的 save_yaml()。
   * 实现：write to temp → rename (POSIX atomic)。
   */
  async saveYaml(path: string, data: unknown): Promise<void> {
    // 确保父目录存在
    await mkdir(dirname(path), { recursive: true });

    // 确保目标文件存在（proper-lockfile 要求文件已存在才能加锁）
    try {
      await stat(path);
    } catch {
      await writeFile(path, "", "utf-8");
    }

    const release = await lockfile.lock(path, { ...LOCK_OPTIONS });
    try {
      // 原子写入：先写临时文件，再 rename
      const yamlContent = YAML.stringify(data);
      const tmpPath = join(dirname(path), `.status-${randomUUID()}.tmp`);
      await writeFile(tmpPath, yamlContent, "utf-8");
      try {
        await rename(tmpPath, path);
      } catch (renameError) {
        // 清理临时文件
        try {
          await unlink(tmpPath);
        } catch {
          // 忽略清理失败
        }
        throw renameError;
      }
    } finally {
      await release();
    }
  }

  /**
   * 事务：排他锁内 load → callback → atomic save。
   * 等价于 v1.0 的 transaction()。
   */
  async transaction<T>(
    taskDir: string,
    callback: (data: TaskStatusData) => T | Promise<T>
  ): Promise<T> {
    const statusPath = join(taskDir, "status.yaml");

    // 确保文件存在
    try {
      await stat(statusPath);
    } catch {
      throw new Error(`status.yaml not found at ${statusPath}`);
    }

    const release = await lockfile.lock(statusPath, { ...LOCK_OPTIONS });
    try {
      // 在锁内直接读取（已持有排他锁，无需 loadYaml）
      const content = await readFile(statusPath, "utf-8");
      const data = (YAML.parse(content) as TaskStatusData) ?? {};

      // 执行 callback
      const result = await callback(data);

      // 原子写入
      const yamlContent = YAML.stringify(data);
      const tmpPath = join(taskDir, `.status-${randomUUID()}.tmp`);
      await writeFile(tmpPath, yamlContent, "utf-8");
      try {
        await rename(tmpPath, statusPath);
      } catch (renameError) {
        try {
          await unlink(tmpPath);
        } catch {
          // 忽略
        }
        throw renameError;
      }

      return result;
    } finally {
      await release();
    }
  }

  /**
   * 读取任务状态。
   * 等价于 v1.0 的 load_status()。
   */
  async loadStatus(taskDir: string): Promise<TaskStatusData> {
    const statusPath = join(taskDir, "status.yaml");
    try {
      await stat(statusPath);
    } catch {
      throw new Error(`status.yaml not found at ${statusPath}`);
    }
    return this.loadYaml<TaskStatusData>(statusPath);
  }

  /**
   * 保存任务状态（带事务）。
   * 等价于 v1.0 的 save_status()。
   * 自动更新 updated 时间戳。
   */
  async saveStatus(taskDir: string, data: TaskStatusData): Promise<void> {
    // 自动更新 updated 时间戳
    data.updated = new Date().toISOString();
    await this.saveYaml(join(taskDir, "status.yaml"), data);
  }
}
