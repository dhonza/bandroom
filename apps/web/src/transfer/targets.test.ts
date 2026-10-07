import type { ProjectSummary } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { NEW_PROJECT, targetBody, transferTargets } from "./targets";

const p = (
  id: string,
  capabilities: string[],
  extra: Partial<ProjectSummary> = {},
): ProjectSummary =>
  ({
    id,
    name: id,
    color: "violet",
    songCount: 0,
    updatedAt: 0,
    archivedAt: null,
    imageHash: null,
    visibility: "full",
    access: { role: "editor", capabilities },
    ...extra,
  }) as ProjectSummary;

describe("transferTargets", () => {
  it("keeps live, fully visible projects where songs can be added", () => {
    const all = [
      p("a", ["song.create", "upload"]),
      p("b", ["upload"]),
      p("c", ["song.create", "upload"], { archivedAt: 1 }),
      p("d", ["song.create", "upload"], { visibility: "reduced" }),
      p("e", ["song.create", "upload"]),
    ];
    expect(transferTargets(all).map((x) => x.id)).toEqual(["a", "e"]);
    expect(transferTargets(all, "a").map((x) => x.id)).toEqual(["e"]);
  });

  it("builds the body for an existing or a new project", () => {
    expect(targetBody("x", "")).toEqual({ targetProjectId: "x" });
    expect(targetBody(NEW_PROJECT, "  Fresh ")).toEqual({ newProject: { name: "Fresh" } });
  });
});
