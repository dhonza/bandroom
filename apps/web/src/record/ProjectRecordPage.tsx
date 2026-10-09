import type { Project } from "@bandroom/shared";
import { Alert, Button, Center, Loader, Stack, Text, Title } from "@mantine/core";
import { IconMicrophone } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errorMessage";
import { BackLink } from "../components/BackLink";
import { useProject } from "../features/library/queries";
import { NotFoundPage } from "../pages/NotFoundPage";
import { openRecordingSession } from "../rehearse/controller";
import { PendingTakeRow } from "./PendingTakes";
import { RecorderPanel } from "./RecorderPanel";
import { useTakes } from "./takes";

/**
 * Record on the project page (SPEC §9): the recorder on an empty, open-ended song (no tracks,
 * no tempo, no click). Saving creates a new song; when its upload finishes the page opens it.
 */
export function ProjectRecordPage() {
  const { t } = useTranslation();
  const { projectId = "" } = useParams();
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
  return <ProjectRecorder project={query.data.project} />;
}

function ProjectRecorder({ project }: { project: Project }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const allowed = project.access.capabilities.includes("record");
  const title = t("record.projectTitle");
  useEffect(() => {
    if (!allowed) return;
    return openRecordingSession({
      title,
      subtitle: "",
      projectId: project.id,
      projectName: project.name,
      imageHash: project.imageHash,
    });
  }, [allowed, title, project.id, project.name, project.imageHash]);

  // Each take gets a fresh recorder (it disarms when its take ends).
  const [round, setRound] = useState(0);
  const [ended, setEnded] = useState(false);
  const onTakeEnded = useCallback(() => {
    setEnded(true);
  }, []);

  // A take saved here becomes a new song: open it once uploaded.
  const [since] = useState(() => Date.now());
  const lastUploaded = useTakes((s) => s.lastUploaded);
  const pendingAll = useTakes((s) => s.pending);
  const reviewing = useTakes((s) => s.review.length > 0);
  const pending = useMemo(
    () =>
      pendingAll.filter(
        (p) => p.target.type === "newSong" && p.projectId === project.id && p.savedAt >= since,
      ),
    [pendingAll, project.id, since],
  );
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const p of pending) seen.current.add(p.takeId);
  }, [pending]);
  useEffect(() => {
    if (lastUploaded?.songId && seen.current.has(lastUploaded.takeId)) {
      void navigate(`/songs/${lastUploaded.songId}`);
    }
  }, [lastUploaded, navigate]);

  if (!allowed) return <NotFoundPage />;

  return (
    <Stack gap="lg" maw={560} data-testid="project-record-page">
      <BackLink to={`/projects/${project.id}`}>{project.name}</BackLink>
      <Title order={2}>{title}</Title>
      <Text size="sm" c="dimmed">
        {t("record.projectExplain")}
      </Text>
      {pending.map((p) => (
        <Stack key={p.takeId} gap={4}>
          {p.status === "uploading" ? (
            <Alert color="blue" icon={<Loader size="xs" />} data-testid="project-record-uploading">
              {t("record.uploadingSong", { title: p.title })}
            </Alert>
          ) : (
            <PendingTakeRow take={p} />
          )}
        </Stack>
      ))}
      {ended ? (
        !reviewing && (
          <Button
            size="lg"
            h={56}
            variant="default"
            leftSection={<IconMicrophone size={22} />}
            onClick={() => {
              setEnded(false);
              setRound((r) => r + 1);
            }}
            data-testid="project-record-again"
          >
            {t("record.again")}
          </Button>
        )
      ) : (
        <RecorderPanel
          key={round}
          scope={{ mode: "project", songId: null, projectId: project.id }}
          onTakeEnded={onTakeEnded}
        />
      )}
    </Stack>
  );
}
