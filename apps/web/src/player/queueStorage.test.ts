import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlayQueue } from "./queue";
import { forgetSavedQueue, loadSavedQueue, saveQueue, setQueueStorageUser } from "./queueStorage";

const queue: PlayQueue = {
  entries: [
    {
      songId: "a",
      title: "A",
      subtitle: "",
      ready: true,
      projectId: "p",
      projectName: "P",
      imageHash: null,
    },
  ],
  index: 0,
  source: { kind: "project", projectId: "p", projectName: "P", imageHash: "h" },
};

afterEach(() => {
  setQueueStorageUser(null);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the queue saved on this device (SPEC §6.10)", () => {
  it("keeps the queue and repeat per user and forgets it", () => {
    setQueueStorageUser("u1");
    saveQueue({ queue, repeat: "one" });
    expect(loadSavedQueue()).toEqual({ queue, repeat: "one" });
    setQueueStorageUser("u2");
    expect(loadSavedQueue()).toBeNull();
    setQueueStorageUser("u1");
    forgetSavedQueue();
    expect(loadSavedQueue()).toBeNull();
  });

  it("saves nothing without a user (public links)", () => {
    saveQueue({ queue, repeat: "off" });
    forgetSavedQueue();
    expect(loadSavedQueue()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("ignores broken or foreign data and keeps the index inside the queue", () => {
    setQueueStorageUser("u1");
    localStorage.setItem("bandroom.queue.u1", "{not json");
    expect(loadSavedQueue()).toBeNull();
    localStorage.setItem("bandroom.queue.u1", JSON.stringify({ v: 2 }));
    expect(loadSavedQueue()).toBeNull();
    localStorage.setItem(
      "bandroom.queue.u1",
      JSON.stringify({ v: 1, queue: { ...queue, index: 5 }, repeat: "all" }),
    );
    expect(loadSavedQueue()?.queue.index).toBe(0);
  });

  it("survives a storage that throws", () => {
    setQueueStorageUser("u1");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => {
      saveQueue({ queue, repeat: "off" });
      forgetSavedQueue();
    }).not.toThrow();
    expect(loadSavedQueue()).toBeNull();
  });
});
