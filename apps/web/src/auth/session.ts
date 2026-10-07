import { getSession, type CurrentUser } from "@bandroom/shared";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { api } from "../api/client";

export const SESSION_QUERY_KEY = ["session"] as const;

export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => api(getSession, undefined, { signal }),
    staleTime: 5 * 60_000,
  });
}

/** After login/invite/reset/logout: put the new session user into the cache directly. */
export function setSessionUser(queryClient: QueryClient, user: CurrentUser | null): void {
  if (user === null) {
    // Drop everything user-specific, then mark the session as anonymous.
    queryClient.clear();
  }
  queryClient.setQueryData(SESSION_QUERY_KEY, { user });
}

export function useSetSessionUser(): (user: CurrentUser | null) => void {
  const queryClient = useQueryClient();
  return (user) => {
    setSessionUser(queryClient, user);
  };
}

export const CurrentUserContext = createContext<CurrentUser | null>(null);

/** The logged-in user; only valid below `RequireAuth`. */
export function useCurrentUser(): CurrentUser {
  const user = useContext(CurrentUserContext);
  if (user === null) throw new Error("useCurrentUser used outside RequireAuth");
  return user;
}

/** The logged-in user, or null (usable anywhere). */
export function useOptionalUser(): CurrentUser | null {
  return useContext(CurrentUserContext);
}
