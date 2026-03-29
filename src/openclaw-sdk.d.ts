// Type declarations for openclaw/plugin-sdk (runtime-injected peer dependency)
declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry(config: {
    id: string;
    name: string;
    description: string;
    kind?: string;
    configSchema?: Record<string, unknown> | (() => Record<string, unknown>);
    register(api: import("openclaw/plugin-sdk").OpenClawPluginApi): void;
  }): Record<string, unknown>;
}

declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    config?: Record<string, unknown>;
    logger: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
      debug: (...args: unknown[]) => void;
    };
    on(event: string, handler: (context: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>): void;
    registerTool(tool: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }): void;
  }

  export function emptyPluginConfigSchema(): Record<string, unknown>;
}
