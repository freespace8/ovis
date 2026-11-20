import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testShellEnv } from "../scripts/test-shell.ts";
import { testSocketPath } from "../scripts/test-herdr.ts";
import { sessionMachineId, type Machine } from "../shared/machines.ts";
import type { SessionLink, SessionLinkCreated } from "../shared/session-links.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { ping, workspaceCreate } from "./herdr/client.ts";
import { createServer } from "./index.ts";

/**
 * The server holds a token, so a visitor with no credential of its own is let in only by a private link.
 * Two herdr sessions of the run's config folder: the one the server serves (the test session) and a second
 * one it serves as a machine of its own, which a link may name.
 */
const SECOND = `ovis-test-private-link-${process.pid}`;
const LABEL = "ovis-test-private-link-workspace";
const TOKEN = "owner-token-for-the-links-test";
const secondSocket = join(dirname(dirname(testSocketPath())), SECOND, "herdr.sock");
const herdr = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr");
const stateDir = mkdtempSync(join(tmpdir(), "ovis-session-links-contract-"));
const id = sessionMachineId(SECOND);
let secondServer: ReturnType<typeof Bun.spawn> | undefined;
let server: { port: number; stop: () => void } | undefined;
const base = () => `http://127.0.0.1:${server!.port}`;
const owner = { authorization: `Bearer ${TOKEN}`, "x-herdr-machine": "1" };
// discovery hides this app's own test sessions (testHerdrSession), so the test offers the second one itself, while it answers
const herdrSessions = { pollMs: 100, read: async () => await ping(secondSocket).then(() => true, () => false) ? [{ socket_path: secondSocket, session: SECOND, label: SECOND }] : [] };

async function until<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await Bun.sleep(50);
  }
}

/** Opens a link as a browser does: the cookie its redirect sets is all the visitor holds afterwards. */
async function visit(url: string): Promise<{ cookie: string; location: string }> {
  const response = await fetch(url, { redirect: "manual" });
  expect(response.status).toBe(303);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, location: response.headers.get("location")! };
}
const as = (cookie: string, path: string, init: RequestInit = {}) => fetch(`${base()}${path}`, { ...init, headers: { cookie, ...init.headers } });
const make = async (machine_id: string): Promise<SessionLinkCreated> => {
  const response = await fetch(`${base()}/api/session-links`, { method: "POST", headers: owner, body: JSON.stringify({ machine_id }) });
  expect(response.status).toBe(201);
  return await response.json() as SessionLinkCreated;
};
const labels = (snapshot: SessionSnapshot) => snapshot.workspaces.map((workspace) => workspace.label);
const snapshotOf = async (response: Response): Promise<SessionSnapshot> => {
  const body = await response.json() as { snapshot: SessionSnapshot } | SessionSnapshot;
  return "snapshot" in body ? body.snapshot : body;
};
const Socket = WebSocket as unknown as new (url: string, options: { headers: { cookie: string } }) => WebSocket;

beforeAll(async () => {
  if (!herdr) throw new Error("these tests need herdr installed");
  mkdirSync(dirname(secondSocket), { recursive: true });
  secondServer = Bun.spawn([herdr, "--session", SECOND, "server"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HERDR|OMO|SENPI|PI)_/.test(name))), ...testShellEnv(dirname(secondSocket)) },
  });
  await until("the second herdr session starting", async () => existsSync(secondSocket) ? await ping(secondSocket).then(() => true, () => undefined) : undefined);
  await workspaceCreate({ cwd: tmpdir(), label: LABEL }, secondSocket);
  server = createServer({
    port: 0, stateDir, registerBridge: false, token: TOKEN, herdrSessions,
  });
  await until("the second session connecting", async () => {
    const roster = await (await fetch(`${base()}/api/machines`, { headers: owner })).json() as { machines: Machine[] };
    return roster.machines.find((machine) => machine.id === id && machine.state === "connected");
  });
}, 60_000);

