import { hasGlobalCapability } from "@bandroom/shared";
import { NativeSelect, Stack, TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../auth/session";
import { useProjects } from "../features/library/queries";
import { NEW_PROJECT, transferTargets } from "./targets";

/**
 * Picks where copied or moved items go (SPEC §26.6): a project where the user may add songs, or
 * "New project…" with a name (for users who may create projects).
 */
export function TargetPicker({
  value,
  onChange,
  newName,
  onNewName,
  exclude,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  newName: string;
  onNewName: (name: string) => void;
  exclude?: string;
}) {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const projects = useProjects(false);
  const canCreate = hasGlobalCapability({ ...user, disabledAt: null }, "project.create");
  const options = [
    ...transferTargets(projects.data?.projects ?? [], exclude).map((p) => ({
      value: p.id,
      label: p.name,
    })),
    ...(canCreate ? [{ value: NEW_PROJECT, label: t("transfer.newProjectOption") }] : []),
  ];
  return (
    <Stack gap="xs">
      {/* A native select: the phone's own picker, and no dropdown inside a full-screen dialog. */}
      <NativeSelect
        label={t("transfer.target")}
        data={[{ value: "", label: t("transfer.pickProject"), disabled: true }, ...options]}
        value={value ?? ""}
        onChange={(e) => {
          onChange(e.currentTarget.value || null);
        }}
        description={options.length === 0 ? t("transfer.noTargets") : undefined}
        styles={{ input: { minHeight: 44 } }}
        data-testid="transfer-target"
      />
      {value === NEW_PROJECT && (
        <TextInput
          label={t("transfer.newProjectName")}
          value={newName}
          onChange={(e) => {
            onNewName(e.currentTarget.value);
          }}
          maxLength={120}
          data-autofocus
          data-testid="transfer-new-name"
        />
      )}
    </Stack>
  );
}
