import { describe, expect, it } from "vitest";
import { ApiErrorSchema, ERROR_CODES, ERROR_STATUS, isErrorCode } from "./errors";

describe("errors", () => {
  it("maps every code to an HTTP status", () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it("narrows known codes only", () => {
    expect(isErrorCode("NOT_FOUND")).toBe(true);
    expect(isErrorCode("SOMETHING_NEW")).toBe(false);
  });

  it("accepts unknown codes on the wire", () => {
    const parsed = ApiErrorSchema.parse({ code: "FUTURE_CODE", message: "x" });
    expect(parsed.code).toBe("FUTURE_CODE");
  });
});
