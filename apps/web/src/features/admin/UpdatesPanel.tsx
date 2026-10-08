import {
  cancelAdminUpdate,
  compareTagsDesc,
  getAdminUpdates,
  RELEASE_TAG_RE,
  requestAdminUpdate,
  type UpdatesState,
} from "@bandroom/shared";
import {
  Alert,
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { useFormatters } from "../../i18n/format";
import { useOnline } from "../../offline/online";
import { useAdminUsers } from "./queries";

export const ADMIN_UPDATES_KEY = ["admin", "updates"] as const;
/** Polling while a request exists or the app restarts. */
export const UPDATES_POLL_MS = 5000;
/** Polling continues this long after the request disappears (SPEC §29.8). */
export const UPDATES_WATCH_MS = 3 * 60_000;
/** The host timer reports every 15 min; twice that means the watcher is not running. */
const HOST_STALE_MS = 30 * 60_000;

type CheckMode = "true" | "false" | "force";
interface UpdatesData {
  state: UpdatesState;
  /** The registry check failed; `state` is then the unchecked state. */
  checkError: unknown;
  /** A request is being followed (polling; fetch errors mean the app is restarting). */
  watching: boolean;
  /** The version a followed request ended up running. */
  nowRunning: string | null;
}

/** A watched request: polled until the running version changes or the watch expires. */
interface Watch {
  running: string;
  /** Set once the request is gone (finished or cancelled). */
  until: number | null;
}

/** "0.6.3" or "v0.6.3" → "v0.6.3"; null when it is not a release version. */
function asTag(version: string): string | null {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return RELEASE_TAG_RE.test(tag) ? tag : null;
}

/** Admin → Updates (SPEC §29.8): deploy a newer release, roll back, follow the host watcher. */
export function UpdatesPanel({
  pollMs = UPDATES_POLL_MS,
  watchMs = UPDATES_WATCH_MS,
}: {
  /** Shorter in tests. */
  pollMs?: number;
  watchMs?: number;
} = {}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const fmt = useFormatters();
  const online = useOnline();
  const queryClient = useQueryClient();
  const users = useAdminUsers();
  // The first fetch asks the registry (cached 1 h), "Check again" forces it, polls only read.
  const nextCheck = useRef<CheckMode>("true");
  // The followed request; read and written only in the query function and event handlers.
  const watch = useRef<Watch | null>(null);
  const nowRunning = useRef<string | null>(null);
  const [deployTag, setDeployTag] = useState<string | null>(null);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);

  const query = useQuery({
    queryKey: ADMIN_UPDATES_KEY,
    retry: false,
    queryFn: async ({ signal }): Promise<UpdatesData> => {
      const check = nextCheck.current;
      nextCheck.current = "false";
      let state: UpdatesState;
      let checkError: unknown = null;
      try {
        state = await api(getAdminUpdates, { query: { check } }, { signal });
      } catch (err) {
        if (check === "false" || !(err instanceof ApiError) || err.code !== "UPDATE_CHECK_FAILED")
          throw err;
        state = await api(getAdminUpdates, { query: { check: "false" } }, { signal });
        checkError = err;
      }
      follow(state);
      return {
        state,
        checkError,
        watching: watch.current !== null,
        nowRunning: nowRunning.current,
      };
    },
    refetchInterval: () => {
      const w = watch.current;
      return w && (w.until === null || Date.now() < w.until) ? pollMs : false;
    },
  });
  const loaded = query.data?.state;

  /** Follows a request until the running version changes or the watch expires. */
  function follow(next: UpdatesState) {
    const w = watch.current;
    if (w && next.running !== w.running) {
      nowRunning.current = next.running;
      watch.current = null;
    } else if (next.request) {
      watch.current = { running: w?.running ?? next.running, until: null };
    } else if (w) {
      if (w.until === null) watch.current = { ...w, until: Date.now() + watchMs };
      else if (Date.now() >= w.until) watch.current = null;
    }
  }

  const onRequested = (running: string) => {
    nowRunning.current = null;
    watch.current = { running, until: null };
    void queryClient.invalidateQueries({ queryKey: ADMIN_UPDATES_KEY });
  };
  const deploy = useMutation({
    mutationFn: (tag: string) => api(requestAdminUpdate, { body: { action: "deploy", tag } }),
    onSuccess: () => {
      setDeployTag(null);
      if (loaded) onRequested(loaded.running);
    },
  });
  const rollback = useMutation({
    mutationFn: (confirmRunningVersion: string) =>
      api(requestAdminUpdate, { body: { action: "rollback", confirmRunningVersion } }),
    onSuccess: () => {
      setRollbackOpen(false);
      if (loaded) onRequested(loaded.running);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api(cancelAdminUpdate, undefined),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ADMIN_UPDATES_KEY }),
  });

  const data = query.data;
  if (query.isPending) return <Loader />;
  if (!data) return <Alert color="red">{apiError(query.error)}</Alert>;
  const state = data.state;

  // The time of the last answer stands in for "now" (render stays pure).
  const now = query.dataUpdatedAt;
  const busy = state.request !== null;
  const runningTag = asTag(state.running);
  const isNewer = (tag: string) => runningTag === null || compareTagsDesc(tag, runningTag) < 0;
  const hostStale = state.hostStatusAt === null || now - state.hostStatusAt > HOST_STALE_MS;
  const nameOf = (username: string) =>
    users.data?.users.find((u) => u.username === username)?.displayName ?? username;
  const restarting = data.watching && query.isError;
  const newRunning = data.nowRunning;
  const result = state.lastResult;

  return (
    <Stack maw={760}>
      <Text size="sm" c="dimmed">
        {t("admin.updates.explain")}
      </Text>

      <Paper withBorder radius="md" p="sm">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              {t("admin.updates.running")}
            </Text>
            <Text fw={600} size="lg" data-testid="updates-running">
              {state.running}
            </Text>
          </Stack>
          <Button
            color="red"
            variant="light"
            mih={44}
            disabled={!online || busy}
            onClick={() => {
              rollback.reset();
              setRollbackOpen(true);
            }}
            data-testid="updates-rollback"
          >
            {t("admin.updates.rollback")}
          </Button>
        </Group>
      </Paper>

      {hostStale && (
        <Alert color="yellow" data-testid="updates-watcher-warning">
          {state.hostStatusAt === null
            ? t("admin.updates.watcherMissing")
            : t("admin.updates.watcherStale", { when: fmt.relative(state.hostStatusAt) })}
        </Alert>
      )}
      {restarting && (
        <Alert color="gray" data-testid="updates-restarting">
          {t("admin.updates.restarting")}
        </Alert>
      )}
      {!restarting && query.isError && <Alert color="red">{apiError(query.error)}</Alert>}
      {newRunning !== null && (
        <Alert color="green" data-testid="updates-now-running">
          {t("admin.updates.nowRunning", { version: newRunning })}
        </Alert>
      )}
      {cancel.isError && <Alert color="red">{apiError(cancel.error)}</Alert>}

      {state.request && (
        <Paper withBorder radius="md" p="sm" data-testid="updates-request">
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Group gap={6}>
                <Text size="sm" fw={500}>
                  {state.request.action === "deploy"
                    ? t("admin.updates.actionDeploy", { tag: state.request.tag ?? "" })
                    : t("admin.updates.actionRollback")}
                </Text>
                <Badge
                  size="sm"
                  variant="light"
                  color={state.request.state === "running" ? "blue" : "yellow"}
                >
                  {state.request.state === "running"
                    ? t("admin.updates.stateRunning")
                    : t("admin.updates.statePending")}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed">
                {t("admin.updates.requestedBy", {
                  name: nameOf(state.request.requestedBy),
                  when: fmt.relative(state.request.ts),
                })}
              </Text>
            </Stack>
            <Button
              variant="subtle"
              color="red"
              mih={44}
              disabled={!online || state.request.state !== "pending"}
              loading={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
              data-testid="updates-cancel"
            >
              {t("admin.updates.cancelRequest")}
            </Button>
          </Group>
        </Paper>
      )}

      <Stack gap="xs">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Title order={4}>{t("admin.updates.releases")}</Title>
          <Button
            variant="default"
            mih={44}
            leftSection={<IconRefresh size={16} />}
            disabled={!online}
            loading={query.isFetching}
            onClick={() => {
              nextCheck.current = "force";
              void query.refetch();
            }}
            data-testid="updates-check"
          >
            {t("admin.updates.checkAgain")}
          </Button>
        </Group>
        <Text size="xs" c="dimmed" data-testid="updates-checked">
          {state.checkedAt === null
            ? t("admin.updates.notChecked")
            : t("admin.updates.checked", { when: fmt.relative(state.checkedAt) })}
        </Text>
        {data.checkError !== null && (
          <Alert color="red" data-testid="updates-check-error">
            {apiError(data.checkError)}
          </Alert>
        )}
        {state.available?.length === 0 && <Text c="dimmed">{t("admin.updates.noReleases")}</Text>}
        {state.available?.map((tag) => {
          const current = tag === runningTag;
          const newer = !current && isNewer(tag);
          return (
            <Paper key={tag} withBorder radius="md" p="xs" data-testid="updates-release">
              <Group justify="space-between" wrap="nowrap" mih={44}>
                <Group gap={6}>
                  <Text size="sm" fw={current ? 600 : 400}>
                    {tag}
                  </Text>
                  {current && (
                    <Badge size="sm" variant="light" color="green">
                      {t("admin.updates.current")}
                    </Badge>
                  )}
                </Group>
                {newer && (
                  <Button
                    size="sm"
                    mih={44}
                    disabled={!online || busy}
                    aria-label={t("admin.updates.deployNamed", { tag })}
                    onClick={() => {
                      deploy.reset();
                      setDeployTag(tag);
                    }}
                  >
                    {t("admin.updates.deploy")}
                  </Button>
                )}
              </Group>
            </Paper>
          );
        })}
        {state.available?.some((tag) => tag !== runningTag && !isNewer(tag)) && (
          <Text size="xs" c="dimmed">
            {t("admin.updates.olderHint")}
          </Text>
        )}
      </Stack>

      {result && (
        <Paper withBorder radius="md" p="sm" data-testid="updates-last-result">
          <Stack gap={6}>
            <Group gap={6} wrap="wrap">
              <Text size="sm" fw={500}>
                {t("admin.updates.lastResult")}:{" "}
                {result.action === "deploy"
                  ? t("admin.updates.actionDeploy", { tag: result.tag ?? "" })
                  : t("admin.updates.actionRollback")}
              </Text>
              <Badge size="sm" variant="light" color={result.exitCode === 0 ? "green" : "red"}>
                {result.exitCode === 0
                  ? t("admin.updates.success")
                  : t("admin.updates.failure", { code: result.exitCode })}
              </Badge>
            </Group>
            <Group gap="md" wrap="wrap">
              {result.startedAt !== null && (
                <Text size="xs" c="dimmed">
                  {t("admin.updates.started", { when: fmt.dateTime(result.startedAt) })}
                </Text>
              )}
              {result.finishedAt !== null && (
                <Text size="xs" c="dimmed">
                  {t("admin.updates.finished", { when: fmt.dateTime(result.finishedAt) })}
                </Text>
              )}
            </Group>
            {result.error !== null && (
              <Text size="sm" c="red">
                {result.error}
              </Text>
            )}
            <Button
              variant="subtle"
              size="compact-sm"
              mih={44}
              style={{ alignSelf: "flex-start" }}
              onClick={() => {
                setOutputOpen((o) => !o);
              }}
              aria-expanded={outputOpen}
            >
              {outputOpen ? t("admin.updates.hideOutput") : t("admin.updates.showOutput")}
            </Button>
            <Collapse expanded={outputOpen}>
              {result.outputTail === "" ? (
                <Text size="xs" c="dimmed">
                  {t("admin.updates.noOutput")}
                </Text>
              ) : (
                <Code block style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap" }}>
                  {result.outputTail}
                </Code>
              )}
            </Collapse>
          </Stack>
        </Paper>
      )}

      <Modal
        opened={deployTag !== null}
        onClose={() => {
          setDeployTag(null);
        }}
        title={t("admin.updates.deployTitle", { tag: deployTag ?? "" })}
      >
        <Stack>
          <Text size="sm">
            {t("admin.updates.deployBody", { tag: deployTag ?? "", running: state.running })}
          </Text>
          {deploy.isError && <Alert color="red">{apiError(deploy.error)}</Alert>}
          <Group justify="flex-end">
            <Button
              variant="default"
              mih={44}
              onClick={() => {
                setDeployTag(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              mih={44}
              loading={deploy.isPending}
              disabled={!online}
              onClick={() => {
                if (deployTag) deploy.mutate(deployTag);
              }}
              data-testid="updates-deploy-confirm"
            >
              {t("admin.updates.deployConfirm", { tag: deployTag ?? "" })}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <RollbackModal
        opened={rollbackOpen}
        running={state.running}
        pending={rollback.isPending}
        error={rollback.isError ? apiError(rollback.error) : null}
        disabled={!online}
        onClose={() => {
          setRollbackOpen(false);
        }}
        onConfirm={(typed) => {
          rollback.mutate(typed);
        }}
      />
    </Stack>
  );
}

interface RollbackProps {
  opened: boolean;
  running: string;
  pending: boolean;
  error: string | null;
  disabled: boolean;
  onClose: () => void;
  onConfirm: (typed: string) => void;
}

function RollbackModal(props: RollbackProps) {
  const { t } = useTranslation();
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title={t("admin.updates.rollbackTitle", { running: props.running })}
    >
      {/* Unmounted while closed, so the typed text starts empty each time. */}
      <RollbackForm {...props} />
    </Modal>
  );
}

function RollbackForm(props: RollbackProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  return (
    <Stack>
      <Text size="sm">{t("admin.updates.rollbackBody", { running: props.running })}</Text>
      <TextInput
        label={t("admin.updates.rollbackType", { running: props.running })}
        value={typed}
        onChange={(e) => {
          setTyped(e.currentTarget.value);
        }}
        autoComplete="off"
        data-testid="updates-rollback-input"
      />
      {props.error !== null && <Alert color="red">{props.error}</Alert>}
      <Group justify="flex-end">
        <Button variant="default" mih={44} onClick={props.onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          color="red"
          mih={44}
          loading={props.pending}
          disabled={props.disabled || typed !== props.running}
          onClick={() => {
            props.onConfirm(typed);
          }}
          data-testid="updates-rollback-confirm"
        >
          {t("admin.updates.rollbackConfirm")}
        </Button>
      </Group>
    </Stack>
  );
}
