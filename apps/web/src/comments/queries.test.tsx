import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi } from "../test/mockApi";
import { useSongComments } from "./queries";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useSongComments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows the cursor to the end", async () => {
    const fetch = mockApi({
      "GET /songs/s1/comments": () => ({ body: { comments: [], nextCursor: null } }),
    });
    const { result } = renderHook(() => useSongComments("s1"), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.truncated).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a list cut off after the page limit", async () => {
    const fetch = mockApi({
      "GET /songs/s1/comments": () => ({ body: { comments: [], nextCursor: "more" } }),
    });
    const { result } = renderHook(() => useSongComments("s1"), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.truncated).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(20);
  });
});
