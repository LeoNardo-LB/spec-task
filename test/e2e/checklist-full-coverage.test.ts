/**
 * 生产级端到端测试：checklist_read / checklist_write 全量覆盖工具链
 *
 * 模拟真实的 LLM 工作流：
 *   1. task_create 创建任务
 *   2. checklist_write 写入初始 checklist
 *   3. checklist_read 读取并验证进度
 *   4. checklist_write 批量打勾（全量覆盖）
 *   5. checklist_read 再次读取验证进度更新
 *   6. checklist_write 动态修改列表（增删步骤）
 *   7. 验证 status.yaml 进度字段全程正确
 *   8. 验证 before_prompt_build hook 注入正确的工具名
 *
 * 每个场景都是独立的 describe block，可单独运行。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, rm, readFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { createTestEnv, createTask, readStatus, writeChecklist, transitionTask } from "./helpers.js";
import { executeChecklistRead } from "../../src/tools/checklist-read.js";
import { executeChecklistWrite } from "../../src/tools/checklist-write.js";
import { createPromptBuildHandler } from "../../src/hooks/before-prompt-build.js";
import { Detector } from "../../src/detector.js";

const mockLogger = {
  info: (..._: unknown[]) => {},
  warn: (..._: unknown[]) => {},
  error: (..._: unknown[]) => {},
  debug: (..._: unknown[]) => {},
};

function parseResult(raw: string): any {
  return JSON.parse(raw);
}

/** 典型的 stocking-analysis checklist 内容 */
const INITIAL_CHECKLIST = `# 分析 000001（测试标的）- 2026-03-31

## 1. 初始化
- [ ] 1.1 创建输出目录和任务文件
- [ ] 1.2 创建 checklist

## 2. L1 数据采集
- [ ] 2.1 [spawn:financial-valuation] 财务估值分析师
- [ ] 2.2 [spawn:industry] 行业分析师
- [ ] 2.3 [spawn:technical] 技术分析师

## 3. L1.5 数据校验
- [ ] 3.1 [spawn:data-validator] 数据质量校验

## 4. L2 多视角分析
- [ ] 4.1 [spawn:risk-control] 风控分析师
- [ ] 4.2 [spawn:negative] 负面分析师

## 5. 交付
- [ ] 5.1 生成最终摘要
- [ ] 5.2 完成任务
`;

