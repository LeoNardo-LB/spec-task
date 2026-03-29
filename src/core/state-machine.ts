import type { TaskStatus } from "../types.js";
import { VALID_TRANSITIONS } from "../types.js";

export class StateMachine {
  /**
   * 验证状态转换是否合法。
   * @returns true 如果合法
   */
  isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
    const allowed = VALID_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  }

  /**
   * 执行状态转换验证（不合法时抛错）。
   * @throws Error 非法转换
   */
  validate(from: TaskStatus, to: TaskStatus): void {
    if (!this.isValidTransition(from, to)) {
      throw new Error(
        `Invalid transition: ${from} → ${to}. ` +
        `Allowed transitions from ${from}: [${(VALID_TRANSITIONS[from] ?? []).join(", ")}]`
      );
    }
  }
}
