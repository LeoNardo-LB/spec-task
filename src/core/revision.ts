import type {
  TaskStatusData,
  Revision,
  RevisionType,
  ImpactLevel,
  RevisionChange,
  AffectedSteps,
  BlockType,
} from "../types.js";

export class RevisionBuilder {
  /**
   * 从 revisions 数组获取下一个 revision ID。
   * 等价于 v1.0 的 next_revision_id()。
   */
  nextId(data: TaskStatusData): number {
    const revisions = data.revisions ?? [];
    if (revisions.length === 0) return 1;
    return Math.max(...revisions.map((r) => r.id)) + 1;
  }

  /**
   * 构建完整的 revision 对象。
   * 等价于 v1.0 的 make_revision()。
   */
  build(options: {
    data: TaskStatusData;
    type: RevisionType;
    trigger?: string;
    summary?: string;
    impact?: ImpactLevel;
    changes?: RevisionChange[];
    affectedSteps?: AffectedSteps;
    resumeFrom?: string;
    blockType?: BlockType;
    blockReason?: string;
  }): Revision {
    const { data, type, trigger = "", summary = "", impact = "minor",
      changes, affectedSteps, resumeFrom = "", blockType, blockReason } = options;

    const oldStatus = data.status;
    const emptySteps: AffectedSteps = { invalidated: [], modified: [], added: [] };

    const rev: Revision = {
      id: this.nextId(data),
      type,
      timestamp: new Date().toISOString(),
      trigger,
      summary,
      impact,
      changes: changes ?? [],
      affected_steps: affectedSteps ?? emptySteps,
      resume_from: resumeFrom,
      status_before: oldStatus,
      status_after: oldStatus,
      block_type: blockType ?? null,
      block_reason: blockReason ?? null,
    };

    return rev;
  }
}
