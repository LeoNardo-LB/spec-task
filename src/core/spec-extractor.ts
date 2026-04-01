import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import type { TaskStatusData } from "../types.js";

interface ExtractSpecInput {
  taskDir: string;       // Run directory (runs/NNN/)
  runDir: string;        // Same as taskDir in this context
}

/**
 * Extract a technical specification from task execution data.
 * Reads brief.md, plan.md, status.yaml from the task.
 * Generates spec.md in the task root directory.
 */
export async function extractSpec(input: ExtractSpecInput): Promise<string | null> {
  const taskRoot = join(input.taskDir, "..", "..");  // Task root (parent of runs/NNN/)

  // Read brief.md
  let brief = "";
  try { brief = await readFile(join(taskRoot, "brief.md"), "utf-8"); } catch {}

  // Read plan.md
  let plan = "";
  try { plan = await readFile(join(taskRoot, "plan.md"), "utf-8"); } catch {}

  // Read status.yaml
  let data: TaskStatusData | null = null;
  try {
    const content = await readFile(join(input.taskDir, "status.yaml"), "utf-8");
    data = YAML.parse(content) as TaskStatusData;
  } catch { return null; }

  if (!data) return null;

  // Build spec content
  const lines: string[] = [];

  // Title
  lines.push(`# Spec: ${data.title || data.task_id}`);
  lines.push("");
  lines.push(`> Auto-extracted from run ${data.run_id || "?"} on ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");

  // Technical Decisions (from summary.approach)
  const approaches = data.steps
    .filter(s => s.summary?.approach)
    .map(s => ({ id: s.id, title: s.summary.title, approach: s.summary.approach }));

  if (approaches.length > 0) {
    lines.push("## Technical Decisions");
    lines.push("");
    for (const a of approaches) {
      lines.push(`### ${a.id} ${a.title}`);
      lines.push("");
      lines.push(a.approach);
      lines.push("");
    }
  }

  // Implementation Summary (from summary.content)
  const contents = data.steps
    .filter(s => s.summary?.content)
    .map(s => ({ id: s.id, title: s.summary.title, content: s.summary.content }));

  if (contents.length > 0) {
    lines.push("## Implementation Summary");
    lines.push("");
    for (const c of contents) {
      lines.push(`### ${c.id} ${c.title}`);
      lines.push("");
      lines.push(c.content);
      lines.push("");
    }
  }

  // Verification Results
  if (data.verification?.criteria && data.verification.criteria.length > 0) {
    lines.push("## Verification Results");
    lines.push("");
    for (const c of data.verification.criteria) {
      const icon = c.result === "passed" ? "✅" : "❌";
      lines.push(`- ${icon} ${c.criterion}${c.evidence ? ` — ${c.evidence}` : ""}`);
    }
    lines.push("");
  }

  // Outputs
  if (data.outputs && data.outputs.length > 0) {
    lines.push("## Outputs");
    lines.push("");
    for (const output of data.outputs) {
      lines.push(`- \`${output}\``);
    }
    lines.push("");
  }

  // Errors Encountered
  if (data.errors && data.errors.length > 0) {
    lines.push("## Errors Encountered");
    lines.push("");
    for (const err of data.errors) {
      lines.push(`- [${err.step}] ${err.message} (retry#${err.retry_count})`);
    }
    lines.push("");
  }

  // Sources Referenced
  const allSources = new Set<string>();
  for (const s of data.steps) {
    if (s.summary?.sources) {
      for (const src of s.summary.sources) {
        allSources.add(src);
      }
    }
  }
  if (allSources.size > 0) {
    lines.push("## Sources Referenced");
    lines.push("");
    for (const src of [...allSources].sort()) {
      lines.push(`- ${src}`);
    }
    lines.push("");
  }

  const specContent = lines.join("\n");

  // Write to task root
  const specPath = join(taskRoot, "spec.md");
  await writeFile(specPath, specContent, "utf-8");

  return specPath;
}
