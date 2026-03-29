/**
 * Static Resources E2E Tests for spec-task plugin.
 *
 * Verifies the existence and integrity of all static resources shipped with the plugin:
 *   - 4 Template files (brief.md, spec.md, plan.md, checklist.md)
 *   - 2 Reference docs (status-format.md, openspec-mapping.md)
 *   - Built-in default config (config.yaml)
 *   - SKILL.md with trigger conditions
 *   - Plugin manifest (openclaw.plugin.json)
 *   - package.json with module type and dependencies
 */

import { describe, it, expect } from "vitest";
import { access, readFile, constants } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Resolve plugin root: test/e2e/static-resources.test.ts → ../../
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, "..", "..");

/** Assert that a file exists and is readable */
async function expectFileExists(filePath: string): Promise<void> {
  await expect(
    access(filePath, constants.R_OK),
    `Expected file to exist and be readable: ${filePath}`
  ).resolves.toBeUndefined();
}

/** Read file content as UTF-8 string */
async function readContent(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8");
}

// ============================================================================
// Suite 1: Template Files
// ============================================================================

describe("Static Resources: Template Files", () => {
  const templatesDir = join(
    PLUGIN_ROOT,
    "skills/spec-task/schemas/agent-task/templates"
  );

  it("brief.md should exist and contain task intent / success criteria content", async () => {
    const filePath = join(templatesDir, "brief.md");
    await expectFileExists(filePath);

    const content = await readContent(filePath);
    expect(content, "brief.md should contain 'Intent' section").toContain("Intent");
    expect(content, "brief.md should contain 'Success Criteria' section").toContain("Success Criteria");
  });

  it("spec.md should exist and contain ADDED/REMOVED scenario definitions", async () => {
    const filePath = join(templatesDir, "spec.md");
    await expectFileExists(filePath);

    const content = await readContent(filePath);
    expect(content, "spec.md should contain 'ADDED' section").toContain("ADDED");
    expect(content, "spec.md should contain 'REMOVED' section").toContain("REMOVED");
    expect(content, "spec.md should contain GIVEN/WHEN/THEN scenario format").toContain("GIVEN");
    expect(content, "spec.md should contain GIVEN/WHEN/THEN scenario format").toContain("WHEN");
    expect(content, "spec.md should contain GIVEN/WHEN/THEN scenario format").toContain("THEN");
  });

  it("plan.md should exist and contain strategy / tool references", async () => {
    const filePath = join(templatesDir, "plan.md");
    await expectFileExists(filePath);

    const content = await readContent(filePath);
    expect(content, "plan.md should contain 'Strategy' section").toContain("Strategy");
    expect(content, "plan.md should contain 'Tools Required' section").toContain("Tools Required");
  });

  it("checklist.md should exist and contain step checklist template", async () => {
    const filePath = join(templatesDir, "checklist.md");
    await expectFileExists(filePath);

    const content = await readContent(filePath);
    expect(content, "checklist.md should contain 'Checklist' heading").toContain("Checklist");
    expect(content, "checklist.md should contain checkbox format '- [ ]'").toContain("- [ ]");
  });
});

// ============================================================================
// Suite 2: Reference Docs
// ============================================================================

describe("Static Resources: Reference Docs", () => {
  const referenceDir = join(PLUGIN_ROOT, "skills/spec-task/reference");

  it("status-format.md should exist and document status.yaml field structure", async () => {
    const filePath = join(referenceDir, "status-format.md");
    await expectFileExists(filePath);

    const content = await readContent(filePath);
    expect(content, "status-format.md should reference 'status.yaml'").toContain("status.yaml");
    expect(content, "status-format.md should contain field definitions").toContain("task_id");
    expect(content, "status-format.md should contain progress fields").toContain("progress");
    expect(content, "status-format.md should contain verification fields").toContain("verification");
  });

  it("openspec-mapping.md should exist and contain OpenSpec mapping content", async () => {
    const filePath = join(referenceDir, "openspec-mapping.md");
    await expectFileExists(filePath);

    const content = await readContent(filePath);
    expect(content, "openspec-mapping.md should reference 'OpenSpec'").toContain("OpenSpec");
    expect(content, "openspec-mapping.md should contain concept mapping table").toContain("spec-driven");
    expect(content, "openspec-mapping.md should reference spec-task artifacts").toContain("spec-task");
  });
});

// ============================================================================
// Suite 3: Built-in Default Config
// ============================================================================

