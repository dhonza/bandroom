import { logout, updateMe } from "@bandroom/shared";
import { useMutation } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { clearOfflineData, isNetworkError } from "../offline/controller";
import { disarmRecorder } from "../record/recorder";
import { setServiceWorkerUser } from "../offline/pwa";
import { api } from "../api/client";
import { useOptionalUser, useSetSessionUser } from "./session";

type MePatch = Parameters<typeof api<typeof updateMe>>[1]["body"];

/** PATCH /me and refresh the cached session user. */
export function useUpdateMe() {
  const setUser = useSetSessionUser();
  return useMutation({
    mutationFn: (body: MePatch) => api(updateMe, { body }),
    onSuccess: ({ user }) => {
      setUser(user);
    },
  });
}

/** Persists a preference for logged-in users; anonymous visitors keep it locally only. */
export function usePersistPreference(): (patch: MePatch) => void {
  const user = useOptionalUser();
  const update = useUpdateMe();
  return (patch) => {
    if (user) update.mutate(patch);
  };
}

/**
 * Logs out and clears this user's offline data on this device (SPEC §13). Needs the network: an
 * offline logout would leave the server session (and the offline data) behind.
 */
export function useLogout() {
  const setUser = useSetSessionUser();
  const navigate = useNavigate();
  const user = useOptionalUser();
  const { t } = useTranslation();
  const done = async () => {
    // A recording in progress ends first (its take is removed with the user's data).
    disarmRecorder();
    if (user) await clearOfflineData(user.id).catch(() => undefined);
    await setServiceWorkerUser(null);
    setUser(null);
    void navigate("/login", { replace: true });
  };
  return useMutation({
    mutationFn: () => api(logout),
    onSuccess: done,
    onError: (err) => {
      if (isNetworkError(err)) {
        notifications.show({ color: "yellow", message: t("offline.logoutNeedsNetwork") });
        return;
      }
      void done();
    },
  });
}
