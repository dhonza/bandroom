import {
  DOC_FONT_MAX,
  DOC_FONT_MIN,
  DOCUMENT_TEXT_VIEW_MAX_BYTES,
  type Document,
  type DocumentVersion,
} from "@bandroom/shared";
import { Alert, Box, Button, Group, Loader, Slider, Stack, Text } from "@mantine/core";
import { IconDownload, IconTextSize } from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateMe } from "../auth/useAccount";
import { useCurrentUser } from "../auth/session";
import { formatBytes } from "../lib/media";
import { useSavedSetting } from "../lib/useSavedSetting";
import { loadKeyMap, resolvePageKey, type PageTurn } from "../markers/keymap";
import { ImageView } from "./ImageView";
import { MarkdownBody, PlainTextBody } from "./MarkdownBody";
import { contentUrl, documentDownloadUrl, useDocumentText } from "./queries";
import { registerPager } from "./store";
import { pageScrollTarget } from "./zoom";
import { errorMessage } from "../api/errorMessage";

// pdf.js is large: its own chunk, loaded only when a PDF is opened (SPEC §18.1).
const PdfView = lazy(() => import("./PdfView").then((m) => ({ default: m.PdfView })));

/** The viewer font size (SPEC §10: slider, persisted per user); saved on each committed change. */
function useDocFontSize(): [number, (v: number) => void, (v: number) => void] {
  const user = useCurrentUser();
  const update = useUpdateMe();
  return useSavedSetting(user.docFontSize, (v) => update.mutateAsync({ docFontSize: v }));
}

export function DownloadButton({ version }: { version: DocumentVersion }) {
  const { t } = useTranslation();
  return (
    <Button
      component="a"
      href={documentDownloadUrl(version.id)}
      download
      variant="default"
      h={44}
      leftSection={<IconDownload size={16} />}
      data-testid="doc-download"
    >
      {t("documents.download")}
    </Button>
  );
}

/**
 * Shows one document version by kind (SPEC §10): Markdown, plain text, PDF (pdf.js), images,
 * or file info with a download. When focused, page-turner keys turn pages (SPEC §11.4); a pedal
 * mapped to "next/previous page" works from anywhere on the song page through the store's pager.
 */
export function DocumentViewer({
  document: doc,
  version,
}: {
  document: Document;
  version: DocumentVersion;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const pagerRef = useRef<((turn: PageTurn) => void) | null>(null);
  const register = useCallback((p: (turn: PageTurn) => void) => {
    pagerRef.current = p;
    const unregister = registerPager(p);
    return () => {
      unregister();
      if (pagerRef.current === p) pagerRef.current = null;
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || e.repeat) return;
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, select, button, [role=slider]")) return;
    const turn = resolvePageKey(e, loadKeyMap());
    if (!turn || !pagerRef.current) return;
    e.preventDefault();
    pagerRef.current(turn);
  };

  const ready = version.status === "ready";
  const textual = version.kind === "markdown" || version.kind === "text";
  const tooBig = textual && version.sizeBytes > DOCUMENT_TEXT_VIEW_MAX_BYTES;

  let body: React.ReactNode;
  if (version.status === "failed") {
    body = (
      <Alert color="red" data-testid="doc-failed">
        {t("documents.failed")}
        {version.error ? ` (${version.error})` : ""}
      </Alert>
    );
  } else if (!ready) {
    body = (
      <Group gap="sm" p="md" data-testid="doc-processing">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          {t("documents.processing")}
        </Text>
      </Group>
    );
  } else if (textual && !tooBig) {
    body = (
      <TextDocument
        versionId={version.id}
        markdown={version.kind === "markdown"}
        onRegisterPager={register}
      />
    );
  } else if (version.kind === "pdf") {
    body = (
      <Suspense fallback={<Loader size="sm" />}>
        <PdfView url={contentUrl(version.id)} onRegisterPager={register} />
      </Suspense>
    );
  } else if (version.kind === "image" && version.previewHash) {
    body = <ImageView hash={version.previewHash} alt={doc.title} />;
  } else {
    body = (
      <Stack gap="xs" p="md" data-testid="doc-other">
        <Text fw={500} style={{ overflowWrap: "anywhere" }}>
          {version.originalFilename}
        </Text>
        <Text size="sm" c="dimmed">
          {t(`documents.kinds.${version.kind}`)} · {formatBytes(version.sizeBytes, locale)}
        </Text>
        <Text size="sm" c="dimmed">
          {tooBig ? t("documents.tooBig") : t("documents.noPreview")}
        </Text>
        {doc.canDownload && (
          <Group>
            <DownloadButton version={version} />
          </Group>
        )}
      </Stack>
    );
  }

  return (
    <Box
      data-doc-viewer
      data-testid="doc-viewer"
      data-kind={version.kind}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={t("documents.viewerLabel", { title: doc.title })}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        flex: 1,
        outlineOffset: 2,
      }}
    >
      {body}
    </Box>
  );
}

function TextDocument({
  versionId,
  markdown,
  onRegisterPager,
}: {
  versionId: string;
  markdown: boolean;
  onRegisterPager: (p: (turn: PageTurn) => void) => () => void;
}) {
  const { t } = useTranslation();
  const text = useDocumentText(versionId);
  const [size, setSize, commit] = useDocFontSize();
  const scroller = useRef<HTMLDivElement>(null);
  const turn = useCallback((dir: PageTurn) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({
      top: pageScrollTarget(el.scrollTop, el.clientHeight, el.scrollHeight, dir),
      behavior: "smooth",
    });
  }, []);
  useEffect(() => onRegisterPager(turn), [onRegisterPager, turn]);

  return (
    <Box style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <Group gap="sm" wrap="nowrap" py={4} px={4}>
        <IconTextSize size={18} aria-hidden />
        <Slider
          min={DOC_FONT_MIN}
          max={DOC_FONT_MAX}
          step={1}
          value={size}
          onChange={setSize}
          onChangeEnd={commit}
          label={(v) => `${String(v)} px`}
          aria-label={t("documents.fontSize")}
          data-testid="doc-font-size"
          style={{ flex: 1, maxWidth: 260 }}
          thumbSize={22}
        />
      </Group>
      <Box
        ref={scroller}
        data-testid="doc-scroller"
        px="xs"
        style={{ flex: 1, minHeight: 0, overflow: "auto" }}
      >
        {text.isPending ? (
          <Loader size="sm" />
        ) : text.isError ? (
          <Alert color="red">{errorMessage(t, text.error)}</Alert>
        ) : markdown ? (
          <MarkdownBody text={text.data} fontSize={size} />
        ) : (
          <PlainTextBody text={text.data} fontSize={size} />
        )}
      </Box>
    </Box>
  );
}
