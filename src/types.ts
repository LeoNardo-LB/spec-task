// ============================================================================
// 枚举类型
// ============================================================================

export type TaskStatus =
  | "pending" | "assigned" | "running"
  | "completed" | "failed" | "blocked" | "cancelled" | "revised";

export type RevisionType =
  | "created" | "status_change";

export type VerificationStatus = "pending" | "passed" | "failed";

export type ArtifactName = "brief" | "spec" | "plan";

export type TrackingLevel = "low" | "medium" | "high";

export type DetectorLevel = "none" | "empty" | "skeleton" | "in_progress" | "all_done";

/** 步骤状态 */
export type StepStatus = "pending" | "completed" | "skipped";

// ============================================================================
// 状态机合法转换（14 条）
// ============================================================================

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned", "cancelled"],
  assigned: ["running", "cancelled"],
  running: ["completed", "failed", "blocked", "cancelled", "revised", "running"],
  failed: ["running"],
  blocked: ["pending"],
  revised: ["running", "pending"],
  completed: [],
  cancelled: [],
};

/** 终态集合 */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed", "failed", "cancelled",
]);

// ============================================================================
// 核心数据结构
// ============================================================================

/** 步骤摘要信息 */
export interface StepSummary {
  title: string;
  content: string;
  approach: string;
  sources: string[];
}

/** 结构化步骤（status.yaml.steps 数组元素） */
export interface Step {
  id: string;
  summary: StepSummary;
  status: StepStatus;
  completed_at: string | null;
  tags: string[];
  skip_reason?: string;
}

export interface TaskProgress {
  total: number;
  completed: number;
  skipped: number;
  current_step: string;
  percentage: number;
}

export interface ErrorRecord {
  step: string;
  message: string;
  retry_count: number;
  timestamp: string;
}

export interface BlockRecord {
  task: string;
  reason: string;
}

export interface VerificationCriterion {
  criterion: string;
  result: "passed" | "failed";
  evidence: string;
  reason: string;
}

export interface Verification {
  status: VerificationStatus;
  criteria: VerificationCriterion[];
  verified_at: string | null;
  verified_by: string | null;
}

export interface Revision {
  id: number;
  type: RevisionType;
  timestamp: string;
  trigger: string;
  summary: string;
}

// ============================================================================
// 任务状态（status.yaml 完整结构）
// ============================================================================

export interface TaskStatusData {
  task_id: string;
  title: string;
  created: string;
  updated: string;
  status: TaskStatus;
  assigned_to: string;
  run_id: string;
  started_at: string | null;
  completed_at: string | null;
  progress: TaskProgress;
  outputs: string[];
  steps: Step[];
  errors: ErrorRecord[];
  blocked_by: BlockRecord[];
  verification: Verification;
  revisions: Revision[];
}

// ============================================================================
// 配置类型
// ============================================================================

export interface SpecTaskConfig {
  context?: string;
  tracking?: {
    level?: TrackingLevel;
    required_artifacts?: ArtifactName[];
  };
  runtime?: {
    allow_agent_self_delegation?: boolean;
    task_timeout?: number;
  };
  failure_policy?: {
    soft_block?: {
      strategy?: "retry" | "escalate";
      max_retries?: number;
    };
    hard_block?: {
      strategy?: "adapt" | "fail";
      adapt_modifies?: string[];
      on_adapt_failed?: "fail" | "escalate";
    };
    verify_failed?: {
      strategy?: "retry" | "escalate" | "adaptive";
      max_retries?: number;
    };
    on_exhausted?: "escalate" | "fail";
  };
  archive?: {
    auto_archive?: boolean;
    record_history?: boolean;
    generate_lessons?: boolean;
  };
  completion?: {
    requires_verification?: boolean;  // 默认 true
  };
}

// ============================================================================
// 工具参数类型
// ============================================================================

export interface ConfigMergeParams {
  project_root?: string;
  format?: "json" | "yaml";
}

export interface TaskRecallParams {
  keywords: string;
  project_root?: string;
  agent_workspace?: string;
  top?: number;
}

export interface TaskCreateParams {
  task_name: string;
  project_root?: string;
  title?: string;
  assigned_to?: string;
  brief?: string;
  plan?: string;
}

export interface TaskTransitionParams {
  task_dir: string;
  status: TaskStatus;
  revision_type?: string;
  trigger?: string;
  summary?: string;
  assigned_to?: string;
}

