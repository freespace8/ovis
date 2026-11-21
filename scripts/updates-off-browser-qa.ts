import { TEST_SESSION } from "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { systemUsageContext, UsageService } from "../server/usage.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

/**
 * OVIS_UPDATES_OFF in a real browser: the page of a server with updates turned off shows no update line or button,
 * says so in Settings → About, and never sends an update request; the same page of a server with updates on does
 * send them (the control that proves the request log sees them). Run with
 * `bun run check run --build bun scripts/updates-off-browser-qa.ts`.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-updates-off-qa-")));
const TOKEN = "updates-off-qa-token";
console.log(`updates-off-browser-qa: herdr session ${TEST_SESSION}`);

const servers: ReturnType<typeof createServer>[] = [];
let browser: Browser | undefined;

const UPDATE_REQUEST = /\/api\/(updates|herdr\/update|runtime\/move\/install|machines\/(update-all|install|[^/]+\/(update|update-bridge)))(\/|$|\?)/;

function serve(name: string, updatesOff: boolean): { origin: string } {
  const server = createServer({
    port: 0, hostname: "127.0.0.1", token: TOKEN, stateDir: join(root, name), registerBridge: false, updatesOff,
    usage: new UsageService({ ...systemUsageContext(), home: root, env: {} }, []), tailnetPcs: { readStatus: async () => null },
    sshCandidates: { sshDir: join(root, "no-ssh"), readStatus: async () => null },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}` };
}

async function open(origin: string): Promise<{ page: Page; asked: string[] }> {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })); });
  const signIn = await context.request.post(`${origin}/api/auth`, { data: { token: TOKEN }, headers: { "x-herdr-machine": "1", origin } });
  assert.equal(signIn.status(), 204);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const asked: string[] = [];
  page.on("request", (request) => { if (UPDATE_REQUEST.test(new URL(request.url()).pathname)) asked.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  await page.goto(origin);
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  await openSettingsPage(page, "About");
  return { page, asked };
}

try {
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });

  const control = serve("on", false);
  const on = await open(control.origin);
  await on.page.getByRole("heading", { name: "Updates", exact: true }).waitFor({ state: "attached" });
  await on.page.waitForTimeout(3_000); // fixed wait: the update status is asked at once and again every 2 s while Settings is open
  assert.ok(on.asked.some((line) => line === "GET /api/updates"), `the control page asks for the update status (${on.asked.join(", ")})`);
  console.log("control: the page of a server with updates on asks for its update status");

  const off = serve("off", true);
  const { page, asked } = await open(off.origin);
  const dialog = page.locator(".settings-dialog");
  const line = dialog.getByText("Updates are turned off on this server.", { exact: true });
  await line.waitFor();
  assert.equal(await line.count(), 1, "Settings → About says once that updates are turned off");
  assert.equal(await dialog.getByRole("button", { name: /update|install/i }).count(), 0, "About offers no update or install button");
  assert.equal(await dialog.getByText(/Update herdr|Check for updates|Update and restart|Install herdr-core/).count(), 0, "About names no update control");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForTimeout(5_000); // fixed wait: proving that no update request follows, the status poll being 2 s
  assert.equal(await page.locator(".update-notice").count(), 0, "no update line under the header");
  assert.deepEqual(asked, [], "the page sent no update request");
  const answer = await page.evaluate(async () => (await fetch("/api/updates", { cache: "no-store" })).status);
  assert.equal(answer, 403, "the server refuses the update status");
  console.log("off: no update line, button or request; Settings says updates are turned off");
  console.log("updates-off-browser-qa: ok");
} finally {
  await browser?.close();
  for (const server of servers) server.stop();
  rmSync(root, { recursive: true, force: true });
}
