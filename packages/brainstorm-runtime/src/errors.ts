export class BrainstormRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class DataReferenceError extends BrainstormRuntimeError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, "DATA_REFERENCE_ERROR", options);
  }
}

export class ArtifactValidationError extends BrainstormRuntimeError {
  constructor(
    readonly schemaName: string,
    readonly nodeId: string,
    readonly issues: readonly string[],
  ) {
    super(
      `node "${nodeId}" returned an invalid ${schemaName} artifact: ${issues.join("; ")}`,
      "ARTIFACT_VALIDATION_ERROR",
    );
  }
}

export class RouteResolutionError extends BrainstormRuntimeError {
  constructor(message: string) {
    super(message, "ROUTE_RESOLUTION_ERROR");
  }
}