export type TaskLogAction =
  | { action: "error"; step: string; message: string }
  | { action: "add-block"; task: string; reason: string }
  | { action: "remove-block"; task: string }
  | { action: "output"; path?: string }
  | { action: "retry"; step: string };

export interface TaskLogParams {
  task_dir: string;
  action: TaskLogAction;
}

export type TaskVerifyAction =
  | { action: "add-criterion"; criterion: string; result: "passed" | "failed"; evidence?: string; reason?: string }
  | { action: "finalize"; verified_by?: string }
  | { action: "get" };

export interface TaskVerifyParams {
  task_dir: string;
  action: TaskVerifyAction;
}

export interface TaskResumeParams {
  task_dir: string;
}

export interface TaskArchiveParams {
  task_dir: string;
  agent_workspace?: string;
  project_root?: string;
  agent_name?: string;
  dry_run?: boolean;
}

export interface StepsUpdateParams {
  task_dir: string;
  steps: Step[];
}

export interface StepsReadParams {
  task_dir: string;
}

export interface TaskInstructionsParams {
  task_dir: string;
  artifact_id: string;
}

// ============================================================================
// 工具返回类型
// ============================================================================

export interface ToolResult {
  success: boolean;
  [key: string]: unknown;
}

export interface TaskCreateResult extends ToolResult {
  task_dir: string;
  task_id: string;
  status: TaskStatus;
  run_id: string;
  created_dirs: string[];
  created_artifacts: string[];
}

export interface TaskTransitionResult extends ToolResult {
  old_status: TaskStatus;
  new_status: TaskStatus;
  progress: TaskProgress;
  revision_id: number;
}

export interface StepsUpdateResult extends ToolResult {
  task_dir: string;
  progress: TaskProgress;
  all_steps_completed?: boolean;
  suggested_action?: string;
  next_action_hint?: string;
}

export interface StepsReadResult extends ToolResult {
  steps: Step[];
  progress: TaskProgress;
  task_dir: string;
}

export interface TaskInstructionsResult extends ToolResult {
  artifact_id: string;
  instruction: string;
  template: string;
  context: string;
  rules: string[];
  dependencies: Array<{ id: string; done: boolean; content: string | null }>;
  available_artifacts: string[];
}

// ============================================================================
// 检测器类型
// ============================================================================

export interface SkeletonTask {
  name: string;
  dir: string;
  missing: ArtifactName[];
  status: TaskStatus | null;
}

export interface DetectorResult {
  level: DetectorLevel;
  spec_task_dir: string | null;
  skeleton_tasks: SkeletonTask[];
  incomplete_tasks: Array<{ name: string; status: TaskStatus }>;
}

// ============================================================================
// 错误码
// ============================================================================

export const SPEC_TASK_ERRORS = {
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_ALREADY_EXISTS: "TASK_ALREADY_EXISTS",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  DUPLICATE_BLOCK: "DUPLICATE_BLOCK",
  BLOCK_NOT_FOUND: "BLOCK_NOT_FOUND",
  DUPLICATE_OUTPUT: "DUPLICATE_OUTPUT",
  NO_CRITERIA: "NO_CRITERIA",
  CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",
} as const;

// ============================================================================
// 辅助：身份文件列表（配置自动生成用）
// ============================================================================

export const CONTEXT_FILES = [
  "AGENTS.md",
  "IDENTITY.md",
  "SOUL.md",
  "README.md",
  "CLAUDE.md",
] as const;

// ============================================================================
// SchemaReader 类型
// ============================================================================

/** schema.yaml 中单个 artifact 的定义 */
export interface SchemaArtifact {
  id: string;
  generates: string;
  description: string;
  template: string;
  instruction: string;
  requires: string[];
}

/** 推断出的构件状态 */
export type ArtifactState = "done" | "ready" | "blocked";

/** 构件状态查询结果 */
export interface ArtifactStatus {
  id: string;
  state: ArtifactState;
  generates: string;
}

/** getInstructions 返回的完整指导 */
export interface ArtifactInstructions {
  artifact_id: string;
  instruction: string;
  template: string;
  context: string;
  rules: string[];
  dependencies: Array<{ id: string; done: boolean; content: string | null }>;
}

/** SchemaReader 完整状态（等价于 openspec status --json） */
export interface SchemaStatusResult {
  artifacts: ArtifactStatus[];
  nextReady: string[];
  completed: string[];
  hasCycle: boolean;
}
