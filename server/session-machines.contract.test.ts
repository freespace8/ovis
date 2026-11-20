import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testShellEnv } from "../scripts/test-shell.ts";
import { testSocketPath } from "../scripts/test-herdr.ts";
import { sessionMachineId, type Machine } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { herdrRpc, ping, workspaceCreate } from "./herdr/client.ts";
import { createServer } from "./index.ts";

/**
 * Two herdr sessions of the test run's own config folder: the one every server here serves (the test session)
 * and a second one, which must appear as a machine of its own, reach its own panes, and go when it stops.
 * Only the second session is ever offered to the server under test: the account's own sessions are never read.
 * Finding sessions is herdr-discovery.test.ts's; this file covers what the server does with the ones it is given.
 */
const SECOND = `ovis-test-linked-${process.pid}`;
const LABEL = "ovis-test-linked-workspace";
const secondSocket = join(dirname(dirname(testSocketPath())), SECOND, "herdr.sock");
const herdr = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr");
const stateDir = mkdtempSync(join(tmpdir(), "ovis-session-machines-"));
const id = sessionMachineId(SECOND);
let secondServer: ReturnType<typeof Bun.spawn> | undefined;
let server: { port: number; stop: () => void } | undefined;
const base = () => `http://127.0.0.1:${server!.port}`;

async function until<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await Bun.sleep(50);
  }
}
const machines = async (): Promise<Machine[]> => ((await (await fetch(`${base()}/api/machines`)).json()) as { machines: Machine[] }).machines;

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
    port: 0, stateDir, registerBridge: false,
    // discovery hides this app's own test sessions (testHerdrSession), so the test offers the second one itself, while it answers
    herdrSessions: { pollMs: 100, read: async () => await ping(secondSocket).then(() => true, () => false) ? [{ socket_path: secondSocket, session: SECOND, label: SECOND }] : [] },
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

describe("another herdr session on this PC as a machine", () => {
  it("lists the second session as a connected PC named after it, and reaches that session's panes, not the served one's", async () => {
    const machine = await until("the second session connecting", async () => (await machines()).find((entry) => entry.id === id && entry.state === "connected"));
    expect(machine).toMatchObject({ kind: "session", name: SECOND, enabled: true });
    const labels = (snapshot: SessionSnapshot) => snapshot.workspaces.map((workspace) => workspace.label);
    const session = await (await fetch(`${base()}/api/machines/${encodeURIComponent(id)}/session`)).json() as { snapshot: SessionSnapshot } | SessionSnapshot;
    expect(labels("snapshot" in session ? session.snapshot : session)).toEqual([LABEL]);
    const own = await (await fetch(`${base()}/api/session`)).json() as { snapshot: SessionSnapshot } | SessionSnapshot;
    expect(labels("snapshot" in own ? own.snapshot : own)).not.toContain(LABEL);
    // the machine's server is the child pinned to the second session: its own socket answers with its own workspace
    const direct = await herdrRpc("workspace.list", {}, secondSocket, 5000) as { workspaces: { label?: string }[] };
    expect(direct.workspaces.map((workspace) => workspace.label)).toEqual([LABEL]);
  });

  it("is never saved, renamed or removed here, and leaves the list when its session stops", async () => {
    const refused = await fetch(`${base()}/api/machines/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "x-herdr-machine": "1" } });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await machines()).some((entry) => entry.id === id)).toBe(true);
    await Bun.spawn([herdr!, "--session", SECOND, "server", "stop"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
    await until("the second session leaving the list", async () => (await machines()).some((entry) => entry.id === id) ? undefined : true);
  });
});
