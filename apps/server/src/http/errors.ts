import { ERROR_STATUS, type ApiErrorBody, type ErrorCode } from "@bandroom/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

/** Throw from handlers/hooks to produce a stable-coded error response (SPEC §18.3). */
export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = ERROR_STATUS[code];
  }
}

function codeForStatus(status: number): ErrorCode {
  if (status === 404) return "NOT_FOUND";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 429) return "RATE_LIMITED";
  return "BAD_REQUEST";
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError | AppError>((err, request, reply) => {
    let status: number;
    let body: ApiErrorBody;

    if (err instanceof AppError) {
      status = err.statusCode;
      body = { code: err.code, message: err.message, ...(err.params && { params: err.params }) };
    } else if (hasZodFastifySchemaValidationErrors(err)) {
      status = 400;
      body = {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        fieldErrors: err.validation.map((v) => ({
          path: `${err.validationContext ?? ""}${v.instancePath}`,
          message: v.message ?? "invalid",
        })),
      };
    } else if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      status = err.statusCode;
      body = { code: codeForStatus(status), message: err.message };
    } else {
      request.log.error({ err }, "unhandled error");
      status = 500;
      body = { code: "INTERNAL", message: "Internal server error" };
    }

    return reply.status(status).send(body);
  });
}
