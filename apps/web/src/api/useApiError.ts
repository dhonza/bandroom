import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ApiError } from "./client";
import { errorMessage } from "./errorMessage";

export function fieldErrorsOf(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !("fieldErrors" in err.body) || !err.body.fieldErrors)
    return {};
  const out: Record<string, string> = {};
  for (const fe of err.body.fieldErrors) {
    const field = fe.path.split("/").pop();
    if (field) out[field] = fe.message;
  }
  return out;
}

/** Hook returning a translator for thrown API errors. */
export function useApiError(): (err: unknown) => string {
  const { t } = useTranslation();
  return (err) => errorMessage(t, err);
}

export function translateValidation(t: TFunction, code: string): string {
  switch (code) {
    case "PASSWORD_TOO_SHORT":
      return t("validation.passwordTooShort", { min: 10 });
    case "USERNAME_FORMAT":
      return t("validation.usernameFormat");
    case "REQUIRED":
      return t("validation.required");
    case "PASSWORDS_DIFFER":
      return t("validation.passwordsDiffer");
    case "EMAIL":
      return t("validation.email");
    default:
      return t("validation.invalid");
  }
}
