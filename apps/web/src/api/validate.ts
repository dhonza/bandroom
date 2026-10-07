import type { TFunction } from "i18next";
import type { z } from "zod";
import { translateValidation } from "./useApiError";

/**
 * Turns a shared Zod schema into a @mantine/form field validator. Custom issue messages that are
 * codes (e.g. PASSWORD_TOO_SHORT) are translated; anything else becomes a generic message.
 */
export function zodValidator<T>(schema: z.ZodType<T>, t: TFunction, emptyCode = "REQUIRED") {
  return (value: unknown): string | null => {
    if (value === "" || value === undefined) return translateValidation(t, emptyCode);
    const r = schema.safeParse(value);
    if (r.success) return null;
    const msg = r.error.issues[0]?.message ?? "";
    return translateValidation(t, /^[A-Z_]+$/.test(msg) ? msg : "INVALID");
  };
}
