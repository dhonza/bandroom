import type { Notification } from "@bandroom/shared";
import type { TFunction } from "i18next";

export interface NotificationView {
  title: string;
  /** Excerpt or context line. */
  detail: string | null;
  /** In-app path to open (song deep link, admin, settings). */
  link: string | null;
}

/** Where a link is managed: the song's links section or the project's Links tab. */
function linkPage(p: Notification["payload"]): string | null {
  if (p.songId) return `/songs/${p.songId}?links=1`;
  return p.projectId ? `/projects/${p.projectId}?tab=links` : null;
}

/** Text and deep link of a notification (SPEC §11.2 "open the song at the comment time"). */
export function describeNotification(n: Notification, t: TFunction): NotificationView {
  const p = n.payload;
  const actor = p.actorName ?? t("notifications.someone");
  const where = [p.songTitle, p.projectName].filter(Boolean).join(" · ") || null;
  const songLink = (withComment: boolean) => {
    if (!p.songId) return null;
    const q = new URLSearchParams();
    if (withComment && p.commentId) q.set("comment", p.commentId);
    if (withComment && typeof p.startSec === "number") q.set("t", String(p.startSec));
    const qs = q.toString();
    return `/songs/${p.songId}${qs ? `?${qs}` : ""}`;
  };
  switch (n.type) {
    case "mention":
      return {
        title: t("notifications.types.mention", { actor, song: p.songTitle ?? "" }),
        detail: p.excerpt ?? where,
        link: songLink(true),
      };
    case "reply":
      return {
        title: t("notifications.types.reply", { actor, song: p.songTitle ?? "" }),
        detail: p.excerpt ?? where,
        link: songLink(true),
      };
    case "comment_on_upload":
      return {
        title: t("notifications.types.comment_on_upload", { actor, song: p.songTitle ?? "" }),
        detail: p.excerpt ?? where,
        link: songLink(true),
      };
    case "new_version":
      return {
        title: t("notifications.types.new_version", {
          actor,
          track: p.trackName ?? "",
          number: p.versionNumber ?? 1,
        }),
        detail: where,
        link: songLink(false),
      };
    case "new_song":
      return {
        title: t("notifications.types.new_song", { actor, song: p.songTitle ?? "" }),
        detail: p.projectName ?? null,
        link: songLink(false),
      };
    case "granted":
      return {
        title: t("notifications.types.granted", {
          actor,
          target: p.songTitle ?? p.projectName ?? "",
          role: p.role ? t(`contentRoles.${p.role}`) : "",
        }),
        detail: p.songTitle ? (p.projectName ?? null) : null,
        link: p.songId ? `/songs/${p.songId}` : p.projectId ? `/projects/${p.projectId}` : null,
      };
    case "quota_warning":
      return {
        title: t("notifications.types.quota_warning", { percent: p.percent ?? 80 }),
        detail: t("notifications.quotaDetail"),
        link: "/settings",
      };
    case "reset_request":
      return {
        title: t("notifications.types.reset_request", { actor, username: p.username ?? "" }),
        detail: t("notifications.resetDetail"),
        link: "/admin",
      };
    case "link_password_failed":
      return {
        title: t("notifications.types.link_password_failed", {
          link: p.linkLabel || t("links.untitled"),
        }),
        detail: where,
        link: linkPage(p),
      };
    case "edit_bounced":
      return {
        title: t("notifications.types.edit_bounced", {
          actor,
          count: p.count ?? 1,
          song: p.songTitle ?? "",
        }),
        detail: p.projectName ?? null,
        link: p.projectId ? `/projects/${p.projectId}` : songLink(false),
      };
    case "link_comment":
      return {
        title: t("notifications.types.link_comment", { actor, song: p.songTitle ?? "" }),
        detail: p.excerpt ?? where,
        link: songLink(true),
      };
    case "new_document":
      return {
        title: t(
          (p.versionNumber ?? 1) > 1
            ? "notifications.types.new_document_version"
            : "notifications.types.new_document",
          { actor, title: p.documentTitle ?? "", number: p.versionNumber ?? 1 },
        ),
        detail: where,
        // Documents belong to the project and open on their own page (SPEC §28.4).
        link: p.documentId ? `/documents/${p.documentId}` : null,
      };
  }
}
