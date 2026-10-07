import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import {
  IconFileText,
  IconLink,
  IconMusic,
  IconSettings,
  IconShare,
  IconTrash,
} from "@tabler/icons-react";
import { LinksPanel } from "../../links/LinksPanel";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router";
import { ApiError } from "../../api/client";
import { ProjectImage } from "../../components/ProjectImage";
import { NotFoundPage } from "../../pages/NotFoundPage";
import { useFormatters } from "../../i18n/format";
import { useProject } from "../library/queries";
import { PlayAllButton } from "./PlayAllButton";
import { ProjectSettings } from "./ProjectSettings";
import { SongsList } from "./SongsList";
import { FollowButton } from "../../notifications/FollowButton";
import { OfflineButton } from "../../offline/OfflineButton";
import { ProjectDocumentsTab } from "../../documents/ProjectDocumentsTab";
import { errorMessage } from "../../api/errorMessage";
import { BackLink } from "../../components/BackLink";
import { TrashPanel } from "../../trash/TrashPanel";
import { useProjectTrash } from "../../trash/queries";

/** Project page (SPEC §11.2): songs, documents, settings. The Activity tab arrives in M13. */
export function ProjectPage() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const query = useProject(projectId);

  if (query.isPending) {
    return (
      <Center mih={200}>
        <Loader />
      </Center>
    );
  }
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.code === "NOT_FOUND")
      return <NotFoundPage />;
    return <Alert color="red">{errorMessage(t, query.error)}</Alert>;
  }

  const project = query.data.project;
  const caps = new Set(project.access.capabilities);
  const canManage = caps.has("settings.manage") || caps.has("grants.manage");
  const canLink = caps.has("link.manage");
  // The Trash (SPEC §26.3) is for users who may delete something in the project.
  const canTrash = caps.has("delete.own") && project.visibility === "full";
  const requested = params.get("tab");
  const tab =
    requested === "settings" && canManage
      ? "settings"
      : requested === "links" && canLink
        ? "links"
        : requested === "trash" && canTrash
          ? "trash"
          : requested === "documents"
            ? "documents"
            : "songs";

  return (
    <Stack gap="lg">
      <BackLink to="/library">{t("pages.library.title")}</BackLink>
      <Group gap="md" wrap="nowrap" align="flex-start">
        <ProjectImage
          name={project.name}
          color={project.color}
          imageHash={project.imageHash}
          size={72}
        />
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Group gap="xs">
            <Title order={2} style={{ overflowWrap: "anywhere" }}>
              {project.name}
            </Title>
            {project.archivedAt !== null && (
              <Badge variant="light" color="gray">
                {t("projects.archivedBadge")}
              </Badge>
            )}
          </Group>
          {project.description && (
            <Text c="dimmed" size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {project.description}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {t("counts.songs", { count: project.songCount })}
            {project.bytes != null && (
              <span data-testid="project-bytes"> · {fmt.bytes(project.bytes)}</span>
            )}
            {project.ownerDisplayName
              ? ` · ${t("projects.ownedBy", { name: project.ownerDisplayName })}`
              : ""}
            {` · ${t(`contentRoles.${project.access.role}`)}`}
          </Text>
        </Stack>
      </Group>

      <Group gap="xs" wrap="wrap">
        <PlayAllButton project={project} />
        <FollowButton target="project" id={project.id} />
        <OfflineButton kind="project" id={project.id} title={project.name} projectId={project.id} />
        {canLink && (
          <Button
            variant="default"
            h={44}
            leftSection={<IconShare size={16} />}
            onClick={() => {
              setParams({ tab: "links" }, { replace: true });
            }}
            data-testid="project-share"
          >
            {t("links.share")}
          </Button>
        )}
      </Group>

      {project.visibility === "reduced" && (
        <Alert color="gray" variant="light">
          {t("projects.reducedExplain")}
        </Alert>
      )}

      <Tabs
        value={tab}
        onChange={(v) => {
          setParams(
            v === "settings" || v === "documents" || v === "links" || v === "trash"
              ? { tab: v }
              : {},
            { replace: true },
          );
        }}
        keepMounted={false}
      >
        <Tabs.List>
          <Tabs.Tab value="songs" leftSection={<IconMusic size={16} />} mih={44}>
            {t("projects.tabs.songs")}
          </Tabs.Tab>
          <Tabs.Tab
            value="documents"
            leftSection={<IconFileText size={16} />}
            mih={44}
            data-testid="project-documents-tab"
          >
            {t("projects.tabs.documents")}
          </Tabs.Tab>
          {canLink && (
            <Tabs.Tab
              value="links"
              leftSection={<IconLink size={16} />}
              mih={44}
              data-testid="project-links-tab"
            >
              {t("links.tab")}
            </Tabs.Tab>
          )}
          {canTrash && (
            <Tabs.Tab
              value="trash"
              leftSection={<IconTrash size={16} />}
              mih={44}
              data-testid="project-trash-tab"
            >
              {t("trash.projectTab")}
            </Tabs.Tab>
          )}
          {canManage && (
            <Tabs.Tab
              value="settings"
              leftSection={<IconSettings size={16} />}
              mih={44}
              data-testid="project-settings-tab"
            >
              {t("projects.tabs.settings")}
            </Tabs.Tab>
          )}
        </Tabs.List>
        <Tabs.Panel value="songs" pt="md">
          <SongsList project={project} />
        </Tabs.Panel>
        <Tabs.Panel value="documents" pt="md">
          <ProjectDocumentsTab project={project} />
        </Tabs.Panel>
        {canLink && (
          <Tabs.Panel value="links" pt="md">
            <Stack gap="sm" maw={760}>
              <Text size="sm" c="dimmed">
                {t("links.projectExplain")}
              </Text>
              <LinksPanel owner={{ kind: "project", projectId: project.id }} canCreate showWhere />
            </Stack>
          </Tabs.Panel>
        )}
        {canTrash && (
          <Tabs.Panel value="trash" pt="md">
            <ProjectTrash projectId={project.id} />
          </Tabs.Panel>
        )}
        {canManage && (
          <Tabs.Panel value="settings" pt="md">
            <ProjectSettings project={project} />
          </Tabs.Panel>
        )}
      </Tabs>
    </Stack>
  );
}

function ProjectTrash({ projectId }: { projectId: string }) {
  const query = useProjectTrash(projectId);
  return <TrashPanel scope={`project:${projectId}`} query={query} />;
}
