import { TEST_SESSION, testSocketPath } from "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneRead, ping, workspaceCreate } from "../server/herdr/client.ts";
import { systemUsageContext, UsageService } from "../server/usage.ts";
import { sessionMachineId } from "../shared/machines.ts";
import { chromePath } from "./chrome-path.ts";
import { testShellEnv } from "./test-shell.ts";

/**
 * Private links in a real browser: the owner makes a link from the Manage menu, a visitor with no other credential opens
 * it and reaches that one session, the page asks for nothing the server refuses, and revoking ends it. Run with
 * `bun run check run --build bun scripts/session-links-browser-qa.ts`.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-links-qa-")));
const TOKEN = "session-links-qa-token";
const SECOND = `ovis-qa-links-${process.pid}`;
const secondSocket = join(dirname(dirname(testSocketPath())), SECOND, "herdr.sock");
const herdr = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr");
if (!herdr) throw new Error("this QA needs herdr installed");
console.log(`session-links-browser-qa: herdr session ${TEST_SESSION}, second session ${SECOND}`);

let secondServer: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function until<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await Bun.sleep(100);
  }
}

interface Case { name: string; machineId: string; workspace: string; pane: string; socket: string | undefined }

async function ownerMakesLink(owner: Page, target: Case, machineName: string): Promise<string> {
  const group = owner.locator(".machine-group").filter({ has: owner.locator(".machine-name", { hasText: machineName }) });
  // a row's actions show while the pointer is over it
  await group.locator(".machine-header").hover();
  await group.locator(".machine-manage").click();
  await owner.getByRole("menuitem", { name: "Private link…" }).click();
  const dialog = owner.getByRole("dialog", { name: /Private link to/ });
  await dialog.getByRole("button", { name: "Create private link" }).click();
  const url = await dialog.locator(".session-links-url input").inputValue();
  assert.match(url, /\/s\/[A-Za-z0-9_-]{43}$/, `${target.name}: the dialog shows the link's address`);
  await dialog.getByRole("button", { name: "Close" }).click();
  return url;
}

async function visitorFlow(context: BrowserContext, url: string, target: Case, origin: string): Promise<{ page: Page; closed: Promise<number> }> {
  const refused: string[] = [];
  const consoleErrors: string[] = [];
  context.on("response", (response) => {
    if (response.url().startsWith(origin) && (response.status() === 401 || response.status() === 403)) refused.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  const closed = new Promise<number>((resolve) => {
    page.on("websocket", (socket) => {
      // the socket that carries this session's terminal is the one that names its machine
      if (socket.url().includes(`machine_id=${encodeURIComponent(target.machineId)}`)) socket.on("close", () => resolve(1008));
    });
  });
  await page.goto(url);
  await page.locator(".workspace-header", { hasText: target.workspace }).first().waitFor();
  // (b) the token left the address bar, and the page is on that session
  const landed = new URL(page.url());
  assert.equal(landed.pathname, "/", `${target.name}: the address is the app's own`);
  assert.ok(!page.url().includes("/s/") && !page.url().includes(url.split("/s/")[1]!), `${target.name}: no token in the address`);
  // nothing of the PC around the session
  assert.equal(await page.locator(".machine-group").count(), 1, `${target.name}: one machine in the sidebar`);
  for (const absent of [".sidebar-footer-settings", ".machine-manage", ".sidebar-account-pcs", ".inbox-rail-settings"]) {
    assert.equal(await page.locator(absent).count(), 0, `${target.name}: no ${absent}`);
  }
  // the pane's terminal takes typing, which reaches the pane
  await page.locator(".workspace-header", { hasText: target.workspace }).first().click();
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `links-${target.name}-visitor.png`) }); }
  const marker = `qa-link-${Date.now()}`;
  // typing before the attach takes keys is held as a draft, never sent: wait for the live input first
  await page.locator(".conn-live").waitFor();
  await page.locator(".terminal-banner", { hasText: "Waiting for terminal input…" }).waitFor({ state: "hidden" });
  await page.locator(".xterm").first().click();
  await page.keyboard.type(`echo ${marker}`);
  await page.keyboard.press("Enter");
  await until(`${target.name}: typed text reaching the pane`, async () => (await paneRead({ paneId: target.pane, source: "recent" }, target.socket)).text.includes(marker) ? true : undefined);
  // the More menu and the command palette offer nothing that a link may not do
  await page.locator(".header-more-button").click();
  const items = await page.locator('.row-menu [role="menuitem"], .row-menu [role="menuitemcheckbox"], .row-sheet .row-sheet-item').allTextContents();
  assert.ok(items.length > 0, `${target.name}: the More menu opens`);
  for (const item of items) assert.ok(!/^(Alerts|Settings|Add a PC|Private link)/.test(item.trim()), `${target.name}: More offers "${item.trim()}"`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+K");
  const palette = page.getByRole("dialog").first();
  await palette.waitFor();
  const rows = await palette.locator("[role=option], .palette-row, li").allTextContents();
  for (const row of rows) assert.ok(!/(^|\s)(Settings|Add PC|Enable notifications)/.test(row.trim()), `${target.name}: the palette offers "${row.trim()}"`);
  await page.keyboard.press("Escape");
  // let every background request settle before judging them
  await page.waitForTimeout(3_000); // fixed wait: proving that no refused request follows the page's startup
  // (c) nothing the server refused, in the whole visit
  assert.deepEqual(refused, [], `${target.name}: the visitor's page was refused requests`);
  assert.deepEqual(consoleErrors.filter((text) => /40[13]|Forbidden|Unauthorized|WebSocket connection/.test(text)), [], `${target.name}: the console reports a refusal`);
  return { page, closed };
}

try {
  mkdirSync(dirname(secondSocket), { recursive: true });
  secondServer = Bun.spawn([herdr, "--session", SECOND, "server"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HERDR|OMO|SENPI|PI)_/.test(name))), ...testShellEnv(dirname(secondSocket)) },
  });
  await until("the second herdr session starting", async () => existsSync(secondSocket) ? await ping(secondSocket).then(() => true, () => undefined) : undefined);
  const mine = join(root, "mine"); mkdirSync(mine);
  const theirs = join(root, "theirs"); mkdirSync(theirs);
  const localWs = await workspaceCreate({ cwd: mine, label: "qa-links-local" });
  const secondWs = await workspaceCreate({ cwd: theirs, label: "qa-links-second" }, secondSocket);
  const cases: Case[] = [
    { name: "local", machineId: "local", workspace: "qa-links-local", pane: localWs.root_pane.pane_id, socket: undefined },
    { name: "session", machineId: sessionMachineId(SECOND), workspace: "qa-links-second", pane: secondWs.root_pane.pane_id, socket: secondSocket },
  ];
  server = createServer({
    port: 0, hostname: "127.0.0.1", token: TOKEN, stateDir: join(root, "state"), registerBridge: false,
    usage: new UsageService({ ...systemUsageContext(), home: root, env: {} }, []), tailnetPcs: { readStatus: async () => null },
    sshCandidates: { sshDir: join(root, "no-ssh"), readStatus: async () => null },
    // discovery hides this app's own test sessions (testHerdrSession), so the QA offers the second one itself, while it answers
    herdrSessions: { pollMs: 100, read: async () => await ping(secondSocket).then(() => true, () => false) ? [{ socket_path: secondSocket, session: SECOND, label: SECOND }] : [] },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });

  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ownerContext.addInitScript(() => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })); });
  const signIn = await ownerContext.request.post(`${origin}/api/auth`, { data: { token: TOKEN }, headers: { "x-herdr-machine": "1", origin } });
  assert.equal(signIn.status(), 204);
  const owner = await ownerContext.newPage();
  owner.setDefaultTimeout(15_000);
  await owner.goto(origin);
  await until("the second session in the owner's sidebar", async () => (await owner.locator(".machine-name", { hasText: SECOND }).count()) > 0 ? true : undefined);

  for (const target of cases) {
    // (a) the owner makes the link from the machine's Manage menu
    const name = target.machineId === "local" ? await owner.locator(".machine-group").first().locator(".machine-name").innerText() : SECOND;
    const url = await ownerMakesLink(owner, target, name);
    console.log(`${target.name}: owner made a link (${url.replace(/\/s\/.*/, "/s/…")})`);
    // (b, c) a fresh browser with the link and nothing else
    const visitorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // a named font would have the page ask the PC's fonts folder, which a link may not read
    await visitorContext.addInitScript(() => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", uiFontFamily: "QA Link Font", chatFontFamily: "QA Link Font" })); });
    const { page, closed } = await visitorFlow(visitorContext, url, target, origin);
    console.log(`${target.name}: visitor reached the session, typed into its pane, and asked nothing the server refused`);
    // (d) revoking ends the socket and refuses the next call
    const links = await (await ownerContext.request.get(`${origin}/api/session-links`)).json() as { id: string; machine_id: string }[];
    const mineLink = links.find((link) => link.machine_id === target.machineId)!;
    const revoked = await ownerContext.request.delete(`${origin}/api/session-links/${mineLink.id}`, { headers: { "x-herdr-machine": "1", origin } });
    assert.equal(revoked.status(), 200);
    assert.equal(await Promise.race([closed, Bun.sleep(10_000).then(() => 0)]), 1008, `${target.name}: the visitor's socket closed`);
    const after = await page.evaluate(async () => (await fetch("/api/machines")).status);
    assert.ok(after === 401 || after === 403, `${target.name}: the next call is refused (${after})`);
    console.log(`${target.name}: revoked; socket closed, next call ${after}`);
    await visitorContext.close();
  }
  console.log("session-links-browser-qa: ok");
} finally {
  await browser?.close();
  server?.stop();
  await Bun.spawn([herdr, "--session", SECOND, "server", "stop"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
  secondServer?.kill();
  rmSync(dirname(secondSocket), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
