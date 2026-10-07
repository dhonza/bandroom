import type { TrashItem } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { chunkItems, itemCount, toBatchItems, withParents } from "./queries";

const item = (kind: TrashItem["kind"], id: string, over: Partial<TrashItem> = {}): TrashItem => ({
  kind,
  id,
  name: id,
  number: kind === "version" ? 1 : null,
  project: { id: "p", name: "P" },
  song: { id: "s", title: "S", deleted: false },
  track: kind === "version" ? { id: "t", name: "T", deleted: false } : null,
  deletedAt: 1,
  deletedBy: null,
  purgeAt: 2,
  bytes: 0,
  shared: false,
  canRestore: true,
  canPurge: true,
  ...over,
});

describe("Trash helpers (SPEC §26.3)", () => {
  it("groups items into a batch body", () => {
    const body = toBatchItems([item("song", "s"), item("track", "t"), item("version", "v")]);
    expect(body).toEqual({ songs: ["s"], tracks: ["t"], versions: ["v"] });
    expect(itemCount(body)).toBe(3);
  });

  it("splits large selections into calls of at most 500 ids", () => {
    const many = Array.from({ length: 1201 }, (_, i) => item("version", `v${String(i)}`));
    expect(chunkItems(many).map((b) => b.versions?.length)).toEqual([500, 500, 201]);
  });

  it("adds the deleted song (and track) a restore needs, when the user may restore them", () => {
    const song = item("song", "s");
    const track = item("track", "t", { song: { id: "s", title: "S", deleted: true } });
    const version = item("version", "v", {
      song: { id: "s", title: "S", deleted: true },
      track: { id: "t", name: "T", deleted: true },
    });
    const all = [song, track, version];
    expect(withParents([version], all)?.map((i) => i.id)).toEqual(["v", "s", "t"]);
    expect(withParents([track, song], all)?.map((i) => i.id)).toEqual(["t", "s"]);
    // A live parent needs nothing.
    expect(withParents([item("track", "x")], all)?.map((i) => i.id)).toEqual(["x"]);
  });

  it("refuses when a needed parent cannot be restored", () => {
    const song = item("song", "s", { canRestore: false });
    const track = item("track", "t", { song: { id: "s", title: "S", deleted: true } });
    expect(withParents([track], [song, track])).toBeNull();
    // Not in the list at all (e.g. another user's view).
    expect(withParents([track], [track])).toBeNull();
  });
});
