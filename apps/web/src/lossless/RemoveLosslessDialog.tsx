import {
  batchRemoveLossless,
  batchRemoveLosslessPreview,
  type BatchItems,
  type RemoveLosslessPreview,
} from "@bandroom/shared";
import { Alert, Button, Group, List, Loader, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCopy } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { formatBytes } from "../lib/media";
import { PHONE_QUERY } from "../shell/mediaQueries";
import { useInvalidateBatch } from "../trash/queries";

/**
 * "Remove full quality" (SPEC §26.4): shows what the server's preview says would happen (files,
 * space, skipped versions, lossy sources, shared copies) and needs a typed confirmation, since it
 * cannot be undone. `items` null keeps the dialog closed.
 */
export function RemoveLosslessDialog({
  items,
  onClose,
  onDone,
}: {
  items: BatchItems | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const isPhone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  return (
    <Modal
      opened={items !== null}
      onClose={onClose}
      title={t("lossless.title")}
      fullScreen={isPhone}
      centered
    >
      {items && <DialogBody items={items} onClose={onClose} onDone={onDone} />}
    </Modal>
  );
}

function DialogBody({
  items,
  onClose,
  onDone,
}: {
  items: BatchItems;
  onClose: () => void;
  onDone: (() => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateBatch();
  const [typed, setTyped] = useState("");
  const size = (n: number) => formatBytes(n, i18n.language);
  const preview = useQuery({
    queryKey: ["lossless", "preview", items],
    queryFn: ({ signal }) => api(batchRemoveLosslessPreview, { body: items }, { signal }),
    gcTime: 0,
    staleTime: 0,
  });
  const apply = useMutation({
    mutationFn: () => api(batchRemoveLossless, { body: items }),
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: "teal",
        message: t("lossless.done", { count: r.count, size: size(r.usageBytes) }),
      });
      onDone?.();
      onClose();
    },
  });
  const word = t("lossless.confirmWord");

  if (preview.isPending) {
    return (
      <Group justify="center" p="md">
        <Loader size="sm" />
      </Group>
    );
  }
  if (preview.isError) {
    return (
      <Stack>
        <Alert color="red" data-testid="lossless-error">
          {apiError(preview.error)}
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" h={44} onClick={onClose}>
            {t("common.close")}
          </Button>
        </Group>
      </Stack>
    );
  }
  const p = preview.data;
  const nothing = p.versions === 0;
  return (
    <Stack data-testid="lossless-dialog">
      <Text size="sm">{t("lossless.explain")}</Text>
      {nothing ? (
        <Alert color="gray" data-testid="lossless-nothing">
          {t("lossless.nothing")}
        </Alert>
      ) : (
        <Summary preview={p} size={size} />
      )}
      <Skipped preview={p} />
      {p.lossySources.count > 0 && (
        <Alert
          color="orange"
          icon={<IconAlertTriangle size={18} />}
          title={t("lossless.lossyTitle", { count: p.lossySources.count })}
          data-testid="lossless-lossy-warning"
        >
          <Text size="sm">{t("lossless.lossyExplain")}</Text>
          <List size="sm" mt={4}>
            {p.lossySources.items.map((v) => (
              <List.Item key={v.id}>
                {t("lossless.versionName", {
                  track: v.trackName,
                  number: v.number,
                  song: v.songTitle,
                })}
              </List.Item>
            ))}
          </List>
          {p.lossySources.count > p.lossySources.items.length && (
            <Text size="sm" c="dimmed">
              {t("lossless.andMore", { count: p.lossySources.count - p.lossySources.items.length })}
            </Text>
          )}
        </Alert>
      )}
      {p.sharedCopies > 0 && (
        <Alert color="orange" icon={<IconCopy size={18} />} data-testid="lossless-copies-warning">
          {t("lossless.copies", { count: p.sharedCopies })}
        </Alert>
      )}
      {apply.isError && <Alert color="red">{apiError(apply.error)}</Alert>}
      {!nothing && (
        <TextInput
          label={t("common.typeToConfirm", { name: word })}
          value={typed}
          data-testid="lossless-confirm-input"
          onChange={(e) => {
            setTyped(e.currentTarget.value);
          }}
        />
      )}
      <Group justify="flex-end">
        <Button variant="default" h={44} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        {!nothing && (
          <Button
            color="red"
            h={44}
            disabled={typed.trim().toLowerCase() !== word.toLowerCase()}
            loading={apply.isPending}
            onClick={() => {
              apply.mutate();
            }}
            data-testid="lossless-confirm"
          >
            {t("lossless.action")}
          </Button>
        )}
      </Group>
    </Stack>
  );
}

function Summary({
  preview: p,
  size,
}: {
  preview: RemoveLosslessPreview;
  size: (n: number) => string;
}) {
  const { t } = useTranslation();
  const files = [
    p.files.flac > 0 && t("lossless.files.flac", { count: p.files.flac }),
    p.files.original > 0 && t("lossless.files.original", { count: p.files.original }),
    p.files.wavmeta > 0 && t("lossless.files.wavmeta", { count: p.files.wavmeta }),
  ].filter((x): x is string => typeof x === "string");
  return (
    <Stack gap={4} data-testid="lossless-summary">
      <Text fw={600}>{t("lossless.versions", { count: p.versions })}</Text>
      <Text size="sm">{files.join(" · ")}</Text>
      <Text size="sm" data-testid="lossless-space">
        {t("lossless.space", { usage: size(p.usageBytes) })}
      </Text>
      {p.bytesFreed < p.usageBytes && (
        <Text size="sm" c="dimmed">
          {p.bytesFreed === 0
            ? t("lossless.diskNone")
            : t("lossless.diskShared", { disk: size(p.bytesFreed) })}
        </Text>
      )}
    </Stack>
  );
}

function Skipped({ preview: p }: { preview: RemoveLosslessPreview }) {
  const { t } = useTranslation();
  const parts = [
    p.skipped.alreadyLossy > 0 &&
      t("lossless.skipped.alreadyLossy", { count: p.skipped.alreadyLossy }),
    p.skipped.notReady > 0 && t("lossless.skipped.notReady", { count: p.skipped.notReady }),
  ].filter((x): x is string => typeof x === "string");
  if (parts.length === 0) return null;
  return (
    <Text size="sm" c="dimmed" data-testid="lossless-skipped">
      {parts.join(" ")}
    </Text>
  );
}
