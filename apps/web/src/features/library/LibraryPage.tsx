import { hasGlobalCapability } from "@bandroom/shared";
import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Chip,
  Group,
  Loader,
  Menu,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconArrowsSort,
  IconBooks,
  IconCheck,
  IconLayoutGrid,
  IconList,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../auth/session";
import { errorMessage } from "../../api/errorMessage";
import { CreateProjectModal } from "./CreateProjectModal";
import {
  LIBRARY_VIEWS,
  loadLibraryPrefs,
  saveLibraryPrefs,
  type LibraryPrefs,
} from "./libraryPrefs";
import { ProjectCard, ProjectRow } from "./ProjectTiles";
import { useProjects } from "./queries";
import {
  filterProjects,
  LIBRARY_FILTERS,
  SORT_KEYS,
  SORT_ORDERS,
  sortProjects,
} from "./sortProjects";

/**
 * Library (SPEC §11.2): projects as a grid or list with filter tabs, a sort menu, search and an
 * archived filter; starred projects first. View, sort and filter are remembered on this device.
 */
export function LibraryPage() {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState<LibraryPrefs>(loadLibraryPrefs);
  const [createOpen, create] = useDisclosure(false);
  const projects = useProjects(archived);
  const canCreate = hasGlobalCapability({ ...user, disabledAt: null }, "project.create");

  useEffect(() => {
    saveLibraryPrefs(prefs);
  }, [prefs]);
  const set = (patch: Partial<LibraryPrefs>) => {
    setPrefs((p) => ({ ...p, ...patch }));
  };

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const list = filterProjects(projects.data?.projects ?? [], prefs.filter, user.id).filter((p) =>
      p.name.toLocaleLowerCase().includes(q),
    );
    return sortProjects(list, prefs.sort, prefs.order);
  }, [projects.data, query, prefs.filter, prefs.sort, prefs.order, user.id]);

  const empty = query
    ? t("library.noMatches")
    : archived
      ? t("library.noArchived")
      : prefs.filter !== "all"
        ? t("library.noneInFilter")
        : t("pages.library.empty");

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

      <Stack gap="sm">
        <SegmentedControl
          aria-label={t("library.filter")}
          value={prefs.filter}
          onChange={(v) => {
            set({ filter: v });
          }}
          data={LIBRARY_FILTERS.map((f) => ({ value: f, label: t(`library.filters.${f}`) }))}
          style={{ alignSelf: "flex-start" }}
          data-testid="library-filter"
        />
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
          <Group gap="xs" wrap="nowrap">
            <Chip checked={archived} onChange={setArchived} data-testid="show-archived">
              {t("library.archived")}
            </Chip>
            <Menu position="bottom-end" withinPortal closeOnItemClick={false}>
              <Menu.Target>
                <Tooltip label={t("library.sort")}>
                  <ActionIcon
                    size={44}
                    variant="default"
                    aria-label={t("library.sort")}
                    data-testid="library-sort"
                  >
                    <IconArrowsSort size={20} />
                  </ActionIcon>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown data-testid="library-sort-menu">
                <Menu.Label>{t("library.sortBy")}</Menu.Label>
                {SORT_KEYS.map((key) => (
                  <Menu.Item
                    key={key}
                    role="menuitemradio"
                    aria-checked={prefs.sort === key}
                    leftSection={<Check on={prefs.sort === key} />}
                    onClick={() => {
                      set({ sort: key });
                    }}
                    data-testid={`sort-${key}`}
                  >
                    {t(`library.sortKeys.${key}`)}
                  </Menu.Item>
                ))}
                <Menu.Divider />
                <Menu.Label>{t("library.order")}</Menu.Label>
                {SORT_ORDERS.map((order) => (
                  <Menu.Item
                    key={order}
                    role="menuitemradio"
                    aria-checked={prefs.order === order}
                    leftSection={<Check on={prefs.order === order} />}
                    onClick={() => {
                      set({ order });
                    }}
                    data-testid={`order-${order}`}
                  >
                    {t(`library.orders.${order}`)}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
            <Group gap={0} wrap="nowrap" role="group" aria-label={t("library.view")}>
              {LIBRARY_VIEWS.map((view) => (
                <Tooltip key={view} label={t(`library.views.${view}`)}>
                  <ActionIcon
                    size={44}
                    variant={prefs.view === view ? "light" : "subtle"}
                    color={prefs.view === view ? undefined : "gray"}
                    aria-label={t(`library.views.${view}`)}
                    aria-pressed={prefs.view === view}
                    onClick={() => {
                      set({ view });
                    }}
                    data-testid={`library-view-${view}`}
                  >
                    {view === "grid" ? <IconLayoutGrid size={20} /> : <IconList size={20} />}
                  </ActionIcon>
                </Tooltip>
              ))}
            </Group>
          </Group>
        </Group>
      </Stack>

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
              {empty}
            </Text>
            {canCreate && !query && !archived && prefs.filter !== "shared" && (
              <Button leftSection={<IconPlus size={18} />} onClick={create.open}>
                {t("projects.create")}
              </Button>
            )}
          </Stack>
        </Center>
      ) : prefs.view === "list" ? (
        <Stack gap="xs" data-testid="project-list">
          {shown.map((p) => (
            <ProjectRow key={p.id} project={p} sort={prefs.sort} />
          ))}
        </Stack>
      ) : (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 4, xl: 5 }} spacing="md" data-testid="project-grid">
          {shown.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </SimpleGrid>
      )}

      <CreateProjectModal opened={createOpen} onClose={create.close} />
    </Stack>
  );
}

/** Checkmark column of the sort menu (kept as wide when empty, so labels line up). */
function Check({ on }: { on: boolean }) {
  return on ? <IconCheck size={14} /> : <span style={{ display: "inline-block", width: 14 }} />;
}
