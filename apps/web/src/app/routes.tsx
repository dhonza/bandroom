import { IconClockHour4 } from "@tabler/icons-react";
import { Navigate, type RouteObject } from "react-router";
import { RedirectIfAuthenticated, RequireAuth, RequireGlobal } from "../auth/RequireAuth";
import { AdminPage } from "../features/admin/AdminPage";
import { InvitePage } from "../features/auth/InvitePage";
import { LoginPage } from "../features/auth/LoginPage";
import { ResetPasswordPage } from "../features/auth/ResetPasswordPage";
import { LibraryPage } from "../features/library/LibraryPage";
import { OfflinePage } from "../features/offline/OfflinePage";
import { ProjectPage } from "../features/project/ProjectPage";
import { SongPage } from "../features/song/SongPage";
import { DocumentPage } from "../documents/DocumentPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { MePage } from "../pages/MePage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { PlaceholderPage } from "../pages/PlaceholderPage";
import { AppLayout } from "../shell/AppLayout";
import { NotificationsPage } from "../notifications/NotificationsPage";
import { LinkApp } from "../links/view/LinkApp";

export const routes: RouteObject[] = [
  {
    path: "login",
    element: (
      <RedirectIfAuthenticated>
        <LoginPage />
      </RedirectIfAuthenticated>
    ),
  },
  { path: "invite/:token", element: <InvitePage /> },
  { path: "reset/:token", element: <ResetPasswordPage /> },
  // Public links (SPEC §3.5, §11.2): no login, no app navigation.
  { path: "l/:token/*", element: <LinkApp /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Navigate to="/library" replace /> },
          { path: "library", element: <LibraryPage /> },
          { path: "projects/:projectId", element: <ProjectPage /> },
          { path: "songs/:songId", element: <SongPage /> },
          { path: "documents/:documentId", element: <DocumentPage /> },
          { path: "recent", element: <PlaceholderPage pageKey="recent" icon={IconClockHour4} /> },
          { path: "offline", element: <OfflinePage /> },
          { path: "notifications", element: <NotificationsPage /> },
          {
            element: <RequireGlobal capability="admin.access" />,
            children: [{ path: "admin", element: <AdminPage /> }],
          },
          { path: "settings", element: <SettingsPage /> },
          { path: "me", element: <MePage /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
