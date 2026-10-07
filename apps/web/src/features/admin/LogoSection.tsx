import {
  adminGetSettings,
  adminRemoveLogo,
  LOGO_MAX_ASPECT,
  logoAspectAllowed,
  type InstanceLogo,
} from "@bandroom/shared";
import { Alert, Box, Button, FileButton, Group, Image, Loader, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { metaKey } from "../../branding/BrandLogo";
import { Section } from "../../components/Section";
import { brandingLogoUrl } from "../../lib/media";
import { startUpload } from "../../upload/startUpload";
import { UploadRow, useUploadErrorText, useUploadErrorToast } from "../../upload/UploadRow";
import { useUploads } from "../../upload/uploadStore";

export const settingsKey = ["admin", "settings"] as const;

/** Width and height of a picked image, or null when the browser cannot read it. */
async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** Branding logo upload and removal (SPEC §25.1). */
export function LogoSection({ logo }: { logo: InstanceLogo }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const apiError = useApiError();
  const errorText = useUploadErrorText();
  const uploadErrorToast = useUploadErrorToast();
  const allUploads = useUploads((s) => s.items);
  const uploads = useMemo(
    () => allUploads.filter((i) => i.target.type === "instanceLogo"),
    [allUploads],
  );
  const [busy, setBusy] = useState(false);
  const [tooWide, setTooWide] = useState(false);
  const resetRef = useRef<() => void>(null);
  const pending = logo.pending;
  const processing = pending !== null && pending.status !== "failed";

  // The worker processes the logo in a few seconds; poll until it is ready or rejected.
  useQuery({
    queryKey: [...settingsKey, "logoPoll"],
    queryFn: async ({ signal }) => {
      const res = await api(adminGetSettings, undefined, { signal });
      qc.setQueryData(settingsKey, res);
      return res.logo;
    },
    enabled: processing,
    refetchInterval: 2000,
    gcTime: 0,
  });
  const hash = logo.hash;
  useEffect(() => {
    // A new logo in use: refresh the header everywhere in this tab.
    void qc.invalidateQueries({ queryKey: metaKey });
  }, [hash, qc]);

  const upload = (file: File | null) => {
    resetRef.current?.();
    if (!file) return;
    setTooWide(false);
    setBusy(true);
    void imageSize(file)
      .then((size) => {
        // The server checks this too; checking here saves the upload.
        if (size && !logoAspectAllowed(size.width, size.height)) {
          setTooWide(true);
          return;
        }
        return startUpload(file, { type: "instanceLogo" }, { songId: null, projectId: null }).then(
          () => qc.invalidateQueries({ queryKey: settingsKey }),
        );
      })
      .catch((err: unknown) => {
        uploadErrorToast(err);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const remove = useMutation({
    mutationFn: () => api(adminRemoveLogo, undefined),
    onSuccess: (res) => {
      qc.setQueryData(settingsKey, (old: { logo: InstanceLogo } | undefined) =>
        old ? { ...old, logo: res.logo } : old,
      );
      notifications.show({ color: "teal", message: t("admin.settings.logoRemoved") });
    },
    onError: (err) => notifications.show({ color: "red", message: apiError(err) }),
  });

  return (
    <Section
      title={t("admin.settings.logo")}
      description={t("admin.settings.logoHint", { ratio: LOGO_MAX_ASPECT })}
      testId="logo-section"
    >
      {hash ? (
        <Box
          p="sm"
          style={{
            alignSelf: "flex-start",
            borderRadius: "var(--mantine-radius-sm)",
            background: "var(--mantine-color-body)",
            border: "1px solid var(--mantine-color-default-border)",
          }}
        >
          <Image
            src={brandingLogoUrl(hash)}
            alt={t("admin.settings.logoCurrent")}
            h={32}
            w="auto"
            fit="contain"
            data-testid="logo-preview"
          />
        </Box>
      ) : (
        <Text size="sm" c="dimmed">
          {t("admin.settings.logoNone")}
        </Text>
      )}
      {processing && (
        <Group gap="xs" data-testid="logo-processing">
          <Loader size="xs" />
          <Text size="sm">{t("admin.settings.logoProcessing")}</Text>
        </Group>
      )}
      {(tooWide || pending?.status === "failed") && (
        <Alert color="red" data-testid="logo-error">
          {tooWide
            ? t("errors.LOGO_TOO_WIDE")
            : errorText(pending?.error ?? "UNSUPPORTED_FILE", null)}
        </Alert>
      )}
      {uploads.map((u) => (
        <UploadRow key={u.id} item={u} errorText={errorText} />
      ))}
      <Group gap="sm">
        <FileButton
          onChange={upload}
          resetRef={resetRef}
          accept="image/png,image/webp,image/jpeg,image/gif"
        >
          {(props) => (
            <Button {...props} variant="default" loading={busy} data-testid="upload-logo">
              {hash ? t("admin.settings.logoChange") : t("admin.settings.logoUpload")}
            </Button>
          )}
        </FileButton>
        {(hash || pending) && (
          <Button
            variant="subtle"
            color="red"
            loading={remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
            data-testid="remove-logo"
          >
            {t("admin.settings.logoRemove")}
          </Button>
        )}
      </Group>
    </Section>
  );
}
