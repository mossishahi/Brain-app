import type {
  DocumentBlock,
  ImageBlock,
  TextBlock,
} from "../model/content.js";
import type { ToolDefinition } from "../model/tools.js";
import type { JsonValue } from "../types/json.js";

export interface ToolExecutionContext {
  readonly runId: string;
  readonly taskId?: string;
  readonly signal?: AbortSignal;
}

export interface ToolResult {
  readonly output: JsonValue;
  readonly isError?: boolean;
  /**
   * Optional rich tool-result content (e.g. an image an attachment tool
   * read). When present, executors send these blocks to the provider instead
   * of the JSON-serialized `output`; providers without rich tool results fall
   * back to `output`.
   */
  readonly blocks?: readonly (TextBlock | ImageBlock | DocumentBlock)[];
}

/**
 * A host-side tool: the model-facing definition plus the handler invoked when
 * a model emits a matching tool_use block.
 */
export interface Tool {
  readonly definition: ToolDefinition;
  execute(input: JsonValue, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  list(): readonly Tool[];
  definitions(names?: readonly string[]): readonly ToolDefinition[];
}

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    const name = tool.definition.name;
    if (this.tools.has(name)) {
      throw new Error(`tool "${name}" is already registered`);
    }
    this.tools.set(name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): readonly Tool[] {
    return [...this.tools.values()];
  }

  definitions(names?: readonly string[]): readonly ToolDefinition[] {
    if (!names) return this.list().map((tool) => tool.definition);
    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`tool "${name}" is not registered`);
      return tool.definition;
    });
  }
}
