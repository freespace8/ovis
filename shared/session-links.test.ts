import { describe, expect, it } from "bun:test";
import { sessionLinkAllows } from "./session-links.ts";

const allows = (method: string, path: string, machineId: string) => sessionLinkAllows(method, new URL(path, "https://pc.example"), machineId);
const WORK = "session-name-work";

describe("what a private link reaches", () => {
  it("serves the app's own files to any link", () => {
    for (const machine of ["local", WORK]) for (const path of ["/", "/assets/app.js", "/sw.js", "/manifest.webmanifest", "/icons/icon-192.png", "/anything-else"]) {
      expect([machine, path, allows("GET", path, machine)]).toEqual([machine, path, true]);
    }
  });

  it("reaches the routes of its own session machine and no other machine's", () => {
    for (const path of ["session", "pane/input", "pane/prompt/answer", "workspace/create", "fs/file", "fs/text"]) {
      expect([path, allows("POST", `/api/machines/${WORK}/${path}`, WORK)]).toEqual([path, true]);
      expect([path, allows("POST", `/api/machines/other/${path}`, WORK)]).toEqual([path, false]);
      expect([path, allows("POST", `/api/machines/local/${path}`, WORK)]).toEqual([path, false]);
      expect([path, allows("POST", `/api/${path}`, WORK)]).toEqual([path, false]);
    }
  });

  it("reaches this session's own routes, plainly or as the local machine, when the link is to local", () => {
    for (const path of ["session", "pane/input", "tab/create", "layout/ratio", "agents", "fs/stat"]) {
      expect([path, allows("GET", `/api/${path}`, "local")]).toEqual([path, true]);
      expect([path, allows("GET", `/api/machines/local/${path}`, "local")]).toEqual([path, true]);
      expect([path, allows("GET", `/api/machines/${WORK}/${path}`, "local")]).toEqual([path, false]);
    }
  });

  it("refuses everything that is not a route of a machine", () => {
    for (const machine of ["local", WORK]) for (const [method, path] of [
      ["GET", "/api/devices"], ["POST", "/api/devices/pair/start"], ["POST", "/api/devices/revoke-all"], ["GET", "/api/session-links"], ["POST", "/api/session-links"],
      ["DELETE", "/api/session-links/abc"], ["GET", "/api/preferences"], ["PUT", "/api/preferences"], ["GET", "/api/seen"], ["POST", "/api/seen"],
      ["POST", "/api/push/subscribe"], ["GET", "/api/updates"], ["POST", "/api/updates/install"], ["POST", "/api/herdr/update"], ["GET", "/api/portal"],
      ["GET", "/api/account/status"], ["POST", "/api/account/link"], ["GET", "/api/relay"], ["POST", "/api/relay/start"], ["GET", "/api/access"],
      ["POST", "/api/runtime"], ["GET", "/api/runtime/move"], ["GET", "/api/usage"], ["GET", "/api/voice"], ["GET", "/api/cliproxy"], ["GET", "/api/fonts"],
      ["POST", "/api/auth"], ["DELETE", "/api/auth"], ["POST", "/api/devices/pair"], ["GET", "/api/bridge"], ["GET", "/api/herdr-ui"], ["GET", "/api/system/x"],
      ["POST", "/api/machines"], ["POST", "/api/machines/address"], ["POST", "/api/machines/relay"], ["GET", "/api/machines/ssh-candidates"], ["GET", "/api/machines/tailnet"],
      ["PATCH", `/api/machines/${WORK}`], ["DELETE", `/api/machines/${WORK}`], ["PATCH", "/api/machines/local"], ["POST", `/api/machines/${WORK}/update-bridge`],
      ["POST", `/api/machines/${WORK}/setup`], ["GET", `/api/machines/${WORK}/runtime/move`], ["POST", `/api/machines/${WORK}/runtime/move/install`],
      ["GET", `/api/machines/${WORK}/pane/read/extra`], ["GET", `/api/machines/${WORK}//session`], ["GET", `/api/machines/${WORK}/`],
    ] as const) {
      expect([machine, method, path, allows(method, path, machine)]).toEqual([machine, method, path, false]);
    }
  });

  it("shows the roster and its events, but asks no other machine for its boot", () => {
    for (const machine of ["local", WORK]) {
      expect(allows("GET", "/api/machines", machine)).toBe(true);
      expect(allows("GET", "/api/machines?compact_agents=1", machine)).toBe(true);
      expect(allows("GET", "/api/machines/events?compact_agents=1", machine)).toBe(true);
      expect(allows("GET", "/api/machines?verify_source_boot=local", machine)).toBe(false);
      expect(allows("GET", "/api/health", machine)).toBe(true);
      expect(allows("POST", "/api/health", machine)).toBe(false);
    }
  });

  it("opens a terminal socket for its own machine only", () => {
    expect(allows("GET", `/ws?machine_id=${WORK}&surface=app`, WORK)).toBe(true);
    expect(allows("GET", "/ws?machine_id=other", WORK)).toBe(false);
    expect(allows("GET", "/ws?machine_id=local", WORK)).toBe(false);
    expect(allows("GET", "/ws", WORK)).toBe(false);
    expect(allows("GET", `/ws?machine_id=${WORK}&machine_id=local`, WORK)).toBe(false);
    for (const path of ["/ws", "/ws?surface=app", "/ws?machine_id=local", "/ws?machine_id="]) expect([path, allows("GET", path, "local")]).toEqual([path, true]);
    expect(allows("GET", `/ws?machine_id=${WORK}`, "local")).toBe(false);
    expect(allows("GET", `/ws?machine_id=local&machine_id=${WORK}`, "local")).toBe(false);
  });
});