describe("Static Resources: Built-in Default Config", () => {
  it("config.yaml should exist and contain valid YAML with top-level keys", async () => {
    const filePath = join(PLUGIN_ROOT, "skills/spec-task/config.yaml");
    await expectFileExists(filePath);

    const content = await readContent(filePath);
    // Must contain at least one of the expected top-level keys
    const hasRuntime = content.includes("runtime:");
    const hasArchive = content.includes("archive:");
    const hasFailurePolicy = content.includes("failure_policy:");

    expect(
      hasRuntime || hasArchive || hasFailurePolicy,
      "config.yaml should contain at least one top-level key: runtime, archive, or failure_policy"
    ).toBe(true);

    // Verify specific expected keys are present
    expect(content, "config.yaml should contain 'runtime' section").toContain("runtime:");
    expect(content, "config.yaml should contain 'failure_policy' section").toContain("failure_policy:");
    expect(content, "config.yaml should contain 'archive' section").toContain("archive:");
  });
});

// ============================================================================
// Suite 4: SKILL.md
// ============================================================================

describe("Static Resources: SKILL.md", () => {
  it("SKILL.md should exist", async () => {
    const filePath = join(PLUGIN_ROOT, "skills/spec-task/SKILL.md");
    await expectFileExists(filePath);
  });

  it("SKILL.md should contain 'spec-task' in its content", async () => {
    const filePath = join(PLUGIN_ROOT, "skills/spec-task/SKILL.md");
    const content = await readContent(filePath);
    expect(content, "SKILL.md should contain 'spec-task'").toContain("spec-task");
  });

  it("SKILL.md should mention at least 3 of 4 trigger conditions", async () => {
    const filePath = join(PLUGIN_ROOT, "skills/spec-task/SKILL.md");
    const content = await readContent(filePath);

    const triggers = [
      { keyword: "coordinator", label: "coordinator 派发" },
      { keyword: "≥3", label: "≥3 步复杂任务" },
      { keyword: "spec-task/", label: "spec-task 目录已存在" },
      { keyword: "显式要求", label: "用户显式要求" },
    ];

    const matchedTriggers = triggers.filter(t => content.includes(t.keyword));
    expect(
      matchedTriggers.length,
      `SKILL.md should mention at least 3 trigger conditions, found: ${matchedTriggers.map(t => t.label).join(", ")}`
    ).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// Suite 5: Plugin Manifest
// ============================================================================

describe("Static Resources: Plugin Manifest (openclaw.plugin.json)", () => {
  it("openclaw.plugin.json should exist with correct id 'spec-task'", async () => {
    const filePath = join(PLUGIN_ROOT, "openclaw.plugin.json");
    await expectFileExists(filePath);

    const content = await readContent(filePath);
    const manifest = JSON.parse(content);
    expect(manifest.id, "Plugin manifest id should be 'spec-task'").toBe("spec-task");
  });

  it("openclaw.plugin.json should have configSchema with enforceOnSubAgents property", async () => {
    const filePath = join(PLUGIN_ROOT, "openclaw.plugin.json");
    const content = await readContent(filePath);
    const manifest = JSON.parse(content);

    expect(manifest.configSchema, "Plugin manifest should have configSchema").toBeDefined();
    expect(
      manifest.configSchema.properties?.enforceOnSubAgents,
      "configSchema should have enforceOnSubAgents property"
    ).toBeDefined();
    expect(manifest.configSchema.properties.enforceOnSubAgents.type).toBe("boolean");
  });

  it("openclaw.plugin.json should list skills: [\"skills/spec-task\"]", async () => {
    const filePath = join(PLUGIN_ROOT, "openclaw.plugin.json");
    const content = await readContent(filePath);
    const manifest = JSON.parse(content);

    expect(manifest.skills, "Plugin manifest should have skills array").toBeDefined();
    expect(manifest.skills).toContain("skills/spec-task");
  });
});

// ============================================================================
// Suite 6: package.json
// ============================================================================

describe("Static Resources: package.json", () => {
  it("package.json should exist with type: \"module\"", async () => {
    const filePath = join(PLUGIN_ROOT, "package.json");
    await expectFileExists(filePath);

    const content = await readContent(filePath);
    const pkg = JSON.parse(content);
    expect(pkg.type, 'package.json should have type: "module"').toBe("module");
  });

  it("package.json should have dependencies: yaml and proper-lockfile", async () => {
    const filePath = join(PLUGIN_ROOT, "package.json");
    const content = await readContent(filePath);
    const pkg = JSON.parse(content);

    expect(pkg.dependencies, "package.json should have dependencies").toBeDefined();
    expect(pkg.dependencies.yaml, "dependencies should include 'yaml'").toBeDefined();
    expect(pkg.dependencies["proper-lockfile"], "dependencies should include 'proper-lockfile'").toBeDefined();
  });
});
