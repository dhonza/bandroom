import {
  listTrackVersions,
  LinkPasswordSchema,
  type CreateLink,
  type LinkContent,
  type LinkVersionMode,
  type PublicLink,
  type UpdateLink,
} from "@bandroom/shared";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  PasswordInput,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { songKeys, useSongTracks } from "../features/library/queries";
import { defaultExpiry, endOfDay, toDateInput } from "./model";
import { useLinkMutations, type LinkOwner } from "./queries";

type Props =
  | { mode: "create"; owner: LinkOwner; onClose: () => void; onCreated: (l: PublicLink) => void }
  | { mode: "edit"; link: PublicLink; onClose: () => void };

/**
 * Create or edit a public link (SPEC §3.5): what it shares, password, expiry, downloads and
 * comments. Song links can share the whole song or chosen versions.
 */
export function LinkFormModal(props: Props) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const { create, update } = useLinkMutations();
  const link = props.mode === "edit" ? props.link : null;
  const owner = props.mode === "create" ? props.owner : null;
  const songId = owner?.kind === "song" ? owner.songId : null;

  const [label, setLabel] = useState(link?.label ?? "");
  const [scope, setScope] = useState<"song" | "versions">(
    link?.scopeType === "versions" ? "versions" : "song",
  );
  const [versionIds, setVersionIds] = useState<string[]>([]);
  const [content, setContent] = useState<LinkContent>(link?.content ?? "mix-only");
  const [versions, setVersions] = useState<LinkVersionMode>(link?.versions ?? "current-only");
  const [usePassword, setUsePassword] = useState(link?.hasPassword ?? false);
  const [password, setPassword] = useState("");
  const [changePassword, setChangePassword] = useState(false);
  const [expires, setExpires] = useState(link ? link.expiresAt !== null : true);
  const [expiryDate, setExpiryDate] = useState(
    link?.expiresAt ? toDateInput(link.expiresAt) : defaultExpiry(),
  );
  const [allowDownload, setAllowDownload] = useState(link?.allowDownload ?? false);
  const [allowComments, setAllowComments] = useState(link?.allowComments ?? false);
  const [showComments, setShowComments] = useState(link?.showComments ?? false);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(() => Date.now());

  const isVersions = (link?.scopeType ?? (songId ? scope : "project")) === "versions";
  // A new password is needed when turning the password on, or when changing an existing one.
  const needsPassword = usePassword && (!link?.hasPassword || changePassword);
  const passwordOk = !needsPassword || LinkPasswordSchema.safeParse(password).success;
  const expiresAt = expires ? endOfDay(expiryDate) : null;
  const expiryOk = !expires || (expiresAt !== null && expiresAt > today);
  const versionsOk = !isVersions || link !== null || versionIds.length > 0;
  const busy = create.isPending || update.isPending;

  const submit = async () => {
    setError(null);
    const common = {
      label: label.trim(),
      expiresAt,
      allowDownload,
      allowComments,
      showComments,
      ...(!isVersions && { content, versions }),
    };
    try {
      if (props.mode === "create") {
        const body: CreateLink = {
          content,
          versions,
          ...common,
          scopeType: owner?.kind === "project" ? "project" : scope,
          ...(isVersions && { versionIds }),
          ...(usePassword && { password }),
        };
        const res = await create.mutateAsync({ owner: props.owner, body });
        props.onCreated(res.link);
      } else {
        const body: UpdateLink = {
          ...common,
          ...(!usePassword && props.link.hasPassword && { password: null }),
          ...(needsPassword && { password }),
        };
        await update.mutateAsync({ id: props.link.id, body });
      }
      props.onClose();
    } catch (err) {
      setError(apiError(err));
    }
  };

  return (
    <Modal
      opened
      onClose={props.onClose}
      title={props.mode === "create" ? t("links.create") : t("links.edit")}
      centered
      size="lg"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <Stack gap="md" data-testid="link-form">
          {error && <Alert color="red">{error}</Alert>}
          <TextInput
            label={t("links.fields.label")}
            description={t("links.fields.labelHint")}
            placeholder={t("links.fields.labelPlaceholder")}
            value={label}
            maxLength={120}
            onChange={(e) => {
              setLabel(e.currentTarget.value);
            }}
            data-testid="link-label"
          />
          {songId && props.mode === "create" && (
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                {t("links.fields.scope")}
              </Text>
              <SegmentedControl
                value={scope}
                onChange={(v) => {
                  setScope(v === "versions" ? "versions" : "song");
                }}
                data={[
                  { value: "song", label: t("links.scope.song") },
                  { value: "versions", label: t("links.scope.versions") },
                ]}
                data-testid="link-scope"
              />
            </Stack>
          )}
          {songId && isVersions && props.mode === "create" && (
            <VersionPicker songId={songId} value={versionIds} onChange={setVersionIds} />
          )}
          {!isVersions && (
            <>
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  {t("links.fields.content")}
                </Text>
                <SegmentedControl
                  value={content}
                  onChange={(v) => {
                    setContent(v === "all-tracks" ? "all-tracks" : "mix-only");
                  }}
                  data={[
                    { value: "mix-only", label: t("links.content.mix-only") },
                    { value: "all-tracks", label: t("links.content.all-tracks") },
                  ]}
                  data-testid="link-content"
                />
                <Text size="xs" c="dimmed">
                  {t(`links.contentHint.${content}`)}
                </Text>
              </Stack>
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  {t("links.fields.versions")}
                </Text>
                <SegmentedControl
                  value={versions}
                  onChange={(v) => {
                    setVersions(v === "all" ? "all" : "current-only");
                  }}
                  data={[
                    { value: "current-only", label: t("links.versions.current-only") },
                    { value: "all", label: t("links.versions.all") },
                  ]}
                  data-testid="link-versions"
                />
              </Stack>
            </>
          )}

          <Stack gap="xs">
            <Switch
              checked={usePassword}
              onChange={(e) => {
                setUsePassword(e.currentTarget.checked);
              }}
              label={t("links.fields.password")}
              description={t("links.fields.passwordHint")}
              data-testid="link-password-switch"
            />
            {usePassword && link?.hasPassword && !changePassword && (
              <Group gap="xs">
                <Text size="sm" c="dimmed">
                  {t("links.passwordSet")}
                </Text>
                <Button
                  variant="subtle"
                  h={44}
                  onClick={() => {
                    setChangePassword(true);
                  }}
                  data-testid="link-change-password"
                >
                  {t("links.changePassword")}
                </Button>
              </Group>
            )}
            {needsPassword && (
              <PasswordInput
                label={t("links.fields.newPassword")}
                value={password}
                maxLength={200}
                autoComplete="new-password"
                error={password && !passwordOk ? t("links.passwordTooShort") : null}
                onChange={(e) => {
                  setPassword(e.currentTarget.value);
                }}
                data-testid="link-password"
              />
            )}
          </Stack>

          <Stack gap="xs">
            <Switch
              checked={expires}
              onChange={(e) => {
                setExpires(e.currentTarget.checked);
              }}
              label={t("links.fields.expires")}
              data-testid="link-expires-switch"
            />
            {expires && (
              <TextInput
                type="date"
                label={t("links.fields.expiresOn")}
                value={expiryDate}
                min={toDateInput(today)}
                error={!expiryOk ? t("links.expiryInPast") : null}
                onChange={(e) => {
                  setExpiryDate(e.currentTarget.value);
                }}
                data-testid="link-expiry"
              />
            )}
          </Stack>

          <Switch
            checked={allowDownload}
            onChange={(e) => {
              setAllowDownload(e.currentTarget.checked);
            }}
            label={t("links.fields.allowDownload")}
            description={t("links.fields.allowDownloadHint")}
            data-testid="link-allow-download"
          />
          {allowDownload && link && !link.downloadPolicyAllows && (
            <Alert color="yellow" variant="light">
              {t("links.policyBlocksDownload")}
            </Alert>
          )}
          <Switch
            checked={allowComments}
            onChange={(e) => {
              setAllowComments(e.currentTarget.checked);
            }}
            label={t("links.fields.allowComments")}
            description={t("links.fields.allowCommentsHint")}
            data-testid="link-allow-comments"
          />
          <Switch
            checked={showComments}
            onChange={(e) => {
              setShowComments(e.currentTarget.checked);
            }}
            label={t("links.fields.showComments")}
            description={t("links.fields.showCommentsHint")}
            data-testid="link-show-comments"
          />

          <Group justify="flex-end">
            <Button variant="default" h={44} onClick={props.onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              h={44}
              loading={busy}
              disabled={!passwordOk || !expiryOk || !versionsOk}
              data-testid="link-save"
            >
              {props.mode === "create" ? t("links.createSubmit") : t("common.save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** Checkboxes for the versions of every track of the song (`versions` links). */
function VersionPicker({
  songId,
  value,
  onChange,
}: {
  songId: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const tracks = useSongTracks(songId);
  const list = tracks.data?.tracks ?? [];
  const versions = useQueries({
    queries: list.map((tr) => ({
      queryKey: songKeys.versions(songId, tr.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api(listTrackVersions, { params: { id: tr.id } }, { signal }),
    })),
  });
  return (
    <Stack gap="xs" data-testid="link-version-picker">
      <Text size="sm" fw={500}>
        {t("links.fields.pickVersions")}
      </Text>
      {list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t("links.noVersions")}
        </Text>
      )}
      {list.map((tr, i) => (
        <Stack key={tr.id} gap={4}>
          <Text size="sm" c="dimmed">
            {tr.name}
          </Text>
          {(versions[i]?.data?.versions ?? []).map((v) => (
            <Checkbox
              key={v.id}
              checked={value.includes(v.id)}
              onChange={(e) => {
                onChange(
                  e.currentTarget.checked ? [...value, v.id] : value.filter((x) => x !== v.id),
                );
              }}
              label={`v${v.number}${v.label ? ` · ${v.label}` : ""}${v.isCurrent ? ` · ${t("links.currentVersion")}` : ""}`}
              styles={{ body: { alignItems: "center", minHeight: 44 } }}
              data-testid="link-version-option"
            />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
