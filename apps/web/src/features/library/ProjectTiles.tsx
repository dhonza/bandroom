import type { LibraryProject } from "@bandroom/shared";
import { AspectRatio, Badge, Card, Group, Paper, Stack, Text } from "@mantine/core";
import { IconCloudCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ProjectImage } from "../../components/ProjectImage";
import { useFormatters } from "../../i18n/format";
import { useOffline } from "../../offline/controller";
import { ProjectMenu, StarButton } from "./ProjectMenu";
import classes from "./ProjectTile.module.css";
import { sortTime, type SortKey } from "./sortProjects";

function ProjectBadges({ project }: { project: LibraryProject }) {
  const { t } = useTranslation();
  // Offline badge: the project or one of its songs is on this device (SPEC §11.2).
  const offline = useOffline((s) => s.items.some((i) => i.projectId === project.id));
  if (project.visibility !== "reduced" && project.archivedAt === null && !offline) return null;
  return (
    <Group gap={6}>
      {offline && (
        <Badge
          size="xs"
          variant="light"
          color="green"
          leftSection={<IconCloudCheck size={12} />}
          data-testid="project-offline-badge"
        >
          {t("offline.badge")}
        </Badge>
      )}
      {project.visibility === "reduced" && (
        <Badge size="xs" variant="light" color="gray">
          {t("projects.reduced")}
        </Badge>
      )}
      {project.archivedAt !== null && (
        <Badge size="xs" variant="light" color="gray">
          {t("projects.archivedBadge")}
        </Badge>
      )}
    </Group>
  );
}

/**
 * The whole card or row opens the project: one link laid over it (a full-size touch target), with
 * the star and menu buttons above it.
 */
function OpenLink({ project }: { project: LibraryProject }) {
  return (
    <Link
      to={`/projects/${project.id}`}
      className={classes.link}
      aria-label={project.name}
      data-testid="project-link"
    />
  );
}

function useCreator(project: LibraryProject): string {
  const { t } = useTranslation();
  return project.createdByName ?? t("library.unknownCreator");
}

/** Grid card (SPEC §11.2): square cover, name with the star, creator and the "..." menu. */
export function ProjectCard({ project }: { project: LibraryProject }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const creator = useCreator(project);
  return (
    <Card withBorder radius="md" padding={0} className={classes.tile} data-testid="project-card">
      <AspectRatio ratio={1}>
        <ProjectImage
          name={project.name}
          color={project.color}
          imageHash={project.imageHash}
          size="100%"
          radius="0"
        />
      </AspectRatio>
      <OpenLink project={project} />
      <div className={`${classes.actions} ${classes.overlay}`}>
        <ProjectMenu project={project} overlay />
      </div>
      <Group gap={0} wrap="nowrap" align="flex-start" p={4} pl="sm">
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }} pt={8}>
          <Text fw={600} lineClamp={1} data-testid="project-name">
            {project.name}
          </Text>
          <Text size="sm" c="dimmed" lineClamp={1} data-testid="project-creator">
            {creator}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {t("counts.songs", { count: project.songCount })} · {fmt.relative(project.updatedAt)}
            {project.bytes != null && (
              <span data-testid="project-bytes"> · {fmt.bytes(project.bytes)}</span>
            )}
          </Text>
          <ProjectBadges project={project} />
        </Stack>
        <div className={classes.actions}>
          <StarButton project={project} />
        </div>
      </Group>
    </Card>
  );
}

/** List row (SPEC §11.2): thumbnail, name with the star, creator, the sort key's time, menu. */
export function ProjectRow({ project, sort }: { project: LibraryProject; sort: SortKey }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const creator = useCreator(project);
  const time = sortTime(project, sort);
  return (
    <Paper
      withBorder
      radius="md"
      p={6}
      pl={8}
      className={`${classes.tile} ${classes.row}`}
      data-testid="project-row"
    >
      <OpenLink project={project} />
      <Group gap="sm" wrap="nowrap">
        <ProjectImage
          name={project.name}
          color={project.color}
          imageHash={project.imageHash}
          size={56}
          radius="var(--mantine-radius-sm)"
        />
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text fw={600} lineClamp={1} data-testid="project-name">
            {project.name}
          </Text>
          <Text size="sm" c="dimmed" lineClamp={1} data-testid="project-creator">
            {creator}
            {` · ${t("counts.songs", { count: project.songCount })}`}
          </Text>
          <ProjectBadges project={project} />
        </Stack>
        <Text
          size="sm"
          c="dimmed"
          visibleFrom="xs"
          style={{ whiteSpace: "nowrap" }}
          data-testid="project-time"
        >
          {time === null ? t("library.neverAccessed") : fmt.relative(time)}
        </Text>
        <Group gap={0} wrap="nowrap" className={classes.actions}>
          <StarButton project={project} />
          <ProjectMenu project={project} />
        </Group>
      </Group>
    </Paper>
  );
}
