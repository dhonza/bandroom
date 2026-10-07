import { notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi } from "../test/mockApi";
import { useFollow } from "./queries";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useFollow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports a failed follow change and shows the server state again", async () => {
    const show = vi.spyOn(notifications, "show").mockReturnValue("n1");
    mockApi({
      "GET /songs/s1/follow": () => ({ body: { following: false } }),
      "PUT /songs/s1/follow": () => ({
        status: 403,
        body: { code: "FORBIDDEN", message: "no" },
      }),
    });
    const { result } = renderHook(() => useFollow("song", "s1"), { wrapper });
    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
    act(() => {
      result.current.set(true);
    });
    await waitFor(() => {
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ color: "red" }));
    });
    await waitFor(() => {
      expect(result.current.following).toBe(false);
    });
  });
});
