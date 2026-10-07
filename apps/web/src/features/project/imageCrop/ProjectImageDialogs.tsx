import { Alert, Button, Center, Group, Loader, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useMediaQuery, useViewportSize } from "@mantine/hooks";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../../../api/useApiError";
import { PHONE_QUERY } from "../../../shell/mediaQueries";
import { defaultSquare, type Square } from "./crop";
import { cropToFile, loadImage } from "./exportCrop";
import { fetchImageUrl } from "./fetchImageUrl";
import { SquareCropper } from "./SquareCropper";

/** An image to crop: a picked file or the bytes the server fetched from a URL. */
export interface CropSource {
  /** Distinguishes two picks of the same file (the dialog starts afresh for each). */
  id: number;
  blob: Blob;
  name: string;
}

let nextSourceId = 1;
export function cropSource(blob: Blob, name: string): CropSource {
  return { id: nextSourceId++, blob, name };
}

/** `example.com/a.png` → `https://example.com/a.png`; other schemes are left to the server. */
export function withScheme(raw: string): string {
  const url = raw.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

/** The file name part of a URL, for the uploaded file's name. */
export function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "image";
  } catch {
    return "image";
  }
}

/** Step 1 of "From URL" (SPEC §25.4): the server fetches the image, then the crop dialog opens. */
export function ImageUrlModal({
  projectId,
  opened,
  onClose,
  onFetched,
}: {
  projectId: string;
  opened: boolean;
  onClose: () => void;
  onFetched: (source: CropSource) => void;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const [url, setUrl] = useState("");
  const fetchUrl = useMutation({
    mutationFn: async (raw: string) => {
      const full = withScheme(raw);
      return cropSource(await fetchImageUrl(projectId, full), nameFromUrl(full));
    },
    onSuccess: (source) => {
      setUrl("");
      onFetched(source);
    },
  });
  const close = () => {
    fetchUrl.reset();
    onClose();
  };
  return (
    <Modal opened={opened} onClose={close} title={t("projects.settings.fromUrlTitle")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) fetchUrl.mutate(url);
        }}
      >
        <Stack>
          <TextInput
            label={t("projects.settings.imageUrl")}
            description={t("projects.settings.imageUrlHint")}
            placeholder={t("projects.settings.imageUrlPlaceholder")}
            inputMode="url"
            autoComplete="off"
            value={url}
            onChange={(e) => {
              setUrl(e.currentTarget.value);
            }}
            data-autofocus
            data-testid="image-url-input"
          />
          {fetchUrl.isError && <Alert color="red">{apiError(fetchUrl.error)}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={fetchUrl.isPending}
              disabled={!url.trim()}
              data-testid="image-url-fetch"
            >
              {t("projects.settings.fetchImage")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * Square crop of a picked or fetched image (SPEC §25.4). Confirming hands over the cropped file
 * (at most 1024 × 1024) for the usual upload.
 */
export function CropImageModal({
  source,
  onClose,
  onConfirm,
}: {
  source: CropSource | null;
  onClose: () => void;
  onConfirm: (file: File) => void;
}) {
  const { t } = useTranslation();
  const isPhone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  return (
    <Modal
      opened={source !== null}
      onClose={onClose}
      title={t("projects.settings.crop.title")}
      size="lg"
      fullScreen={isPhone}
    >
      {source && (
        <CropBody key={source.id} source={source} onClose={onClose} onConfirm={onConfirm} />
      )}
    </Modal>
  );
}

function CropBody({
  source,
  onClose,
  onConfirm,
}: {
  source: CropSource;
  onClose: () => void;
  onConfirm: (file: File) => void;
}) {
  const { t } = useTranslation();
  const isPhone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const viewport = useViewportSize();
  const [image, setImage] = useState<{ el: HTMLImageElement; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [square, setSquare] = useState<Square | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const url = URL.createObjectURL(source.blob);
    loadImage(url).then(
      (el) => {
        if (!alive) return;
        setImage({ el, url });
        setSquare(defaultSquare({ width: el.naturalWidth, height: el.naturalHeight }));
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
      URL.revokeObjectURL(url);
    };
  }, [source]);

  const confirm = () => {
    if (!image || !square) return;
    setBusy(true);
    cropToFile(image.el, square, source.name).then(
      (file) => {
        setBusy(false);
        onConfirm(file);
      },
      () => {
        setBusy(false);
        setFailed(true);
      },
    );
  };
  const height = viewport.height || 640;
  const maxHeight = isPhone ? Math.max(200, height - 240) : Math.min(560, height * 0.65);
  return (
    <Stack data-testid="crop-dialog">
      {failed ? (
        <Alert color="red">{t("projects.settings.crop.unreadable")}</Alert>
      ) : image && square ? (
        <>
          <SquareCropper
            src={image.url}
            bounds={{ width: image.el.naturalWidth, height: image.el.naturalHeight }}
            value={square}
            onChange={setSquare}
            maxHeight={maxHeight}
          />
          <Text size="sm" c="dimmed">
            {t("projects.settings.crop.hint")}
          </Text>
        </>
      ) : (
        <Center h={200}>
          <Loader />
        </Center>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          onClick={confirm}
          loading={busy}
          disabled={!image || !square || failed}
          data-testid="crop-confirm"
        >
          {t("projects.settings.crop.confirm")}
        </Button>
      </Group>
    </Stack>
  );
}
