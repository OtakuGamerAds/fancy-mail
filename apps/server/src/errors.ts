import type { RpcErrorCode } from "@fancy-mail/contracts";

/**
 * An error meant for a person (the user in the app, or an agent over MCP). `message` says what
 * happened and what to do; it never carries credentials.
 */
export class AppError extends Error {
  readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function notFound(message: string): AppError {
  return new AppError("not_found", message);
}

export function badRequest(message: string): AppError {
  return new AppError("bad_request", message);
}

export function forbidden(message: string): AppError {
  return new AppError("forbidden", message);
}

export function conflict(message: string): AppError {
  return new AppError("conflict", message);
}

/** The text of any thrown value, for logs. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
