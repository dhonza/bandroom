import { hasGlobalCapability, type GlobalCapability } from "@bandroom/shared";
import { Button, Center, Loader, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation, useSearchParams } from "react-router";
import { safeNext } from "./safeNext";
import { NotFoundPage } from "../pages/NotFoundPage";
import { CurrentUserContext, useCurrentUser, useSession } from "./session";
import { PreferencesSync } from "./PreferencesSync";
import { OfflineSession } from "../offline/OfflineSession";

export function FullPageLoader() {
  return (
    <Center mih="100dvh">
      <Loader />
    </Center>
  );
}

/** Layout route: renders children only for a logged-in user, otherwise redirects to login. */
export function RequireAuth() {
  const { t } = useTranslation();
  const location = useLocation();
  const session = useSession();

  if (session.isPending) return <FullPageLoader />;
  if (session.isError) {
    return (
      <Center mih="100dvh">
        <Stack align="center">
          <Text>{t("errors.NETWORK")}</Text>
          <Button onClick={() => void session.refetch()}>{t("common.retry")}</Button>
        </Stack>
      </Center>
    );
  }
  const user = session.data.user;
  if (user === null) {
    const next = `${location.pathname}${location.search}`;
    const search = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
    return <Navigate to={`/login${search}`} replace />;
  }
  return (
    <CurrentUserContext.Provider value={user}>
      <PreferencesSync user={user} />
      <OfflineSession userId={user.id} />
      <Outlet />
    </CurrentUserContext.Provider>
  );
}

/** Layout route below RequireAuth: hides routes the user lacks a global capability for. */
export function RequireGlobal({ capability }: { capability: GlobalCapability }) {
  const user = useCurrentUser();
  // The session user is enabled by construction (disabled users have no session).
  return hasGlobalCapability({ ...user, disabledAt: null }, capability) ? (
    <Outlet />
  ) : (
    <NotFoundPage />
  );
}

/**
 * For the login page: logged-in users go to `?next=` (or the app root). This also fires right after
 * a successful login, so it must pick the same target as the login form's own navigation.
 */
export function RedirectIfAuthenticated({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const [params] = useSearchParams();
  if (session.isPending) return <FullPageLoader />;
  if (session.data?.user) return <Navigate to={safeNext(params.get("next"))} replace />;
  return children;
}
