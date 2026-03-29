/**
 * 工具通用辅助函数。
 * 所有 8 个工具共享的返回格式化逻辑。
 */

export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
};

/**
 * 格式化成功返回。
 */
export function formatResult(data: unknown): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * 格式化错误返回。
 */
export function formatError(code: string, message: string): ToolResponse {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ success: false, error: code, message }),
    }],
  };
}
