import { adminCreateInvite, type GlobalRole } from "@bandroom/shared";
import { Alert, Button, Group, Modal, NumberInput, Select, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { LinkResultModal } from "./LinkResultModal";
import { useInvalidateAdmin } from "./queries";
import { roleOptions } from "./roleOptions";

export function InviteCreateModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateAdmin();
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const form = useForm({
    initialValues: { globalRole: "member" as GlobalRole, note: "", expiresInDays: 7 },
  });
  const mutation = useMutation({
    mutationFn: (v: typeof form.values) =>
      api(adminCreateInvite, {
        body: {
          globalRole: v.globalRole,
          note: v.note.trim() || null,
          expiresInDays: v.expiresInDays,
        },
      }),
    onSuccess: (res) => {
      invalidate();
      form.reset();
      onClose();
      setLink(res.link);
    },
  });

  return (
    <>
      <Modal opened={opened} onClose={onClose} title={t("admin.invites.create")} centered>
        <form
          onSubmit={form.onSubmit((v) => {
            mutation.mutate(v);
          })}
        >
          <Stack>
            {mutation.isError && <Alert color="red">{apiError(mutation.error)}</Alert>}
            <Select
              label={t("admin.users.role")}
              data={roleOptions(t)}
              allowDeselect={false}
              data-testid="invite-role"
              {...form.getInputProps("globalRole")}
            />
            <TextInput
              label={t("admin.invites.note")}
              description={t("admin.invites.noteHint")}
              maxLength={200}
              {...form.getInputProps("note")}
            />
            <NumberInput
              label={t("admin.invites.expiresInDays")}
              min={1}
              max={30}
              clampBehavior="strict"
              allowDecimal={false}
              {...form.getInputProps("expiresInDays")}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={mutation.isPending} data-testid="invite-submit">
                {t("admin.invites.createSubmit")}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
      <LinkResultModal
        link={link}
        title={t("admin.invites.linkTitle")}
        explain={t("admin.invites.linkExplain")}
        onClose={() => {
          setLink(null);
        }}
      />
    </>
  );
}
