import { ERROR_CODES, type ErrorCode } from "@bandroom/shared";
import type { TFunction } from "i18next";
import { ApiError, type ClientErrorCode } from "./client";

type KnownCode = ErrorCode | ClientErrorCode;

const CLIENT_CODES: readonly ClientErrorCode[] = ["NETWORK", "UNKNOWN"];

/** Every code with an `errors.<CODE>` translation: the server's plus the client's own. */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<KnownCode>([
  ...ERROR_CODES,
  ...CLIENT_CODES,
]);

function isKnown(code: string): code is KnownCode {
  return KNOWN_ERROR_CODES.has(code);
}

/** Translates any thrown error into a user-facing message via its stable code. */
export function errorMessage(t: TFunction, err: unknown): string {
  const code = err instanceof ApiError ? err.code : "UNKNOWN";
  const key: KnownCode = isKnown(code) ? code : "UNKNOWN";
  return t(`errors.${key}`);
}
