/**
 * Shown when the app cannot start (bad runtime config, a failed chunk load, storage errors). It is
 * plain English on purpose: translations may be what failed to load. Built with DOM calls (no
 * HTML strings) and inline styles that work in both color schemes.
 */
export function renderBootError(root: HTMLElement): void {
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.style.cssText =
    "max-width:32rem;margin:15vh auto;padding:0 16px;font-family:system-ui,sans-serif;line-height:1.5";
  const title = document.createElement("h1");
  title.style.fontSize = "1.25rem";
  title.textContent = "The app could not start.";
  const text = document.createElement("p");
  text.textContent =
    "Check your connection and reload the page. If this keeps happening, tell the person who runs this server.";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.style.cssText = "min-height:44px;padding:0 20px;font:inherit;cursor:pointer";
  reload.addEventListener("click", () => {
    window.location.reload();
  });
  box.append(title, text, reload);
  root.replaceChildren(box);
}
