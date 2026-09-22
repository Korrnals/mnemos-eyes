/**
 * `?return=` — the context back-link transport (UI-18 spec §2). Every
 * list→detail link carries `return=<encodeURIComponent(pathname + search)>`
 * of ITS source; the detail page turns it into the back control target
 * (Breadcrumbs BackControl). Browser back is untouched — this is a
 * predictable context LINK, not history replay (spec §2.1c).
 *
 * Pure URL functions only: no effects, no subscriptions, no storage — the
 * parameter is written once at link-render time (freeze-gate 1.11.4 safe by
 * construction, spec §2.2 rule 5) and the canonical detail URL keeps working
 * without it (rule 6).
 */

/** The single transport param name (spec §2). */
export const RETURN_PARAM = "return";

/**
 * Shell-internal route roots a `return` may target (spec §2.2 rule 2:
 * «принадлежит маршрутам приложения»). `/pair` deliberately stays out —
 * it lives outside the Shell. Anything else silently falls back.
 */
const RETURN_ROUTE_PREFIXES: readonly string[] = [
  "/memory",
  "/tasks",
  "/agents",
  "/docs",
  "/system",
];

/**
 * Encode a source location into the `return` param value: the WHOLE
 * `pathname + search` through one `encodeURIComponent` (spec §2.2 rule 1 —
 * never hand-concatenate; `project:gcw` must survive as one opaque value).
 */
export function encodeReturn(sourcePathname: string, sourceSearch = ""): string {
  return encodeURIComponent(`${sourcePathname}${sourceSearch}`);
}

/**
 * Build a detail href carrying the source context:
 * `withReturn("/tasks/TB-1", "/tasks?status=open")` →
 * `"/tasks/TB-1?return=%2Ftasks%3Fstatus%3Dopen"`.
 * Appends with `&` when the target already has a query (e.g. `?tab=`).
 */
export function withReturn(
  to: string,
  sourcePathname: string,
  sourceSearch = "",
): string {
  const sep = to.includes("?") ? "&" : "?";
  return `${to}${sep}${RETURN_PARAM}=${encodeReturn(sourcePathname, sourceSearch)}`;
}

/**
 * Read + validate the `return` target on a detail page (spec §2.2 rule 2).
 * Returns the decoded in-app path (+search) or null — null means «silently
 * fall back», never an error.
 *
 * Decoding note: `URLSearchParams.get` already percent-decodes once, which is
 * exactly the inverse of `encodeReturn`'s single `encodeURIComponent` — a
 * second decode here would corrupt values containing literal `%` sequences.
 *
 * Rejections: absent param; not starting with a single `/` (kills schemes —
 * `https://…` cannot start with `/`); protocol-relative `//…`; backslash
 * games; paths outside the app's Shell routes; the self-return
 * (current pathname+search — spec §2.3 «циклический return на себя»).
 */
export function resolveReturnTarget(params: {
  searchParams: URLSearchParams;
  currentPathname: string;
  currentSearch: string;
}): string | null {
  const raw = params.searchParams.get(RETURN_PARAM);
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return null;
  }
  const queryStart = raw.indexOf("?");
  const path = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const knownRoute =
    path === "/" ||
    RETURN_ROUTE_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  if (!knownRoute) return null;
  if (raw === `${params.currentPathname}${params.currentSearch}`) return null;
  return raw;
}
