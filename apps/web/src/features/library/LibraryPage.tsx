import { hasGlobalCapability, type ProjectSummary } from "@bandroom/shared";
import {
  Alert,
  AspectRatio,
  Badge,
  Button,
  Card,
  Center,
  Chip,
  Group,
  Loader,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconBooks, IconCloudCheck, IconPlus, IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useCurrentUser } from "../../auth/session";
import { useFormatters } from "../../i18n/format";
import { ProjectImage } from "../../components/ProjectImage";
import { CreateProjectModal } from "./CreateProjectModal";
import { useProjects } from "./queries";
import { useOffline } from "../../offline/controller";
import { errorMessage } from "../../api/errorMessage";

type Sort = "recent" | "name";

/** Library (SPEC §11.2): project cards with search, sort and an archived filter. */
export function LibraryPage() {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [createOpen, create] = useDisclosure(false);
  const projects = useProjects(archived);
  const canCreate = hasGlobalCapability({ ...user, disabledAt: null }, "project.create");

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const list = (projects.data?.projects ?? []).filter((p) =>
      p.name.toLocaleLowerCase().includes(q),
    );
    return list.sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt,
    );
  }, [projects.data, query, sort]);

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>{t("pages.library.title")}</Title>
        {canCreate && (
          <Button
            leftSection={<IconPlus size={18} />}
            onClick={create.open}
            data-testid="new-project"
          >
            {t("projects.create")}
          </Button>
        )}
      </Group>

      <Group gap="sm" wrap="wrap">
        <TextInput
          placeholder={t("library.search")}
          aria-label={t("library.search")}
          leftSection={<IconSearch size={16} />}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
          }}
          style={{ flex: "1 1 200px" }}
        />
        <Select
          aria-label={t("library.sort")}
          value={sort}
          allowDeselect={false}
          onChange={(v) => {
            if (v) setSort(v);
          }}
          data={[
            { value: "recent", label: t("library.sortRecent") },
            { value: "name", label: t("library.sortName") },
          ]}
          w={170}
        />
        <Chip checked={archived} onChange={setArchived} data-testid="show-archived">
          {t("library.archived")}
        </Chip>
      </Group>

      {projects.isPending ? (
        <Center mih={200}>
          <Loader />
        </Center>
      ) : projects.isError ? (
        <Alert color="red">{errorMessage(t, projects.error)}</Alert>
      ) : shown.length === 0 ? (
        <Center mih={240}>
          <Stack align="center" gap="sm" maw={420}>
            <ThemeIcon size={64} radius="xl" variant="light">
              <IconBooks size={34} aria-hidden />
            </ThemeIcon>
            <Text ta="center" c="dimmed">
              {query
                ? t("library.noMatches")
                : archived
                  ? t("library.noArchived")
                  : t("pages.library.empty")}
            </Text>
            {canCreate && !query && !archived && (
              <Button leftSection={<IconPlus size={18} />} onClick={create.open}>
                {t("projects.create")}
              </Button>
            )}
          </Stack>
        </Center>
      ) : (
        <SimpleGrid cols={{ base: 1, xs: 2, md: 3, xl: 4 }} spacing="md">
          {shown.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </SimpleGrid>
      )}

      <CreateProjectModal opened={createOpen} onClose={create.close} />
    </Stack>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const { t } = useTranslation();
  // Offline badge: the project or one of its songs is on this device (SPEC §11.2).
  const offline = useOffline((s) => s.items.some((i) => i.projectId === project.id));
  const fmt = useFormatters();
  return (
    <Card
      component={Link}
      to={`/projects/${project.id}`}
      withBorder
      radius="md"
      padding={0}
      data-testid="project-card"
      aria-label={project.name}
    >
      <AspectRatio ratio={16 / 9}>
        <ProjectImage
          name={project.name}
          color={project.color}
          imageHash={project.imageHash}
          size="100%"
          radius="0"
        />
      </AspectRatio>
      <Stack gap={4} p="md">
        <Text fw={600} lineClamp={1}>
          {project.name}
        </Text>
        <Text size="sm" c="dimmed">
          {t("counts.songs", { count: project.songCount })} · {fmt.relative(project.updatedAt)}
          {project.bytes != null && (
            <span data-testid="project-bytes"> · {fmt.bytes(project.bytes)}</span>
          )}
        </Text>
        {(project.visibility === "reduced" || project.archivedAt !== null || offline) && (
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
        )}
      </Stack>
    </Card>
  );
}
