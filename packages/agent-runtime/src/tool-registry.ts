import type {
  CoreToolRegistry,
  Tool,
  ToolDefinition,
} from "./core-adapter.js";
import { ToolRegistrationError } from "./errors.js";

export type ToolHandler = Tool["execute"];

export interface ToolRegistrationOptions {
  /**
   * Explicit opt-in. A tool that mutates shared state must remain serial.
   */
  readonly parallelSafe?: boolean;
}

export interface ToolRegistration extends ToolRegistrationOptions {
  readonly tool: Tool;
}

export interface RegisteredTool {
  readonly tool: Tool;
  readonly parallelSafe: boolean;
}

/**
 * Core ToolRegistry implementation with an execution-policy sidecar. Models
 * see only core ToolDefinition values; parallel safety never crosses the model
 * boundary.
 */
export class ToolRegistry implements CoreToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  public constructor(registrations: Iterable<ToolRegistration> = []) {
    for (const registration of registrations) {
      this.register(registration.tool, registration);
    }
  }

  public register(
    tool: Tool,
    options: ToolRegistrationOptions = {},
  ): this {
    const name = tool.definition.name;
    if (name.trim() === "") {
      throw new ToolRegistrationError("Tool names cannot be empty.");
    }
    if (this.#tools.has(name)) {
      throw new ToolRegistrationError(`Tool \`${name}\` is already registered.`);
    }
    if (typeof tool.execute !== "function") {
      throw new ToolRegistrationError(
        `Tool \`${name}\` requires an execute method.`,
      );
    }

    this.#tools.set(
      name,
      Object.freeze({
        tool,
        parallelSafe: options.parallelSafe ?? false,
      }),
    );
    return this;
  }

  public unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  public has(name: string): boolean {
    return this.#tools.has(name);
  }

  public get(name: string): Tool | undefined {
    return this.#tools.get(name)?.tool;
  }

  public list(): readonly Tool[] {
    return [...this.#tools.values()].map(({ tool }) => tool);
  }

  public definitions(names?: readonly string[]): readonly ToolDefinition[] {
    if (names === undefined) {
      return this.list().map(({ definition }) => definition);
    }
    return names.map((name) => {
      const registration = this.#tools.get(name);
      if (registration === undefined) {
        throw new ToolRegistrationError(
          `Tool \`${name}\` is not registered.`,
        );
      }
      return registration.tool.definition;
    });
  }

  public isParallelSafe(name: string): boolean {
    return this.#tools.get(name)?.parallelSafe === true;
  }

  public names(): readonly string[] {
    return [...this.#tools.keys()];
  }

  public snapshot(): readonly RegisteredTool[] {
    return [...this.#tools.values()];
  }
}
