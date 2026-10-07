/** Where Mantine's default color scheme manager keeps the chosen scheme. */
export const COLOR_SCHEME_STORAGE_KEY = "mantine-color-scheme-value";

/**
 * Sets the color scheme before the first paint, as Mantine's `ColorSchemeScript` does (dark is the
 * default; "auto" follows the system). The server injects it into `index.html` and allows it in
 * the CSP by its hash, so the text must stay byte-for-byte stable between the two.
 */
export const COLOR_SCHEME_SCRIPT =
  `try{var s=localStorage.getItem("${COLOR_SCHEME_STORAGE_KEY}");` +
  `var c=s==="light"||s==="dark"||s==="auto"?s:"dark";` +
  `if(c==="auto")c=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";` +
  `document.documentElement.setAttribute("data-mantine-color-scheme",c)}catch(e){}`;
