import type { Notification } from "@bandroom/shared";
import i18next, { type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { describeNotification } from "./describe";

let t: TFunction;
beforeAll(async () => {
  t = (await initI18n("en", i18next.createInstance())).t;
});

const n = (type: Notification["type"], payload: Notification["payload"]): Notification => ({
  id: "n",
  type,
  payload,
  createdAt: 1,
  readAt: null,
});

describe("describeNotification", () => {
  it("deep-links comment notifications to the song at the comment time", () => {
    const v = describeNotification(
      n("mention", {
        actorName: "Petr",
        songId: "s1",
        songTitle: "Song",
        projectName: "Album",
        commentId: "c1",
        startSec: 12.5,
        excerpt: "check this",
      }),
      t,
    );
    expect(v).toEqual({
      title: "Petr mentioned you in Song",
      detail: "check this",
      link: "/songs/s1?comment=c1&t=12.5",
    });
  });

  it("describes the other types", () => {
    expect(
      describeNotification(
        n("new_version", { actorName: "Vera", songId: "s", trackName: "Bass", versionNumber: 3 }),
        t,
      ),
    ).toMatchObject({ title: "Vera uploaded Bass v3", link: "/songs/s" });
    expect(
      describeNotification(
        n("granted", { projectId: "p", projectName: "Album", role: "editor" }),
        t,
      ),
    ).toMatchObject({ title: "Someone gave you Editor access to Album", link: "/projects/p" });
    expect(describeNotification(n("quota_warning", { percent: 85 }), t).link).toBe("/settings");
    expect(
      describeNotification(n("reset_request", { actorName: "Gina", username: "gina" }), t),
    ).toMatchObject({ title: "Gina (@gina) asks for a new password", link: "/admin" });
    for (const type of ["reply", "comment_on_upload", "new_song"] as const) {
      expect(describeNotification(n(type, { songId: "s" }), t).link).toMatch(/^\/songs\/s/);
    }
  });
});
