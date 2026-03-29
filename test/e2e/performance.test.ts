import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, rm, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import type { TaskStatusData, Revision } from "../../src/types.js";
import { createTask } from "./helpers.js";
import { Detector } from "../../src/detector.js";

describe("E2E: Performance", () => {
  let perfDir: string;
  let specTaskDir: string;

  beforeAll(async () => {
    perfDir = join(tmpdir(), `spec-task-perf-${Date.now()}`);
    specTaskDir = join(perfDir, "spec-task");
    await mkdir(specTaskDir, { recursive: true });
  });
  afterAll(async () => { await rm(perfDir, { recursive: true, force: true }); });

  it("should handle 1000+ revisions write and read within time threshold", async () => {
    const { taskDir } = await createTask(specTaskDir, "perf-revisions", {
      title: "Perf Revisions", assignedTo: "perf-agent" });
    const statusPath = join(taskDir, "status.yaml");

    // Build 1000 revisions
    const N = 1000;
    const revisions: Revision[] = [];
    for (let i = 0; i < N; i++) {
      revisions.push({
        id: i + 1, type: "status_change",
        timestamp: new Date(Date.now() + i).toISOString(),
        trigger: "perf-agent", summary: `Progress ${i + 1}/${N}`, impact: "minor",
        changes: [], affected_steps: { invalidated: [], modified: [], added: [] },
        resume_from: "", status_before: "running", status_after: "running",
        block_type: null, block_reason: null,
      });
    }

    // Write
    const content = await readFile(statusPath, "utf-8");
    const data = YAML.parse(content) as TaskStatusData;
    data.revisions = revisions; data.status = "running";

    const t0 = performance.now();
    await writeFile(statusPath, YAML.stringify(data), "utf-8");
    const writeTime = performance.now() - t0;

    // Read
    const t1 = performance.now();
    const readContent = await readFile(statusPath, "utf-8");
    const readData = YAML.parse(readContent) as TaskStatusData;
    const readTime = performance.now() - t1;

    expect(readData.revisions).toHaveLength(N);
    expect(readData.revisions[0].id).toBe(1);
    expect(readData.revisions[N - 1].id).toBe(N);
    console.log(`[Perf] Write ${N} revisions: ${writeTime.toFixed(1)}ms`);
    console.log(`[Perf] Read  ${N} revisions: ${readTime.toFixed(1)}ms`);
    expect(writeTime).toBeLessThan(2000);
    expect(readTime).toBeLessThan(2000);
  });

  it("should scan 100 task directories within time threshold", async () => {
    const TASK_COUNT = 100;
    for (let i = 0; i < TASK_COUNT; i++) {
      await createTask(specTaskDir, `perf-${String(i + 1).padStart(3, "0")}`, {
        title: `Perf Task ${i + 1}`, assignedTo: `agent-${i % 5}` });
    }

    // Mark perf-revisions (from first test) as completed so it doesn't pollute counts
    const perfRevisionsDir = join(specTaskDir, "perf-revisions");
    const revContent = await readFile(join(perfRevisionsDir, "status.yaml"), "utf-8");
    const revData = YAML.parse(revContent) as TaskStatusData;
    revData.status = "completed";
    revData.completed_at = new Date().toISOString();
    await writeFile(join(perfRevisionsDir, "status.yaml"), YAML.stringify(revData), "utf-8");

    const detector = new Detector();

    // Scan — all skeleton
    const t0 = performance.now();
    const skeletonResult = await detector.detect(perfDir);
    const skeletonTime = performance.now() - t0;
    expect(skeletonResult.level).toBe("skeleton");
    expect(skeletonResult.skeleton_tasks.length).toBe(TASK_COUNT);
    console.log(`[Perf] Scan skeleton (${TASK_COUNT}): ${skeletonTime.toFixed(1)}ms`);

    // Fill half → mixed (but detector returns skeleton if any skeleton exists)
    const half = Math.floor(TASK_COUNT / 2);
    for (let i = 0; i < half; i++) {
      const dir = join(specTaskDir, `perf-${String(i + 1).padStart(3, "0")}`);
      for (const f of ["brief.md", "spec.md", "plan.md", "checklist.md"]) {
        await writeFile(join(dir, f), "# Content\n", "utf-8");
      }
    }

    const t1 = performance.now();
    const mixedResult = await detector.detect(perfDir);
    const mixedTime = performance.now() - t1;
    // Detector prioritizes skeleton level — 50 tasks still missing docs
    expect(mixedResult.level).toBe("skeleton");
    expect(mixedResult.skeleton_tasks.length).toBe(TASK_COUNT - half);
    expect(mixedResult.incomplete_tasks.length).toBe(0);
    console.log(`[Perf] Scan mixed (${TASK_COUNT}): ${mixedTime.toFixed(1)}ms`);

    // All completed → all_done
    for (let i = 0; i < TASK_COUNT; i++) {
      const dir = join(specTaskDir, `perf-${String(i + 1).padStart(3, "0")}`);
      const c = await readFile(join(dir, "status.yaml"), "utf-8");
      const d = YAML.parse(c) as TaskStatusData;
      d.status = "completed"; d.completed_at = new Date().toISOString();
      await writeFile(join(dir, "status.yaml"), YAML.stringify(d), "utf-8");
    }

    const t2 = performance.now();
    const doneResult = await detector.detect(perfDir);
    const doneTime = performance.now() - t2;
    expect(doneResult.level).toBe("all_done");
    console.log(`[Perf] Scan all_done (${TASK_COUNT}): ${doneTime.toFixed(1)}ms`);

    expect(skeletonTime).toBeLessThan(5000);
    expect(mixedTime).toBeLessThan(5000);
    expect(doneTime).toBeLessThan(5000);
  });
});
