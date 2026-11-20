import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionMachineId, type FoundHerdrSession } from "../shared/machines.ts";
import { MachineManager } from "./machines.ts";
import type { CompletionTracker } from "./completion.ts";
import type { MachineBridge } from "./herdr-core/machine-bridge.ts";
import type { PushService } from "./push.ts";
import { otherSessions } from "./session-bridge.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const settled = () => new Promise((resolve) => setImmediate(resolve));

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-session-machines-"));
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
  const observe = spyOn(manager as unknown as { observe(runtime: { machine: { state: string } }): Promise<void> }, "observe").mockImplementation(async (runtime) => { runtime.machine.state = "connected"; });
  const events: string[] = [];
  const start = async (id: string, socket: string): Promise<MachineBridge> => {
    events.push(`start ${id} ${socket}`);
    return { endpoint: { url: "http://127.0.0.1:1", token: "t" }, exited: new Promise(() => {}), stop: () => events.push(`stop ${id}`) };
  };
  manager.watchHerdrSessions(async () => [], start, 3_600_000);
  await settled();
  cleanups.push(() => { manager.stop(); observe.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, events, dir };
}

const work: FoundHerdrSession = { socket_path: "/home/u/.config/herdr/sessions/work/herdr.sock", session: "work", label: "work" };
const fallback: FoundHerdrSession = { socket_path: "/home/u/.config/herdr/herdr.sock", label: "Default session" };

describe("the id of a herdr session's machine", () => {
  it("comes from the session's name, so a restart finds the same one, and keeps the default session apart from a named one", () => {
    expect(sessionMachineId("work")).toBe("session-name-work");
    expect(sessionMachineId("work")).toBe(sessionMachineId("work"));
    expect(sessionMachineId(undefined)).toBe("session-default");
    expect(sessionMachineId("default")).not.toBe(sessionMachineId(undefined));
    expect(encodeURIComponent(sessionMachineId("a_b-C9"))).toBe("session-name-a_b-C9");
  });
});

describe("which herdr sessions become machines", () => {
  it("leaves out the socket this server serves itself, however it is spelled, and names each session once", () => {
    const own = "/home/u/.config/herdr/sessions/main/herdr.sock";
    const found: FoundHerdrSession[] = [
      { socket_path: own, session: "main", label: "main" },
      { socket_path: "/home/u/.config/herdr/sessions/../sessions/main/herdr.sock", session: "main", label: "main" },
      work,
      { socket_path: "/other/herdr/sessions/work/herdr.sock", session: "work", label: "work" },
      fallback,
    ];
    expect(otherSessions(found, own)).toEqual([work, fallback]);
  });
});

describe("herdr sessions as PCs", () => {
  it("shows each session as a PC of its own, which starts its server and is never saved here", async () => {
    const { manager, events, dir } = await fixture();
    manager.syncSessionMachines([work]);
    await settled();
    expect(manager.list()[1]).toMatchObject({ id: "session-name-work", name: "work", kind: "session", state: "connected" });
    expect(events).toEqual([`start session-name-work ${work.socket_path}`]);
    expect(() => manager.patch("session-name-work", { name: "x" })).toThrow("another herdr session");
    expect(() => manager.remove("session-name-work")).toThrow("another herdr session");
    (manager as unknown as { persist(): void }).persist();
    const saved = join(dir, "machines.json");
    expect(existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : []).toEqual([]);
  });

  it("keeps a session's machine while it runs, starts its server again on a moved socket, and drops it when the session is gone", async () => {
    const { manager, events } = await fixture();
    manager.syncSessionMachines([work, fallback]);
    await settled();
    manager.syncSessionMachines([work, fallback]);
    await settled();
    expect(manager.list().map((machine) => machine.id)).toEqual(["local", "session-name-work", "session-default"]);
    const moved = { ...work, socket_path: "/home/u/xdg/herdr/sessions/work/herdr.sock" };
    manager.syncSessionMachines([moved, fallback]);
    await settled();
    manager.syncSessionMachines([fallback]);
    expect(manager.list().map((machine) => machine.id)).toEqual(["local", "session-default"]);
    expect(events).toEqual([
      `start session-name-work ${work.socket_path}`, `start session-default ${fallback.socket_path}`,
      "stop session-name-work", `start session-name-work ${moved.socket_path}`, "stop session-name-work",
    ]);
  });

  it("stops every session's server with the manager", async () => {
    const { manager, events } = await fixture();
    manager.syncSessionMachines([work]);
    await settled();
    manager.stop();
    expect(events).toContain("stop session-name-work");
  });
});
