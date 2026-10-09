import type { LibraryProject } from "@bandroom/shared";
import { ActionIcon, Menu } from "@mantine/core";
import {
  IconArchive,
  IconArchiveOff,
  IconCloudDown,
  IconDots,
  IconExternalLink,
  IconPencil,
  IconPlayerPlayFilled,
  IconStar,
  IconStarFilled,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { offlineSupported, removeOffline, useOffline } from "../../offline/controller";
import { itemKey } from "../../offline/db";
import { OfflineModal } from "../../offline/OfflineButton";
import { useOnline } from "../../offline/online";
import { useProjectPlay } from "../project/PlayAllButton";
import { useArchiveProject, useStarProject } from "./projectMutations";

/** The favourite star next to a project's name (SPEC §11): starred projects come first. */
export function StarButton({ project }: { project: LibraryProject }) {
  const { t } = useTranslation();
  const star = useStarProject();
  const starred = project.starred;
  return (
    <ActionIcon
      size={44}
      variant="subtle"
      color={starred ? "yellow" : "gray"}
      aria-label={t(starred ? "library.unstar" : "library.star", { name: project.name })}
      aria-pressed={starred}
      data-testid="project-star"
      data-starred={starred}
      onClick={() => {
        star.mutate({ id: project.id, starred: !starred });
      }}
    >
      {starred ? <IconStarFilled size={20} /> : <IconStar size={20} />}
    </ActionIcon>
  );
}

/** "Play all" in the menu: the queue loads when the menu opens, so the tap starts audio (iOS). */
function PlayAllItem({ project }: { project: LibraryProject }) {
  const { t } = useTranslation();
  const { queue, play } = useProjectPlay(project);
  return (
    <Menu.Item
      leftSection={<IconPlayerPlayFilled size={14} />}
      disabled={!queue.data}
      onClick={() => {
        play();
      }}
      data-testid="project-menu-play"
    >
      {t("listen.playAll")}
    </Menu.Item>
  );
}

function ArchiveItem({ project }: { project: LibraryProject }) {
  const { t } = useTranslation();
  const archive = useArchiveProject(project.id);
  const archived = project.archivedAt !== null;
  return (
    <Menu.Item
      leftSection={archived ? <IconArchiveOff size={14} /> : <IconArchive size={14} />}
      onClick={() => {
        archive.mutate(!archived);
      }}
      data-testid="project-menu-archive"
    >
      {t(archived ? "projects.unarchive" : "projects.archive")}
    </Menu.Item>
  );
}

/**
 * The "..." menu of a Library project (SPEC §11): open, play all, offline, edit and archive. Each
 * action shows only with the capability the project page asks for.
 */
export function ProjectMenu({
  project,
  overlay = false,
}: {
  project: LibraryProject;
  /** On a cover: a filled, translucent button that reads on any image. */
  overlay?: boolean;
}) {
  const { t } = useTranslation();
  const online = useOnline();
  const [offlineOpen, setOfflineOpen] = useState(false);
  const key = itemKey("project", project.id);
  const offlineItem = useOffline((s) => s.items.find((i) => i.key === key));
  const offlineReady = useOffline((s) => s.userId !== null) && offlineSupported();
  const caps = new Set(project.access.capabilities);
  const canEdit = caps.has("settings.manage") || caps.has("grants.manage");
  const canArchive = caps.has("settings.manage");
  const to = `/projects/${project.id}`;

  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            size={44}
            radius={overlay ? "xl" : undefined}
            variant={overlay ? "filled" : "subtle"}
            color={overlay ? "dark" : "gray"}
            style={overlay ? { opacity: 0.85 } : undefined}
            aria-label={t("library.actions", { name: project.name })}
            data-testid="project-menu"
          >
            <IconDots size={20} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item component={Link} to={to} leftSection={<IconExternalLink size={14} />}>
            {t("library.open")}
          </Menu.Item>
          <PlayAllItem project={project} />
          {offlineReady &&
            (offlineItem ? (
              <Menu.Item
                leftSection={<IconTrash size={14} />}
                disabled={offlineItem.status === "downloading"}
                onClick={() => void removeOffline(key)}
                data-testid="project-menu-offline"
                data-offline="true"
              >
                {t("offline.remove")}
              </Menu.Item>
            ) : (
              <Menu.Item
                leftSection={<IconCloudDown size={14} />}
                disabled={!online}
                onClick={() => {
                  setOfflineOpen(true);
                }}
                data-testid="project-menu-offline"
                data-offline="false"
              >
                {t("offline.button.makeHint")}
              </Menu.Item>
            ))}
          {canEdit && (
            <Menu.Item
              component={Link}
              to={`${to}?tab=settings`}
              leftSection={<IconPencil size={14} />}
              data-testid="project-menu-edit"
            >
              {t("library.edit")}
            </Menu.Item>
          )}
          {canArchive && <ArchiveItem project={project} />}
        </Menu.Dropdown>
      </Menu>
      {offlineOpen && (
        <OfflineModal
          target={{ kind: "project", id: project.id, title: project.name, projectId: project.id }}
          onClose={() => {
            setOfflineOpen(false);
          }}
        />
      )}
    </>
  );
}
