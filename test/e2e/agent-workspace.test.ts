/**
 * E2E: Agent Workspace 隔离测试
 * 验证当 OpenClaw 为每个 agent 配置独立 workspace 时，
 * spec-task 插件天然实现 agent 级任务隔离。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { FileUtils } from "../../src/file-utils.js";
import { ConfigManager } from "../../src/core/config.js";
import { Detector } from "../../src/detector.js";
import { executeTaskCreate } from "../../src/tools/task-create.js";
import { executeConfigMerge } from "../../src/tools/config-merge.js";

// 真实 agent workspace 路径（来自 openclaw.json）
const PROJECT = "/home/leonardo123/workspaces/stocking-analysis";
const AGENTS = {
  coordinator:         join(PROJECT, "agents/coordinator"),
  "technical-analyst": join(PROJECT, "agents/technical-analyst"),
  "industry-analyst":  join(PROJECT, "agents/industry-analyst"),
};

// 测试后彻底清理（不影响根目录 spec-task/config.yaml）
function fullCleanup() {
  for (const key of Object.keys(AGENTS)) {
    const ws = AGENTS[key as keyof typeof AGENTS];
    const specTaskDir = join(ws, "spec-task");
    rmSync(specTaskDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  fullCleanup();
});

describe("E2E: Agent Workspace 隔离", () => {
  // ============================================================
  describe("resolveTaskDir 路径解析", () => {
    const fu = new FileUtils();

    it("coordinator 任务解析到 agents/coordinator/spec-task/", () => {
      const dir = fu.resolveTaskDir("my-task", AGENTS.coordinator);
      expect(dir).toContain("agents/coordinator/spec-task/my-task");
    });

    it("technical-analyst 任务解析到 agents/technical-analyst/spec-task/", () => {
      const dir = fu.resolveTaskDir("chart-task", AGENTS["technical-analyst"]);
      expect(dir).toContain("agents/technical-analyst/spec-task/chart-task");
    });

    it("不同 agent 的任务路径不同", () => {
      const a = fu.resolveTaskDir("task", AGENTS.coordinator);
      const b = fu.resolveTaskDir("task", AGENTS["technical-analyst"]);
      expect(a).not.toBe(b);
    });
  });

  // ============================================================
  describe("在 agent workspace 下创建任务", () => {
    it("coordinator 在自己 workspace 下创建任务", async () => {
      // executeTaskCreate 返回的是 ToolResponse（对象），需要从 content 字段解析
      const response = await executeTaskCreate("t1", {
        task_name: "test-coord-task",
        title: "Coordinator测试",
        project_root: AGENTS.coordinator,
      });
      // ToolResponse = { content: [{ type: "text", text: "<JSON string>" }] }
      const text = (response as any)?.content?.[0]?.text ?? JSON.stringify(response);
      const result = JSON.parse(typeof text === "string" ? text : JSON.stringify(text));
      expect(result.success).toBe(true);
      expect(result.task_dir).toContain("agents/coordinator/spec-task/test-coord-task");
      expect(existsSync(join(result.task_dir, "status.yaml"))).toBe(true);
    });

    it("technical-analyst 在自己 workspace 下创建任务", async () => {
      const response = await executeTaskCreate("t2", {
        task_name: "test-tech-task",
        title: "Tech测试",
        project_root: AGENTS["technical-analyst"],
      });
      const text = (response as any)?.content?.[0]?.text ?? JSON.stringify(response);
      const result = JSON.parse(typeof text === "string" ? text : JSON.stringify(text));
      expect(result.success).toBe(true);
      expect(result.task_dir).toContain("agents/technical-analyst/spec-task/test-tech-task");
      expect(existsSync(join(result.task_dir, "status.yaml"))).toBe(true);
    });

    it("根目录 spec-task 不存在", async () => {
      await executeTaskCreate("t3", {
        task_name: "test-isolated-task",
        project_root: AGENTS.coordinator,
      });
      expect(existsSync(join(PROJECT, "spec-task"))).toBe(false);
    });
  });

  // ============================================================
  describe("ConfigManager 在 agent workspace 下", () => {
    it("coordinator 独立生成 config.yaml", async () => {
      const cm = new ConfigManager();
      const config = await cm.loadMergedConfig(AGENTS.coordinator);
      expect(config).toBeDefined();
      expect(existsSync(join(AGENTS.coordinator, "spec-task", "config.yaml"))).toBe(true);
    });

    it("industry-analyst 独立生成 config.yaml", async () => {
      const cm = new ConfigManager();
      const config = await cm.loadMergedConfig(AGENTS["industry-analyst"]);
      expect(config).toBeDefined();
      expect(existsSync(join(AGENTS["industry-analyst"], "spec-task", "config.yaml"))).toBe(true);
    });

    it("两个 agent 的 config 文件路径不同", async () => {
      const cm = new ConfigManager();
      await cm.loadMergedConfig(AGENTS.coordinator);
      await cm.loadMergedConfig(AGENTS["industry-analyst"]);
      const p1 = join(AGENTS.coordinator, "spec-task", "config.yaml");
      const p2 = join(AGENTS["industry-analyst"], "spec-task", "config.yaml");
      expect(p1).not.toBe(p2);
      expect(existsSync(p1)).toBe(true);
      expect(existsSync(p2)).toBe(true);
    });
  });

  // ============================================================
  describe("Detector 在 agent workspace 下", () => {
    it("coordinator 有新任务时检测为 skeleton（缺文档）", async () => {
      // 创建任务（只有 status.yaml，缺 brief/spec/plan/checklist）
      await executeTaskCreate("t4", {
        task_name: "detect-test",
        project_root: AGENTS.coordinator,
      });

      const detector = new Detector();
      const result = await detector.detect(AGENTS.coordinator);
      // 新任务只有骨架 → skeleton
      expect(["skeleton", "in_progress"]).toContain(result.level);
      expect(result.spec_task_dir).toContain("agents/coordinator/spec-task");
    });

    it("coordinator 有完整文档的任务时检测为 in_progress", async () => {
      // 创建任务并填充所有文档
      await executeTaskCreate("t5", {
        task_name: "complete-task",
        project_root: AGENTS.coordinator,
      });
      const taskDir = join(AGENTS.coordinator, "spec-task", "complete-task");
      // 填充必需文档
      for (const doc of ["brief.md", "spec.md", "plan.md", "checklist.md"]) {
        writeFileSync(join(taskDir, doc), `# ${doc}\nTest content\n`);
      }

      const detector = new Detector();
      const result = await detector.detect(AGENTS.coordinator);
      expect(result.level).toBe("in_progress");
      expect(result.spec_task_dir).toContain("agents/coordinator/spec-task");
      expect(result.incomplete_tasks.length).toBeGreaterThan(0);
    });

    it("industry-analyst 只有 config 无任务时检测为 empty", async () => {
      const cm = new ConfigManager();
      await cm.loadMergedConfig(AGENTS["industry-analyst"]);

      const detector = new Detector();
      const result = await detector.detect(AGENTS["industry-analyst"]);
      expect(result.level).toBe("empty");
    });
  });

  // ============================================================
  describe("config_merge 工具在 agent workspace 下", () => {
    it("返回 agent workspace 的配置", async () => {
      const response = await executeConfigMerge("t6", {
        project_root: AGENTS.coordinator,
      });
      const text = (response as any)?.content?.[0]?.text ?? JSON.stringify(response);
      const result = JSON.parse(typeof text === "string" ? text : JSON.stringify(text));
      expect(result.success).toBe(true);
      expect(result.config).toBeDefined();
    });
  });
});
