// Browsers drop tabs and newlines from URLs ("/\t/evil" → "//evil"), so control characters are
// refused anywhere; "/\" is treated like "//" (protocol-relative) by browsers.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Only same-app relative paths are accepted as the post-login target (no open redirects). */
export function safeNext(next: string | null): string {
  if (next === null || CONTROL.test(next)) return "/";
  return /^\/(?![/\\])/.test(next) ? next : "/";
}
