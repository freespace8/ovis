import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionMachineId, type FoundHerdrSession } from "../shared/machines.ts";
import { entryCommand, ROOT } from "./entries.ts";
import { sameSocket } from "./herdr/test-session.ts";
import type { MachineBridge } from "./herdr-core/machine-bridge.ts";

const READY_MS = 30_000;

/** The sessions found that become machines: one per id, never the socket this server itself serves (the local PC). */
export function otherSessions(found: readonly FoundHerdrSession[], own: string): FoundHerdrSession[] {
  const ours = sameSocket(own);
  const seen = new Set<string>();
  return found.filter((session) => {
    const id = sessionMachineId(session.session);
    if (sameSocket(session.socket_path) === ours || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Starts the server of another herdr session of this account (session-entry.ts): this server's own code in a
 * process of its own, pinned to that session's socket, on loopback for this one. Its state lives under
 * `<stateDir>/sessions/<id>`; it ends with this server (it holds the stdin this one keeps open).
 */
export async function startSessionBridge(id: string, socket: string, stateDir: string, signal?: AbortSignal): Promise<MachineBridge> {
  const dir = join(stateDir, "sessions", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ready = Promise.withResolvers<{ port: number; token: string }>();
  const child = Bun.spawn(entryCommand("session"), {
    cwd: ROOT, env: { ...process.env, OVIS_SESSION_SOCKET: socket, OVIS_SESSION_STATE: dir }, windowsHide: true, stdin: "pipe", stdout: "inherit", stderr: "inherit",
    ipc(message) {
      if (message?.type === "ready" && Number.isInteger(message.port) && typeof message.token === "string") ready.resolve({ port: message.port, token: message.token });
    },
  });
  const stop = () => {
    try { child.stdin.end(); } catch {}
    child.kill();
    return child.exited.then(() => undefined);
  };
  void child.exited.then((code) => ready.reject(new Error(`The server for ${id} stopped before it answered (exit ${code})`)));
  const timer = setTimeout(() => ready.reject(new Error(`The server for ${id} did not start within ${READY_MS / 1000}s`)), READY_MS);
  // this server is stopping: a child that has not answered yet is not waited for until READY_MS
  const abort = () => ready.reject(new Error(`The server for ${id} was stopped before it answered`));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    const { port, token } = await ready.promise;
    return { endpoint: { url: `http://127.0.0.1:${port}`, token }, exited: child.exited, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
