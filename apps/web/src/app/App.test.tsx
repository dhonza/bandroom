import type { ClientConfig, CurrentUser } from "@bandroom/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, LANGUAGE_STORAGE_KEY } from "../i18n/i18n";
import { makeUser, mockApi } from "../test/mockApi";
import { setPhoneViewport } from "../test/setup";
import { Providers } from "./Providers";
import { routes } from "./routes";

const config: ClientConfig = {
  appName: "Test Band",
  version: "1.2.3",
  basePath: "",
  defaultLocale: "en",
  logoHash: null,
};

async function renderApp(path = "/") {
  const i18n = i18next.createInstance();
  await initI18n("en", i18n);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <Providers config={config} i18n={i18n}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, i18n };
}

function loggedInAs(user: CurrentUser | null) {
  return mockApi({
    "GET /auth/session": () => ({ body: { user } }),
    "GET /projects": () => ({ body: { projects: [] } }),
    "PATCH /me": (init) => ({
      body: {
        user: {
          ...user,
          ...(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as object),
        },
      },
    }),
  });
}

beforeEach(() => {
  setPhoneViewport(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("app shell (logged in)", () => {
  beforeEach(() => {
    loggedInAs(makeUser());
  });

  it("redirects / to the library and shows the instance name", async () => {
    const { router } = await renderApp("/");
    expect(await screen.findByRole("heading", { name: "Library", level: 2 })).toBeInTheDocument();
    expect(await screen.findByText("No projects yet.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Test Band", level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/library");
  });

  it("shows the desktop navbar (with Admin for admins) on wide screens", async () => {
    await renderApp("/library");
    const nav = await screen.findByTestId("desktop-nav");
    expect(within(nav).getByRole("link", { name: "Admin" })).toBeInTheDocument();
    expect(screen.queryByTestId("bottom-tab-bar")).not.toBeInTheDocument();
  });

  it("shows the bottom tab bar on phones", async () => {
    setPhoneViewport(true);
    await renderApp("/library");
    const tabs = await screen.findByTestId("bottom-tab-bar");
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Library", "Recent", "Offline", "Me"]);
  });

  it("navigates between sections", async () => {
    await renderApp("/library");
    const nav = await screen.findByTestId("desktop-nav");
    await userEvent.click(within(nav).getByRole("link", { name: "Offline" }));
    expect(await screen.findByRole("heading", { name: "Offline", level: 2 })).toBeInTheDocument();
  });

  it("switches language to Czech, remembers it, and saves it to the account", async () => {
    const fetchMock = loggedInAs(makeUser());
    await renderApp("/library");
    await userEvent.click(await screen.findByTestId("language-switcher"));
    await userEvent.click(await screen.findByTestId("language-cs"));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Knihovna", level: 2 })).toBeInTheDocument();
    });
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("cs");
    expect(document.documentElement.lang).toBe("cs");
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true);
    });
  });

  it("shows a not-found page for unknown routes", async () => {
    await renderApp("/nope");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
});

describe("access control", () => {
  it("redirects anonymous visitors to the login page, keeping the target", async () => {
    loggedInAs(null);
    const { router } = await renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toBe("?next=%2Fsettings");
  });

  it("hides the admin area from members", async () => {
    loggedInAs(makeUser({ globalRole: "member" }));
    await renderApp("/admin");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    const nav = screen.getByTestId("desktop-nav");
    expect(within(nav).queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });
});

describe("login page", () => {
  it("shows a translated error for wrong credentials", async () => {
    mockApi({
      "GET /auth/session": () => ({ body: { user: null } }),
      "POST /auth/login": () => ({
        status: 401,
        body: { code: "INVALID_CREDENTIALS", message: "x" },
      }),
    });
    await renderApp("/login");
    await userEvent.type(await screen.findByLabelText("Username or email"), "jana");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByTestId("login-error")).toHaveTextContent(
      "Wrong username or password.",
    );
  });

  it("logs in and continues to the requested page", async () => {
    const user = makeUser({ globalRole: "member" });
    mockApi({
      "GET /auth/session": () => ({ body: { user: null } }),
      "POST /auth/login": () => ({ body: { user } }),
    });
    const { router } = await renderApp("/login?next=%2Foffline");
    await userEvent.type(await screen.findByLabelText("Username or email"), "jana");
    await userEvent.type(screen.getByLabelText("Password"), "right-password");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { name: "Offline", level: 2 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/offline");
  });
});
