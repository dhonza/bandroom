import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOnlineState, watchOnlineState } from "../offline/online";
import type { GoneSongs } from "../player/listenEngine";
import { RECONNECT_MAX_MS, useEventStream } from "./useEventStream";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  /** Like a non-200 answer: the browser gives up. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }

  emit(type: string, data: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data }));
  }
}

function latest(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error("no EventSource");
  return es;
}

function setup(gone: (songs: GoneSongs) => void = () => undefined) {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      useEventStream(true, undefined, gone);
    },
    { wrapper },
  );
  return { invalidate, qc, ...hook };
}

describe("useEventStream (SPEC §18.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useOnlineState.setState({ online: true });
  });

  it("recreates a closed stream with doubling backoff, reset by a successful open", () => {
    setup();
    expect(FakeEventSource.instances).toHaveLength(1);
    latest().fail();
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    latest().fail();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    latest().open();
    latest().fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("caps the backoff", () => {
    setup();
    for (let i = 0; i < 10; i++) {
      latest().fail();
      vi.advanceTimersByTime(RECONNECT_MAX_MS);
    }
    expect(FakeEventSource.instances).toHaveLength(11);
  });

  it("leaves a CONNECTING stream to the browser's own retry", () => {
    setup();
    const es = latest();
    es.onerror?.();
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(es.closed).toBe(false);
  });

  it("refetches everything after reopening following an error, not on the first open", () => {
    const { invalidate } = setup();
    latest().open();
    expect(invalidate).not.toHaveBeenCalled();
    latest().fail();
    vi.advanceTimersByTime(1000);
    latest().open();
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("reconnects right away when the app comes back online", () => {
    watchOnlineState();
    setup();
    latest().fail();
    useOnlineState.setState({ online: false });
    useOnlineState.setState({ online: true });
    expect(FakeEventSource.instances).toHaveLength(2);
    // The pending backoff timer was cleared.
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("ignores malformed messages and still handles later ones", () => {
    const { invalidate } = setup();
    const es = latest();
    expect(() => {
      es.emit("notification", "{not json");
    }).not.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
    es.emit("import.progress", JSON.stringify({ id: "1", type: "import.progress", data: {} }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "imports"] });
  });

  it("refreshes only the song's tracks, versions and lists for a track change", () => {
    const { invalidate, qc } = setup();
    const keys = [
      ["songs", "s1"],
      ["songs", "s1", "tracks"],
      ["songs", "s1", "versions", "t1"],
      ["songs", "s1", "comments"],
      ["songs", "s1", "markers"],
      ["songs", "s1", "tempo"],
      ["songs", "s2", "tracks"],
      ["projects", "list", false],
      ["projects", "detail", "p1", "songs"],
    ];
    for (const key of keys) qc.setQueryData(key, { v: 1 });
    latest().emit(
      "version.created",
      JSON.stringify({ id: "1", type: "version.created", songId: "s1", projectId: "p1", data: {} }),
    );
    const stale = keys
      .filter((key) => qc.getQueryState(key)?.isInvalidated)
      .map((key) => key.join("/"));
    expect(stale).toEqual([
      "songs/s1",
      "songs/s1/tracks",
      "songs/s1/versions/t1",
      "projects/list/false",
      "projects/detail/p1/songs",
    ]);
    const projectCalls = invalidate.mock.calls.filter(([f]) => f?.queryKey?.[0] === "projects");
    expect(projectCalls).toHaveLength(1);
  });

  it("reports deleted songs and projects, also deleted by others (SPEC §6.10)", () => {
    const gone = vi.fn();
    const { invalidate } = setup(gone);
    latest().emit(
      "song.deleted",
      JSON.stringify({ type: "song.deleted", projectId: "p1", data: { songId: "s1" } }),
    );
    expect(gone).toHaveBeenLastCalledWith({ songIds: ["s1"] });
    latest().emit(
      "project.deleted",
      JSON.stringify({ type: "project.deleted", projectId: "p1", data: { projectId: "p1" } }),
    );
    expect(gone).toHaveBeenLastCalledWith({ projectId: "p1" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["projects"] });
    expect(gone).toHaveBeenCalledTimes(2);
  });

  it("closes the stream and stops reconnecting on unmount", () => {
    const { unmount } = setup();
    latest().fail();
    unmount();
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("closes an open stream on unmount", () => {
    const { unmount } = setup();
    const es = latest();
    es.open();
    unmount();
    expect(es.closed).toBe(true);
  });
});
