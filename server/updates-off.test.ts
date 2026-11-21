import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noInstalledNotes, noUpdateNotes, unmanagedUpdateStatus, type UpdateRequest } from "../shared/update.ts";
import { HerdrUpdater } from "./herdr-update.ts";
import { createServer } from "./index.ts";
import type { UpdateService } from "./update-api.ts";

// OVIS_UPDATES_OFF: serve() reads it once and hands createServer `updatesOff`; every route that installs or
// updates software then answers 403 updates_off, and nothing runs.
const stateDir = mkdtempSync(join(tmpdir(), "ovis-updates-off-"));
const marker = join(stateDir, "herdr-ran");
const bin = join(stateDir, "fake-herdr");
const requested: UpdateRequest[] = [];
const updates: UpdateService = {
  status: () => unmanagedUpdateStatus(false),
  notes: () => noUpdateNotes(),
  installed: () => noInstalledNotes(),
  request: (request) => { requested.push(request); },
};
let off: ReturnType<typeof createServer>;
let on: ReturnType<typeof createServer>;

beforeAll(() => {
  writeFileSync(bin, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(bin, 0o755);
  const common = { port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, updates } as const;
  off = createServer({ ...common, stateDir: join(stateDir, "off"), updatesOff: true, herdrUpdate: new HerdrUpdater({ bin, platform: "linux", coreServed: () => false }) });
  on = createServer({ ...common, stateDir: join(stateDir, "on") });
});
afterAll(() => { off.stop(); on.stop(); rmSync(stateDir, { recursive: true, force: true }); });

const send = (server: { port: number }, method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { "x-herdr-update": "1", "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const MACHINE = "00000000-0000-4000-8000-000000000001";

describe("OVIS_UPDATES_OFF", () => {
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/updates"],
    ["GET", "/api/updates/notes"],
    ["GET", "/api/updates/installed"],
    ["POST", "/api/updates/check"],
    ["POST", "/api/updates/install", { expected_revision: "a".repeat(40) }],
    ["POST", "/api/updates/cancel"],
    ["GET", "/api/herdr/update"],
    ["POST", "/api/herdr/update"],
    ["POST", "/api/runtime/move/install"],
    ["POST", "/api/machines/update-all"],
    ["POST", "/api/machines/install", { destination: "someone@example.invalid" }],
    ["POST", `/api/machines/${MACHINE}/update`],
    ["POST", `/api/machines/${MACHINE}/update-bridge`],
    ["POST", `/api/machines/${MACHINE}/runtime/move/install`],
    ["POST", "/api/machines/setup", { destination: "someone@example.invalid", machine_id: MACHINE, update_remote: true }],
  ];
  for (const [method, path, body] of routes) {
    it(`answers ${method} ${path} with 403 updates_off`, async () => {
      const response = await send(off, method, path, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "updates_off", message: "Updates are turned off on this server (OVIS_UPDATES_OFF)." } });
    });
  }

  it("installs and runs nothing", () => {
    expect(requested).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("tells the page in /api/health, and only while it is on", async () => {
    expect(((await (await fetch(`http://127.0.0.1:${off.port}/api/health`)).json()) as { updates_off?: boolean }).updates_off).toBe(true);
    expect("updates_off" in ((await (await fetch(`http://127.0.0.1:${on.port}/api/health`)).json()) as object)).toBe(false);
  });

  it("leaves the routes alone while it is off", async () => {
    expect((await send(on, "GET", "/api/updates")).status).toBe(200);
    expect((await send(on, "POST", "/api/machines/update-all")).status).toBe(202);
  });
});
