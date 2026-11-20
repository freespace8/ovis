import { LOCAL_MACHINE, MACHINE_PROXY_PATH } from "./machines.ts";

export const SESSION_LINKS_PATH = "/api/session-links";
/** A private link's address is `<origin>/s/<token>`. */
export const SESSION_LINK_VISIT = /^\/s\/([A-Za-z0-9_-]{43})$/;

/** What the owner is shown of a private link: the token itself is never stored or listed. */
export interface SessionLink {
  /** a public handle for revoking; not the token */
  readonly id: string;
  /** `local` or a machine of kind `session` */
  readonly machine_id: string;
  readonly created_at: string;
}

/** The answer to creating a link: the only time its address, which holds the token, is told. */
export interface SessionLinkCreated extends SessionLink {
  readonly url: string;
}

/**
 * What a private link may reach: its one machine and the app that shows it, nothing else. The server
 * refuses anything else with 403 (server/dispatch.ts) and the page does not send it (src/lib/transport.ts).
 * Besides the app's own files and the routes of that machine (`MACHINE_PROXY_PATH`), a link visitor's
 * page reads, and nothing else:
 * - GET /api/health, which says who the visitor is (`auth.link`) and is open to anyone anyway;
 * - GET /api/machines and GET /api/machines/events, whose roster the server cuts down to that machine;
 * - /ws, for that machine alone.
 */
export function sessionLinkAllows(method: string, url: URL, machineId: string): boolean {
  const { pathname, searchParams } = url;
  if (pathname === "/ws") {
    const asked = searchParams.getAll("machine_id");
    return asked.length === 0 ? machineId === LOCAL_MACHINE : asked.length === 1 && (asked[0] === "" ? machineId === LOCAL_MACHINE : asked[0] === machineId);
  }
  if (!pathname.startsWith("/api/")) return true;
  if (method === "GET" && (pathname === "/api/health" || pathname === "/api/machines/events")) return true;
  // verify_source_boot asks another machine's server for its boot
  if (method === "GET" && pathname === "/api/machines") return !searchParams.has("verify_source_boot");
  const own = /^\/api\/machines\/([^/]+)\/(.+)$/.exec(pathname);
  if (own) return own[1] === machineId && MACHINE_PROXY_PATH.test(own[2]!);
  return machineId === LOCAL_MACHINE && !pathname.startsWith("/api/machines") && MACHINE_PROXY_PATH.test(pathname.slice("/api/".length));
}
