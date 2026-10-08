/** Layout breakpoints shared by the shell and the song page panels (SPEC §11.2, §11.3). */

/** Phones use the bottom tab bar; wider screens the left navbar (SPEC §11.2). */
export const PHONE_QUERY = "(max-width: 47.99em)";

/** The Mixer button sits in the transport from this width; below it, above the timeline. */
export const WIDE_QUERY = "(min-width: 56.25em)";

/** Comments and documents: right side panel from this width, bottom sheet below (SPEC §8, §11.3). */
export const DESKTOP_QUERY = "(min-width: 64em)";

/** The document editor shows source and preview side by side from this width. */
export const EDITOR_SPLIT_QUERY = "(min-width: 62em)";

/** A finger is the main pointer (touch targets ≥ 44 px, SPEC §11.1.3). */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

/**
 * A short viewport (a phone in landscape): wider than PHONE_QUERY, but too low for popovers and
 * centered modals, so larger panels go full screen there too.
 */
export const SHORT_QUERY = "(max-height: 40em)";