afterAll(async () => {
  server?.stop();
  if (herdr && secondServer) {
    await Bun.spawn([herdr, "--session", SECOND, "server", "stop"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
    secondServer.kill();
    await secondServer.exited;
  }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(dirname(secondSocket), { recursive: true, force: true });
});

describe("a private link to a herdr session", () => {
  it("is made by the owner alone, for this session or a session machine, and listed without its token", async () => {
    expect((await fetch(`${base()}/api/session-links`)).status).toBe(401);
    expect((await fetch(`${base()}/api/session-links`, { method: "POST", headers: { "x-herdr-machine": "1" }, body: JSON.stringify({ machine_id: id }) })).status).toBe(401);
    const refused = await fetch(`${base()}/api/session-links`, { method: "POST", headers: owner, body: JSON.stringify({ machine_id: "no-such-machine" }) });
    expect(refused.status).toBe(400);
    const created = await make(id);
    expect(created.machine_id).toBe(id);
    expect(created.url).toMatch(new RegExp(`^${base()}/s/[A-Za-z0-9_-]{43}$`));
    const listed = await (await fetch(`${base()}/api/session-links`, { headers: owner })).json() as SessionLink[];
    expect(listed.find((link) => link.id === created.id)).toEqual({ id: created.id, machine_id: id, created_at: created.created_at });
    expect(JSON.stringify(listed)).not.toContain(created.url.split("/s/")[1]!);
    await fetch(`${base()}/api/session-links/${created.id}`, { method: "DELETE", headers: owner });
  });

  it("gives a visitor with only its cookie that session's panes and socket, and nothing else", async () => {
    const created = await make(id);
    const { cookie, location } = await visit(created.url);
    expect(location).toBe(`/?machine=${encodeURIComponent(id)}`);
    // the session's own workspace is read through the machine route, and the roster holds that machine alone
    const session = await as(cookie, `/api/machines/${encodeURIComponent(id)}/session`);
    expect(session.status).toBe(200);
    expect(labels(await snapshotOf(session))).toEqual([LABEL]);
    const roster = await (await as(cookie, "/api/machines")).json() as { machines: Machine[] };
    expect(roster.machines.map((machine) => machine.id)).toEqual([id]);
    const health = await (await as(cookie, "/api/health?scope=bridge")).json() as { auth: { via: string; role: string; link: { machine_id: string } }; relay?: unknown; security?: unknown };
    expect(health.auth).toMatchObject({ authenticated: true, via: "link", role: "drive", link: { machine_id: id } });
    expect(health.relay).toBeUndefined();
    expect(health.security).toBeUndefined();
    const socket = new Socket(`ws://127.0.0.1:${server!.port}/ws?machine_id=${encodeURIComponent(id)}`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("the link's socket did not open")); });
    socket.close();
    // another machine, this server's own session, and every control that is not a machine's route
    for (const [method, path] of [
      ["GET", "/api/machines/local/session"], ["GET", "/api/session"], ["GET", "/api/machines/other-pc/session"], ["GET", "/api/devices"], ["POST", "/api/devices/pair/start"],
      ["GET", "/api/session-links"], ["POST", "/api/session-links"], ["DELETE", `/api/session-links/${created.id}`], ["GET", "/api/preferences"], ["PUT", "/api/preferences"],
      ["GET", "/api/updates"], ["POST", "/api/relay/start"], ["GET", "/api/account/status"], ["POST", "/api/machines/address"], ["PATCH", `/api/machines/${encodeURIComponent(id)}`],
      ["DELETE", `/api/machines/${encodeURIComponent(id)}`], ["GET", "/api/machines?verify_source_boot=local"], ["POST", "/api/push/subscribe"],
    ] as const) {
      const response = await as(cookie, path, { method, headers: { "x-herdr-machine": "1" }, ...(method === "GET" ? {} : { body: "{}" }) });
      expect([method, path, response.status]).toEqual([method, path, 403]);
    }
    for (const machine of ["local", "other-pc"]) {
      const response = await as(cookie, `/ws?machine_id=${machine}`, { headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
      expect([machine, response.status]).toEqual([machine, 403]);
    }
    await fetch(`${base()}/api/session-links/${created.id}`, { method: "DELETE", headers: owner });
  });

  it("ends at once when the owner revokes it: the cookie is refused and an open socket closes with 1008", async () => {
    const created = await make(id);
    const { cookie } = await visit(created.url);
    const socket = new Socket(`ws://127.0.0.1:${server!.port}/ws?machine_id=${encodeURIComponent(id)}`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("the link's socket did not open")); });
    const closed = new Promise<number>((resolve) => { socket.onclose = (event) => resolve(event.code); });
    expect((await as(cookie, `/api/machines/${encodeURIComponent(id)}/session`)).status).toBe(200);
    expect((await fetch(`${base()}/api/session-links/${created.id}`, { method: "DELETE", headers: owner })).status).toBe(200);
    expect(await closed).toBe(1008);
    expect((await as(cookie, `/api/machines/${encodeURIComponent(id)}/session`)).status).toBe(401);
    expect((await as(cookie, "/api/health?scope=bridge").then((response) => response.json()) as { auth: { authenticated: boolean } }).auth.authenticated).toBe(false);
    expect((await fetch(created.url, { redirect: "manual" })).status).toBe(404);
  });

  it("opens this server's own session for a link to local, and no machine of the roster besides", async () => {
    const created = await make("local");
    const { cookie, location } = await visit(created.url);
    expect(location).toBe("/?machine=local");
    expect((await as(cookie, "/api/session")).status).toBe(200);
    expect((await as(cookie, "/api/machines/local/session")).status).toBe(200);
    const roster = await (await as(cookie, "/api/machines")).json() as { machines: Machine[] };
    expect(roster.machines.map((machine) => machine.id)).toEqual(["local"]);
    expect((await as(cookie, `/api/machines/${encodeURIComponent(id)}/session`)).status).toBe(403);
    expect((await as(cookie, "/api/devices")).status).toBe(403);
    const socket = new Socket(`ws://127.0.0.1:${server!.port}/ws`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("the link's socket did not open")); });
    socket.close();
    await fetch(`${base()}/api/session-links/${created.id}`, { method: "DELETE", headers: owner });
  });

  it("answers an unknown token with the 404 of any unknown address and sets no cookie", async () => {
    const response = await fetch(`${base()}/s/${"A".repeat(43)}`, { redirect: "manual" });
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await fetch(`${base()}/s/short`, { redirect: "manual" })).status).toBe(404);
  });

  it("is still there after the server restarts, because it is kept hashed on disk", async () => {
    const created = await make(id);
    const { cookie } = await visit(created.url);
    server!.stop();
    server = createServer({
      port: 0, stateDir, registerBridge: false, token: TOKEN, herdrSessions,
    });
    const session = await until("the link answering after a restart", async () => {
      const response = await as(cookie, `/api/machines/${encodeURIComponent(id)}/session`);
      return response.status === 200 ? response : undefined;
    });
    expect(labels(await snapshotOf(session))).toEqual([LABEL]);
  });
});
