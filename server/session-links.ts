import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { LOCAL_MACHINE, type MachineEvent } from "../shared/machines.ts";
import { SESSION_LINK_VISIT, type SessionLink, type SessionLinkCreated } from "../shared/session-links.ts";
import type { SessionLinkHolder } from "./access.ts";
import { isSecureRequest, linkCookie } from "./auth.ts";
import { badRequest, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import type { MachineManager } from "./machines.ts";
import { readStateDocument, writeStateDocument } from "./state-document.ts";
import { requestOrigin } from "./static.ts";

interface StoredLink { readonly id: string; readonly hash: string; readonly machine_id: string; readonly created_at: string }

const sha256 = (token: string): Buffer => createHash("sha256").update(token).digest();

/** 32 random bytes in URL-safe text: nothing in it names the session or can be derived from one. */
export function newLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The private links of this server (`<state folder>/session-links.json`, 0600). Only the SHA-256 of each
 * token is kept, so the file cannot open a link; the token is told once, when it is made.
 */
export class SessionLinks {
  private records: StoredLink[] = [];
  private readonly path: string;
  private damaged = false;
  private readonly watchers = new Map<string, Set<() => void>>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "session-links.json");
    const read = readStateDocument(this.path);
    if (read.kind === "missing") return;
    const rows = read.kind === "json" && Array.isArray(read.value) ? read.value as unknown[] : null;
    const valid = (row: unknown): row is StoredLink => isJsonObject(row) && ["id", "hash", "machine_id", "created_at"].every((key) => typeof row[key] === "string")
      && /^[0-9a-f]{64}$/.test(row["hash"] as string);
    this.records = (rows ?? []).filter(valid);
    this.damaged = rows === null || this.records.length !== rows.length;
    if (this.damaged) console.error(`${this.path} is not a list of private links; the next change keeps it as ${this.path}.bad`);
  }

  list(): SessionLink[] {
    return this.records.map(({ id, machine_id, created_at }) => ({ id, machine_id, created_at }));
  }

  create(machineId: string): { link: SessionLink; token: string } {
    const token = newLinkToken();
    const record: StoredLink = { id: randomBytes(16).toString("hex"), hash: sha256(token).toString("hex"), machine_id: machineId, created_at: new Date().toISOString() };
    this.save([...this.records, record]);
    return { link: { id: record.id, machine_id: record.machine_id, created_at: record.created_at }, token };
  }

  /** The link a presented token opens, found by comparing hashes in constant time. */
  match(token: string): SessionLinkHolder | null {
    const presented = sha256(token);
    let found: SessionLinkHolder | null = null;
    for (const record of this.records) {
      if (timingSafeEqual(presented, Buffer.from(record.hash, "hex"))) found = { id: record.id, machine_id: record.machine_id };
    }
    return found;
  }

  /** Revokes a link: its cookie stops working and every connection opened with it ends. */
  remove(id: string): boolean {
    if (!this.records.some((record) => record.id === id)) return false;
    this.save(this.records.filter((record) => record.id !== id));
    for (const close of [...this.watchers.get(id) ?? []]) close();
    this.watchers.delete(id);
    return true;
  }

  /** Ends `close` when the link is revoked, at once for one that is not there. */
  onRevoke(id: string, close: () => void): () => void {
    if (!this.records.some((record) => record.id === id)) { close(); return () => {}; }
    const set = this.watchers.get(id) ?? new Set<() => void>();
    set.add(close);
    this.watchers.set(id, set);
    return () => { set.delete(close); };
  }

  private save(next: StoredLink[]): void {
    writeStateDocument(this.path, `${JSON.stringify(next, null, 2)}\n`, this.damaged);
    this.damaged = false;
    this.records = next;
  }
}

/** The machine manager as a private link sees it: its one machine in the roster, and only that machine's events. */
export function onlyMachine(manager: MachineManager, id: string): MachineManager {
  return new Proxy(manager, {
    get(target, name) {
      if (name === "list") return () => target.list().filter((machine) => machine.id === id);
      if (name === "subscribe") {
        return (listener: (event: MachineEvent) => void) => target.subscribe((event) => {
          if (event.type === "machines") listener({ ...event, machines: event.machines.filter((machine) => machine.id === id) });
          else if (event.type === "machine-message" && event.machine_id === id) listener(event);
        });
      }
      const value: unknown = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** GET /s/<token>: the link's cookie, then the app on that machine with the token gone from the address. */
export function handleSessionLinkVisit(request: Request, pathname: string, links: SessionLinks): Response {
  setRequestRoute("/s/:token");
  const token = SESSION_LINK_VISIT.exec(pathname)?.[1];
  const link = request.method === "GET" && token !== undefined ? links.match(token) : null;
  if (link === null) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  return new Response(null, { status: 303, headers: {
    location: `/?machine=${encodeURIComponent(link.machine_id)}`,
    "set-cookie": linkCookie(token!, isSecureRequest(request)),
    "cache-control": "no-store",
  } });
}

/**
 * /api/session-links, for the owner only (the caller checks): list, make and revoke. A link is made for
 * this PC's own session or for a session found on this PC, never for any other kind of machine.
 */
export async function handleSessionLinksRequest(request: Request, pathname: string, links: SessionLinks, sessionMachines: () => readonly string[]): Promise<Response> {
  setRequestRoute(pathname === "/api/session-links" ? pathname : "/api/session-links/:id");
  if (pathname === "/api/session-links") {
    if (request.method === "GET") return jsonResponse(links.list(), 200, { "cache-control": "no-store" });
    if (request.method !== "POST") return badRequest("method_not_allowed", "use GET or POST");
    const body: unknown = await request.json().catch(() => null);
    const machineId = isJsonObject(body) ? body["machine_id"] : undefined;
    if (typeof machineId !== "string" || (machineId !== LOCAL_MACHINE && !sessionMachines().includes(machineId))) {
      return badRequest("invalid_machine", "machine_id must be local or a herdr session on this PC");
    }
    const { link, token } = links.create(machineId);
    return jsonResponse({ ...link, url: `${requestOrigin(request)}/s/${token}` } satisfies SessionLinkCreated, 201, { "cache-control": "no-store" });
  }
  if (request.method !== "DELETE") return badRequest("method_not_allowed", "use DELETE");
  const id = pathname.slice("/api/session-links/".length);
  return links.remove(id) ? jsonResponse({ ok: true }) : jsonResponse({ error: { code: "not_found", message: "no such link" } }, 404);
}
