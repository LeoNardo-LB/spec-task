// ============================================================================
// 枚举类型
// ============================================================================

export type TaskStatus =
  | "pending" | "assigned" | "running"
  | "completed" | "failed" | "blocked" | "cancelled" | "revised";

export type RevisionType =
  | "created" | "user_request" | "auto_adapt"
  | "verify_retry" | "cancel" | "status_change";

export type ImpactLevel = "minor" | "major" | "full_reset";

export type BlockType = "soft_block" | "hard_block";

export type VerificationStatus = "pending" | "passed" | "failed";

export type ArtifactAction = "added" | "modified" | "removed";

export type ArtifactName = "brief" | "spec" | "plan" | "checklist";

export type TrackingLevel = "low" | "medium" | "high";

export type DetectorLevel = "none" | "empty" | "skeleton" | "in_progress" | "all_done";

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

export interface TaskProgress {
  total: number;
  completed: number;
  current_step: string;
  percentage: number;
}

export interface TaskTiming {
  estimated_minutes: number | null;
  elapsed_minutes: number | null;
}

export interface ErrorRecord {
  step: string;
  message: string;
  retry_count: number;
  timestamp: string;
}

export interface AlertRecord {
  type: string;
  message: string;
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

export interface RevisionChange {
  artifact: ArtifactName;
  action: ArtifactAction;
  detail: string;
}

export interface AffectedSteps {
  invalidated: string[];
  modified: string[];
  added: string[];
}

export interface Revision {
  id: number;
  type: RevisionType;
  timestamp: string;
  trigger: string;
  summary: string;
  impact: ImpactLevel;
  changes: RevisionChange[];
  affected_steps: AffectedSteps;
  resume_from: string;
  status_before: TaskStatus;
  status_after: TaskStatus;
  block_type: BlockType | null;
  block_reason: string | null;
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
  started_at: string | null;
  completed_at: string | null;
  progress: TaskProgress;
  parent: string | null;
  depth: number;
  children: string[];
  outputs: string[];
  timing: TaskTiming;
  errors: ErrorRecord[];
  alerts: AlertRecord[];
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
  parent?: string;
  depth?: number;
  brief?: string;
  plan?: string;
  checklist?: string;
}

export interface TaskTransitionParams {
  task_dir: string;
  status: TaskStatus;
  revision_type?: string;
  trigger?: string;
  summary?: string;
  impact?: ImpactLevel;
  resume_from?: string;
  block_type?: BlockType;
  block_reason?: string;
  assigned_to?: string;
  changes?: RevisionChange[];
  affected_steps?: AffectedSteps;
}

export type TaskLogAction =
  | { action: "error"; step: string; message: string }
  | { action: "alert"; type: string; message: string }
  | { action: "add-block"; task: string; reason: string }
  | { action: "remove-block"; task: string }
  | { action: "output"; path: string }
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

export interface ChecklistReadParams {
  task_dir: string;
}

export interface ChecklistWriteParams {
  task_dir: string;
  content: string;
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
  created_dirs: string[];
  created_artifacts: string[];
}

export interface TaskTransitionResult extends ToolResult {
  old_status: TaskStatus;
  new_status: TaskStatus;
  progress: TaskProgress;
  revision_id: number;
}

export interface ChecklistReadResult extends ToolResult {
  content: string;
  progress: TaskProgress;
  checklist_path: string;
}

export interface ChecklistWriteResult extends ToolResult {
  task_dir: string;
  checklist_path: string;
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
  CHECKLIST_NOT_FOUND: "CHECKLIST_NOT_FOUND",
  TASK_ALREADY_EXISTS: "TASK_ALREADY_EXISTS",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  DUPLICATE_BLOCK: "DUPLICATE_BLOCK",
  BLOCK_NOT_FOUND: "BLOCK_NOT_FOUND",
  DUPLICATE_OUTPUT: "DUPLICATE_OUTPUT",
  NO_CRITERIA: "NO_CRITERIA",
  CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",
} as const;

export type SpecTaskErrorCode = (typeof SPEC_TASK_ERRORS)[keyof typeof SPEC_TASK_ERRORS];

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


