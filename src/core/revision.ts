import type {
  TaskStatusData,
  Revision,
  RevisionType,
  BlockType,
} from "../types.js";

export class RevisionBuilder {
  /**
   * 从 revisions 数组获取下一个 revision ID。
   */
  nextId(data: TaskStatusData): number {
    const revisions = data.revisions ?? [];
    if (revisions.length === 0) return 1;
    return Math.max(...revisions.map((r) => r.id)) + 1;
  }

  /**
   * 构建完整的 revision 对象。
   */
  build(options: {
    data: TaskStatusData;
    type: RevisionType;
    trigger?: string;
    summary?: string;
    blockType?: BlockType;
    blockReason?: string;
  }): Revision {
    const { data, type, trigger = "", summary = "", blockType, blockReason } = options;

    return {
      id: this.nextId(data),
      type,
      timestamp: new Date().toISOString(),
      trigger,
      summary,
      block_type: blockType ?? null,
      block_reason: blockReason ?? null,
    };
  }
}