describe("E2E: Checklist Full-Coverage Tool Chain", () => {
  let env: Awaited<ReturnType<typeof createTestEnv>>;
  let taskDir: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const { taskDir: td } = await createTask(env.specTaskDir, "analyze-e2e-test");
    taskDir = td;
    // 创建必要的 artifact 使 detector 识别为 in_progress
    await writeChecklist(taskDir, "brief.md", "# Brief\nE2E test task");
    await writeChecklist(taskDir, "spec.md", "# Spec\nE2E test spec");
    await writeChecklist(taskDir, "plan.md", "# Plan\nE2E test plan");
    // 转为 running 状态
    await transitionTask(taskDir, "running");
  }, 10000);

  afterAll(async () => {
    await env.cleanup();
  }, 10000);

  // =========================================================================
  // 场景 1：完整生命周期（创建 → 读取 → 批量打勾 → 修改 → 验证）
  // =========================================================================

  describe("Scenario 1: Full Lifecycle", () => {
    it("1.1 checklist_write: 创建初始 checklist", async () => {
      const result = await executeChecklistWrite("cl-1", { task_dir: taskDir, content: INITIAL_CHECKLIST });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
      expect(existsSync(join(taskDir, "checklist.md"))).toBe(true);

      // 验证文件内容
      const written = readFileSync(join(taskDir, "checklist.md"), "utf-8");
      expect(written).toBe(INITIAL_CHECKLIST);
    });

    it("1.2 checklist_read: 读取初始状态 — 0/10 完成", async () => {
      const result = await executeChecklistRead("cl-1", { task_dir: taskDir });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.content).toBe(INITIAL_CHECKLIST);
      expect(data.progress.total).toBe(10);
      expect(data.progress.completed).toBe(0);
      expect(data.progress.skipped).toBe(0);
      expect(data.progress.percentage).toBe(0);
      expect(data.progress.current_step).toBe("1.1");
    });

    it("1.3 status.yaml: 进度自动更新为 0/10", async () => {
      const status = await readStatus(taskDir);

      expect(status.progress.total).toBe(10);
      expect(status.progress.completed).toBe(0);
      expect(status.progress.percentage).toBe(0);
      expect(status.progress.current_step).toBe("1.1");
    });

    it("1.4 checklist_write: 批量打勾 — 完成初始化+L1（步骤 1.1-2.3）", async () => {
      // 模拟 LLM 先 checklist_read，修改内容，再 checklist_write
      const updatedContent = INITIAL_CHECKLIST
        .replace("- [ ] 1.1 创建输出目录和任务文件", "- [x] 1.1 创建输出目录和任务文件")
        .replace("- [ ] 1.2 创建 checklist", "- [x] 1.2 创建 checklist")
        .replace("- [ ] 2.1 [spawn:financial-valuation] 财务估值分析师", "- [x] 2.1 [spawn:financial-valuation] 财务估值分析师")
        .replace("- [ ] 2.2 [spawn:industry] 行业分析师", "- [x] 2.2 [spawn:industry] 行业分析师")
        .replace("- [ ] 2.3 [spawn:technical] 技术分析师", "- [x] 2.3 [spawn:technical] 技术分析师");

      const result = await executeChecklistWrite("cl-1", { task_dir: taskDir, content: updatedContent });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(true);
    });

    it("1.5 checklist_read: 验证批量打勾后 — 5/10 完成", async () => {
      const result = await executeChecklistRead("cl-1", { task_dir: taskDir });
      const data = parseResult(result.content[0].text);

      expect(data.progress.total).toBe(10);
      expect(data.progress.completed).toBe(5);
      expect(data.progress.skipped).toBe(0);
      expect(data.progress.percentage).toBe(50);
      expect(data.progress.current_step).toBe("3.1");

      // 验证返回的 content 确实包含勾选
      expect(data.content).toContain("- [x] 1.1");
      expect(data.content).toContain("- [x] 2.3");
      expect(data.content).toContain("- [ ] 3.1");
    });

    it("1.6 status.yaml: 进度自动更新为 5/10", async () => {
      const status = await readStatus(taskDir);

      expect(status.progress.total).toBe(10);
      expect(status.progress.completed).toBe(5);
      expect(status.progress.percentage).toBe(50);
      expect(status.progress.current_step).toBe("3.1");
    });

    it("1.7 checklist_write: 动态修改列表 — 删除 L2.2，添加 L2.3", async () => {
      // 模拟：执行中发现只需要 2 个 L2 分析师，不需要负面分析师，新增 delta 分析师
      const modifiedContent = `# 分析 000001（测试标的）- 2026-03-31

## 1. 初始化
- [x] 1.1 创建输出目录和任务文件
- [x] 1.2 创建 checklist

## 2. L1 数据采集
- [x] 2.1 [spawn:financial-valuation] 财务估值分析师
- [x] 2.2 [spawn:industry] 行业分析师
- [x] 2.3 [spawn:technical] 技术分析师

## 3. L1.5 数据校验
- [x] 3.1 [spawn:data-validator] 数据质量校验

## 4. L2 多视角分析
- [x] 4.1 [spawn:risk-control] 风控分析师
- [ ] 4.3 [spawn:delta-analyst] 历史对比分析师（新增）

## 5. 交付
- [ ] 5.1 生成最终摘要
- [ ] 5.2 完成任务
`;

      const result = await executeChecklistWrite("cl-1", { task_dir: taskDir, content: modifiedContent });
      expect(parseResult(result.content[0].text).success).toBe(true);
    });

    it("1.8 checklist_read: 验证修改后的列表 — 7/10 完成（删除 4.2，新增 4.3）", async () => {
      const result = await executeChecklistRead("cl-1", { task_dir: taskDir });
      const data = parseResult(result.content[0].text);

      expect(data.progress.total).toBe(10);  // 删除了 4.2，新增了 4.3，总数不变
      expect(data.progress.completed).toBe(7);  // 1.1-1.2, 2.1-2.3, 3.1, 4.1 已勾选
      expect(data.progress.skipped).toBe(0);
      expect(data.progress.percentage).toBe(70);
      expect(data.progress.current_step).toBe("4.3");

      // 验证旧步骤不存在，新步骤存在
      expect(data.content).not.toContain("4.2");
      expect(data.content).toContain("4.3 [spawn:delta-analyst]");
    });

    it("1.9 checklist_write: 最终打勾 — 全部完成", async () => {
      const finalContent = `# 分析 000001（测试标的）- 2026-03-31

## 1. 初始化
- [x] 1.1 创建输出目录和任务文件
- [x] 1.2 创建 checklist

## 2. L1 数据采集
- [x] 2.1 [spawn:financial-valuation] 财务估值分析师
- [x] 2.2 [spawn:industry] 行业分析师
- [x] 2.3 [spawn:technical] 技术分析师

## 3. L1.5 数据校验
- [x] 3.1 [spawn:data-validator] 数据质量校验

## 4. L2 多视角分析
- [x] 4.1 [spawn:risk-control] 风控分析师
- [x] 4.3 [spawn:delta-analyst] 历史对比分析师

## 5. 交付
- [x] 5.1 生成最终摘要
- [x] 5.2 完成任务
`;

      const result = await executeChecklistWrite("cl-1", { task_dir: taskDir, content: finalContent });
      expect(parseResult(result.content[0].text).success).toBe(true);

      const readResult = await executeChecklistRead("cl-1", { task_dir: taskDir });
      const readData = parseResult(readResult.content[0].text);

      expect(readData.progress.total).toBe(10);
      expect(readData.progress.completed).toBe(10);
      expect(readData.progress.skipped).toBe(0);
      expect(readData.progress.percentage).toBe(100);
      expect(readData.progress.current_step).toBe("");  // 全部完成，无下一步
    });

    it("1.10 status.yaml: 最终进度为 9/9 (100%)", async () => {
      const status = await readStatus(taskDir);

      expect(status.progress.total).toBe(10);
      expect(status.progress.completed).toBe(10);
      expect(status.progress.percentage).toBe(100);
      expect(status.progress.current_step).toBe("");
    });
  });

  // =========================================================================
  // 场景 2：before_prompt_build hook 注入验证
  // =========================================================================

  describe("Scenario 2: Hook Injection", () => {
    it("2.1 prependSystemContext: 包含 checklist_read 和 checklist_write（不含 checklist_update）", async () => {
      // 确保任务有未完成步骤
      await writeChecklist(taskDir, "checklist.md", INITIAL_CHECKLIST);
      await executeChecklistWrite("cl-1", { task_dir: taskDir, content: INITIAL_CHECKLIST });

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: env.projectRoot }, {});

      const sysCtx = (result as any).prependSystemContext as string;
      expect(sysCtx).toBeDefined();
      expect(sysCtx).toContain("checklist_read");
      expect(sysCtx).toContain("checklist_write");
      expect(sysCtx).not.toContain("checklist_update");
      expect(sysCtx).not.toContain("checklist_status");
    });

    it("2.2 prependContext: 进度提醒包含 checklist_write（不含 checklist_update）", async () => {
      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: env.projectRoot }, {});

      const ctx = (result as any).prependContext as string;
      expect(ctx).toContain("当前进度");
      expect(ctx).toContain("checklist_write");
      expect(ctx).not.toContain("checklist_update");
    });

    it("2.3 全部完成后: hook 不注入 prependSystemContext 和 prependContext", async () => {
      const allDone = "- [x] 1.1 Done\n- [x] 1.2 Done\n";
      await executeChecklistWrite("cl-1", { task_dir: taskDir, content: allDone });

      const detector = new Detector();
      const handler = createPromptBuildHandler(mockLogger, detector, {});
      const result = await handler({ cwd: env.projectRoot }, {});

      expect((result as any).prependSystemContext).toBeUndefined();
      expect(result).toEqual({});  // 无 prependContext
    });
  });

  // =========================================================================
  // 场景 3：错误处理
  // =========================================================================

  describe("Scenario 3: Error Handling", () => {
    it("3.1 checklist_read: 任务不存在", async () => {
      const result = await executeChecklistRead("cl-1", { task_dir: "/nonexistent/path" });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(false);
      expect(data.error).toBe("CHECKLIST_NOT_FOUND");
    });

    it("3.2 checklist_write: 空 content", async () => {
      const result = await executeChecklistWrite("cl-1", { task_dir: taskDir, content: "" });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_PARAMS");
    });

    it("3.3 checklist_write: 空 task_dir", async () => {
      const result = await executeChecklistWrite("cl-1", { task_dir: "", content: "some content" });
      const data = parseResult(result.content[0].text);

      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_PARAMS");
    });
  });

  // =========================================================================
  // 场景 4：进度计算只统计有编号的步骤
  // =========================================================================

  describe("Scenario 4: Progress Calculation Edge Cases", () => {
    it("4.1 无编号 checkbox 行不参与进度统计", async () => {
      const mixedContent = `- [x] 1.1 编号步骤
- [ ] 1.2 另一个编号步骤
- [x] 这是一个没有编号的备注行
- [ ] 这也是无编号行
- [x] 2.1 第三个编号步骤
`;

      await executeChecklistWrite("cl-1", { task_dir: taskDir, content: mixedContent });
      const result = await executeChecklistRead("cl-1", { task_dir: taskDir });
      const data = parseResult(result.content[0].text);

      // 只统计有编号的 3 个步骤
      expect(data.progress.total).toBe(3);
      expect(data.progress.completed).toBe(2);  // 1.1 和 2.1
      expect(data.progress.skipped).toBe(0);
      expect(data.progress.percentage).toBe(67);
      expect(data.progress.current_step).toBe("1.2");
    });

    it("4.2 纯文本（无 checkbox）不崩溃", async () => {
      const noCheckbox = `# 项目计划

## 背景
这是一段没有 checkbox 的纯文本。

## 下一步
待定。
`;
      await executeChecklistWrite("cl-1", { task_dir: taskDir, content: noCheckbox });
      const result = await executeChecklistRead("cl-1", { task_dir: taskDir });
      const data = parseResult(result.content[0].text);

      // 无 checkbox 行 → 无步骤 → CHECKLIST_NOT_FOUND
      expect(data.success).toBe(false);
      expect(data.error).toBe("CHECKLIST_NOT_FOUND");
    });
  });
});
