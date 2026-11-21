import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_LINK_VISIT } from "../shared/session-links.ts";
import { decideAccess, ownerAccess, type AccessInput } from "./access.ts";
import { handleSessionLinksRequest, handleSessionLinkVisit, newLinkToken, SessionLinks } from "./session-links.ts";

const dirs: string[] = [];
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "ovis-session-links-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("a link token", () => {
  it("is 32 random bytes in URL-safe text, never the same twice", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 5000; n++) {
      const token = newLinkToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      seen.add(token);
    }
    expect(seen.size).toBe(5000);
  });
});

describe("the stored links", () => {
  it("keep only the token's hash, and find a link by hashing what is presented", () => {
    const dir = folder();
    const links = new SessionLinks(dir);
    const { link, token } = links.create("session-name-work");
    expect(link).toMatchObject({ machine_id: "session-name-work" });
    expect(link.id).toMatch(/^[0-9a-f]{32}$/);
    const file = join(dir, "session-links.json");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toEqual([{ id: link.id, hash: expect.stringMatching(/^[0-9a-f]{64}$/), machine_id: "session-name-work", created_at: link.created_at }]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(links.match(token)).toEqual({ id: link.id, machine_id: "session-name-work" });
    expect(links.match(`${token}x`)).toBeNull();
    expect(links.match(newLinkToken())).toBeNull();
    expect(links.match("")).toBeNull();
  });

  it("allow several links to one machine, list them without a hash, and survive a restart", () => {
    const dir = folder();
    const first = new SessionLinks(dir);
    const a = first.create("local");
    const b = first.create("local");
    expect(a.token).not.toBe(b.token);
    expect(first.list().map((link) => link.id)).toEqual([a.link.id, b.link.id]);
    expect(Object.keys(first.list()[0]!).sort()).toEqual(["created_at", "id", "machine_id"]);
    const second = new SessionLinks(dir);
    expect(second.match(a.token)?.id).toBe(a.link.id);
    expect(second.match(b.token)?.id).toBe(b.link.id);
  });

  it("revoke one link at once: its token stops matching and what was opened with it ends", () => {
    const links = new SessionLinks(folder());
    const a = links.create("local");
    const b = links.create("local");
    const ended: string[] = [];
    links.onRevoke(a.link.id, () => ended.push("a"));
    links.onRevoke(b.link.id, () => ended.push("b"));
    expect(links.remove(a.link.id)).toBe(true);
    expect(ended).toEqual(["a"]);
    expect(links.match(a.token)).toBeNull();
    expect(links.match(b.token)).not.toBeNull();
    expect(links.remove(a.link.id)).toBe(false);
    links.onRevoke(a.link.id, () => ended.push("late"));
    expect(ended).toEqual(["a", "late"]);
  });

  it("forget a watcher that stopped, and keep a file that is not a list as .bad when the next change is written", () => {
    const dir = folder();
    const links = new SessionLinks(dir);
    const { link } = links.create("local");
    let ended = 0;
    links.onRevoke(link.id, () => ended++)();
    links.remove(link.id);
    expect(ended).toBe(0);
    writeFileSync(join(dir, "session-links.json"), "{not json");
    const damaged = new SessionLinks(dir);
    expect(damaged.list()).toEqual([]);
    damaged.create("local");
    expect(readFileSync(join(dir, "session-links.json.bad"), "utf8")).toBe("{not json");
  });
});

describe("the link as an access", () => {
  const base: AccessInput = {
    loopback: false, forwarded: false, funnel: false, tailscaleLogin: null, host: "pc.example", tokenMatched: false, device: null, owner: null,
    tagged: false, soleLogin: null, dnsName: null, tailnetIp: null, serveOnly: false, tokenConfigured: false, gated: false,
  };
  const link = { id: "a".repeat(32), machine_id: "session-name-work" };

  it("lets in a stranger of a PC that wants a token or pairing, as a driver of one session", () => {
    for (const input of [{ tokenConfigured: true }, { gated: true }, { loopback: true, forwarded: true, owner: "me@example.com" }]) {
      expect(decideAccess({ ...base, ...input, link })).toEqual({ level: "full", via: "link", role: "drive", link });
    }
  });

  it("narrows the open install's anonymous visitor, and yields to every owner credential", () => {
    expect(decideAccess({ ...base, link })).toMatchObject({ via: "link" });
    expect(decideAccess({ ...base, tokenConfigured: true, tokenMatched: true, link })).toMatchObject({ via: "token" });
    expect(decideAccess({ ...base, gated: true, device: { id: "d", role: "watch" } as never, link })).toMatchObject({ via: "device", role: "watch" });
    expect(decideAccess({ ...base, loopback: true, link })).toMatchObject({ via: "local" });
    expect(decideAccess({ ...base, relayPeer: { id: "r", role: "drive" } as never, link })).toMatchObject({ via: "relay" });
  });

  it("is never the owner", () => {
    expect(ownerAccess(decideAccess({ ...base, tokenConfigured: true, link }))).toBe(false);
  });
});

describe("the link's HTTP routes", () => {
  const visit = (links: SessionLinks, path: string, url = "http://pc.example") => handleSessionLinkVisit(new Request(`${url}${path}`), path, links);

  it("sets the cookie and sends the visitor to the machine with the token out of the address", () => {
    const links = new SessionLinks(folder());
    const { token } = links.create("session-name-work");
    const response = visit(links, `/s/${token}`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?machine=session-name-work");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toStartWith(`ovis_link=${token};`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
    expect(visit(links, `/s/${token}`, "https://pc.example").headers.get("set-cookie")).toContain("Secure");
  });

  it("answers an unknown or malformed token with the plain 404 and no cookie", () => {
    const links = new SessionLinks(folder());
    for (const path of [`/s/${newLinkToken()}`, "/s/short", "/s/", `/s/${newLinkToken()}/x`]) {
      const response = visit(links, path);
      expect(response.status).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(SESSION_LINK_VISIT.test(`/s/${newLinkToken()}`)).toBe(true);
  });

  it("makes links only for this session or a session machine, and tells the address once", async () => {
    const links = new SessionLinks(folder());
    const ask = (method: string, path: string, body?: unknown) => handleSessionLinksRequest(
      new Request(`https://pc.example${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path, links, () => ["session-name-work"], () => false);
    expect((await ask("POST", "/api/session-links", { machine_id: "ssh-pc" })).status).toBe(400);
    expect((await ask("POST", "/api/session-links", { machine_id: 4 })).status).toBe(400);
    expect((await ask("POST", "/api/session-links", {})).status).toBe(400);
    const made = await ask("POST", "/api/session-links", { machine_id: "session-name-work" });
    expect(made.status).toBe(201);
    const body = await made.json() as { id: string; machine_id: string; url: string };
    expect(body.url).toMatch(/^https:\/\/pc\.example\/s\/[A-Za-z0-9_-]{43}$/);
    expect(links.match(body.url.split("/s/")[1]!)?.id).toBe(body.id);
    expect((await ask("POST", "/api/session-links", { machine_id: "local" })).status).toBe(201);
    const listed = await (await ask("GET", "/api/session-links")).json() as unknown[];
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(body.url.split("/s/")[1]!);
    expect((await ask("DELETE", `/api/session-links/${body.id}`)).status).toBe(200);
    expect((await ask("DELETE", `/api/session-links/${body.id}`)).status).toBe(404);
    expect((await ask("PUT", "/api/session-links")).status).toBe(400);
  });

  it("makes no link while the server is open to the network, and says what to do", async () => {
    const links = new SessionLinks(folder());
    const response = await handleSessionLinksRequest(new Request("https://pc.example/api/session-links", { method: "POST", body: JSON.stringify({ machine_id: "local" }) }),
      "/api/session-links", links, () => [], () => true);
    expect(response.status).toBe(409);
    const error = (await response.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("server_open");
    expect(error.message).toContain("access token");
    expect(links.list()).toEqual([]);
  });
});
