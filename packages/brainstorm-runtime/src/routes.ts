import type {
  CapabilityRequirements,
  JsonObject,
  ProviderOptions,
  ToolChoice,
} from "@brainstorm-agentic/core";

import { RouteResolutionError } from "./errors.js";

export interface BrainstormRouteRequest {
  readonly logicalRoute: string;
  readonly traits: readonly string[];
  readonly skill: string;
  readonly capabilities: readonly string[];
}

/**
 * Deployment-owned resolution of a logical content route. Concrete provider
 * and model ids can appear here because this object is runtime configuration,
 * never workflow content.
 */
export interface ResolvedBrainstormRoute {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly requirements?: CapabilityRequirements;
  readonly providerOptions?: ProviderOptions;
  readonly toolChoice?: ToolChoice;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  readonly metadata?: JsonObject;
  /** Additional deployment tools granted to every task on this route. */
  readonly tools?: readonly string[];
}

export interface BrainstormRouteResolver {
  resolve(
    request: BrainstormRouteRequest,
  ): ResolvedBrainstormRoute | Promise<ResolvedBrainstormRoute>;
}

/** Explicit config map; no provider/model defaults are embedded in content. */
export class StaticBrainstormRouteResolver implements BrainstormRouteResolver {
  constructor(
    private readonly routes: Readonly<Record<string, ResolvedBrainstormRoute>>,
  ) {}

  resolve(request: BrainstormRouteRequest): ResolvedBrainstormRoute {
    const route = this.routes[request.logicalRoute];
    if (!route) {
      throw new RouteResolutionError(`no runtime route configured for logical route "${request.logicalRoute}"`);
    }
    return route;
  }
}

/** Leaves concrete routing to the AgentExecutor while preserving logicalRoute. */
export class ExecutorOwnedRouteResolver implements BrainstormRouteResolver {
  resolve(): ResolvedBrainstormRoute {
    return {};
  }
}

export interface CapabilityToolRequest {
  readonly capability: string;
  readonly contract: string;
  readonly skill: string;
}

export interface CapabilityToolResolver {
  resolve(request: CapabilityToolRequest): readonly string[];
}

/**
 * Default logical mapping: a capability named "web-search" allows the tool
 * with the same provider-neutral name. Hosts may inject a different mapping.
 */
export class LogicalCapabilityToolResolver implements CapabilityToolResolver {
  resolve(request: CapabilityToolRequest): readonly string[] {
    return [request.capability];
  }
}

export class StaticCapabilityToolResolver implements CapabilityToolResolver {
  constructor(private readonly tools: Readonly<Record<string, readonly string[]>>) {}

  resolve(request: CapabilityToolRequest): readonly string[] {
    const tools = this.tools[request.capability];
    if (!tools) {
      throw new RouteResolutionError(
        `no tool mapping configured for capability "${request.capability}" required by skill "${request.skill}"`,
      );
    }
    return tools;
  }
}
