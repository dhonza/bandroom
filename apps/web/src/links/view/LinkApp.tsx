import { openLink, unlockLink, type LinkOpenResult } from "@bandroom/shared";
import {
  Alert,
  Box,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Route, Routes, useParams } from "react-router";
import { api, ApiError } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { ProjectImage } from "../../components/ProjectImage";
import { BrandLogo } from "../../branding/BrandLogo";
import { useClientConfig } from "../../config/ClientConfigContext";
import { stopPlayer } from "../../rehearse/controller";
import { ColorSchemeToggle } from "../../shell/ColorSchemeToggle";
import { LanguageSwitcher } from "../../shell/LanguageSwitcher";
import { enterLinkMode, leaveLinkMode, setLinkView, useLinkMode } from "../linkMode";
import { LinkProjectView } from "./LinkProjectView";
import { LinkSongView } from "./LinkSongView";
import { useLinkPlayReport } from "./useLinkPlayReport";
import { errorMessage } from "../../api/errorMessage";

const OPEN_KEY = ["link", "open"] as const;
/** The link is re-checked this often, so a revoked or deactivated link locks visitors out. */
const RECHECK_MS = 60_000;

/**
 * The public link view (SPEC §11.2): no app navigation, the instance name and project image, a
 * password prompt when needed, then the project's songs or the song's player. It runs in link
 * mode with its own query cache (see linkMode.ts).
 */
export function LinkApp() {
  const { token = "" } = useParams();
  const [queryClient] = useState(makeLinkQueryClient);
  // Link mode is on before the first child renders (queries start in child effects), and again
  // after StrictMode's simulated remount.
  useState(() => {
    enterLinkMode(token);
  });
  useLayoutEffect(() => {
    enterLinkMode(token);
    return () => {
      stopPlayer();
      leaveLinkMode();
    };
  }, [token]);
  return (
    <QueryClientProvider client={queryClient}>
      <LinkShell token={token} />
    </QueryClientProvider>
  );
}

function makeLinkQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
    queryCache: new QueryCache({
      // A failing request may mean the session ended or the link is gone: ask the server.
      onError: (err, query) => {
        if (query.queryKey[0] === OPEN_KEY[0]) return;
        if (err instanceof ApiError && ["UNAUTHENTICATED", "NOT_FOUND"].includes(err.code)) {
          void client.invalidateQueries({ queryKey: OPEN_KEY });
        }
      },
    }),
  });
  return client;
}

function LinkShell({ token }: { token: string }) {
  const { t } = useTranslation();
  const open = useQuery({
    queryKey: OPEN_KEY,
    queryFn: async (): Promise<LinkOpenResult> => {
      const r = await api(openLink);
      setLinkView(r.state === "open" ? r.view : null);
      return r;
    },
    staleTime: Infinity,
    refetchInterval: RECHECK_MS,
    refetchOnWindowFocus: true,
  });
  const opened = open.data?.state === "open" ? open.data.view : null;
  // The store feeds components deep in the player (comments, visitor name).
  useEffect(() => {
    setLinkView(opened);
  }, [opened]);
  const view = useLinkMode((s) => s.view) ?? opened;
  useLinkPlayReport();
  const gone = open.error instanceof ApiError && open.error.code === "NOT_FOUND";
  const locked = gone || open.data?.state === "password";
  // Revoked, deactivated, expired or session over: stop whatever was playing.
  useEffect(() => {
    if (locked) stopPlayer();
  }, [locked]);

  let body: ReactNode;
  if (open.isPending) {
    body = (
      <Center mih={200}>
        <Loader />
      </Center>
    );
  } else if (gone) {
    body = <Unavailable />;
  } else if (open.isError) {
    body = <Alert color="red">{errorMessage(t, open.error)}</Alert>;
  } else if (open.data.state === "password") {
    body = <PasswordPrompt />;
  } else if (view) {
    body = (
      <Routes>
        <Route
          index
          element={
            view.songId ? (
              <LinkSongView songId={view.songId} token={token} />
            ) : (
              <LinkProjectView token={token} />
            )
          }
        />
        <Route path="songs/:songId" element={<LinkSongRoute token={token} />} />
        <Route path="*" element={<Unavailable />} />
      </Routes>
    );
  }

  return (
    <Box mih="100dvh" style={{ background: "var(--mantine-color-body)" }}>
      <Container size="lg" px={{ base: "md", sm: "lg" }} py="md" data-testid="link-view">
        <Stack gap="lg">
          <LinkHeader />
          {body}
        </Stack>
      </Container>
    </Box>
  );
}

function LinkSongRoute({ token }: { token: string }) {
  const { songId = "" } = useParams();
  return <LinkSongView songId={songId} token={token} />;
}

function LinkHeader() {
  const { appName } = useClientConfig();
  const view = useLinkMode((s) => s.view);
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm">
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
        {view && (
          <ProjectImage
            name={view.project.name}
            color={view.project.color}
            imageHash={view.project.imageHash}
            size={48}
          />
        )}
        <Stack gap={0} style={{ minWidth: 0 }}>
          {view && (
            <Text fw={700} truncate data-testid="link-project-name">
              {view.project.name}
            </Text>
          )}
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <BrandLogo alt="" height={18} />
            <Text size="xs" c="dimmed" truncate data-testid="link-instance-name">
              {appName}
            </Text>
          </Group>
        </Stack>
      </Group>
      <Group gap={0} wrap="nowrap">
        <LanguageSwitcher />
        <ColorSchemeToggle />
      </Group>
    </Group>
  );
}

function Unavailable() {
  const { t } = useTranslation();
  return (
    <Paper withBorder radius="md" p="lg" data-testid="link-unavailable">
      <Stack gap="xs">
        <Title order={2} size="h3">
          {t("links.view.unavailableTitle")}
        </Title>
        <Text c="dimmed">{t("links.view.unavailable")}</Text>
      </Stack>
    </Paper>
  );
}

function PasswordPrompt() {
  const { t } = useTranslation();
  const apiError = useApiError();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { view } = await api(unlockLink, { body: { password } });
      setLinkView(view);
      const opened: LinkOpenResult = { state: "open", view };
      qc.setQueryData(OPEN_KEY, opened);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "WRONG_PASSWORD"
          ? t("links.view.wrongPassword")
          : apiError(err),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Paper withBorder radius="md" p="lg" maw={420} data-testid="link-password-prompt">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <Group gap="xs">
            <IconLock size={20} />
            <Title order={2} size="h4">
              {t("links.view.passwordTitle")}
            </Title>
          </Group>
          <Text size="sm" c="dimmed">
            {t("links.view.passwordExplain")}
          </Text>
          {error && (
            <Alert color="red" data-testid="link-password-error">
              {error}
            </Alert>
          )}
          <PasswordInput
            label={t("links.view.password")}
            value={password}
            autoComplete="current-password"
            data-autofocus
            onChange={(e) => {
              setPassword(e.currentTarget.value);
            }}
            data-testid="link-password-input"
          />
          <Button
            type="submit"
            h={44}
            loading={busy}
            disabled={!password}
            data-testid="link-unlock"
          >
            {t("links.view.unlock")}
          </Button>
          <Text size="xs" c="dimmed">
            {t("links.view.privacy")}
          </Text>
        </Stack>
      </form>
    </Paper>
  );
}
