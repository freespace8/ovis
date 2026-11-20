// The server of one more herdr session of this account (session-bridge.ts starts it): herdr's API answered
// from that session's socket, served on loopback to the server that started it, as an SSH PC's bridge serves
// its own (server/remote-entry.ts).
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { checkHerdrSockets } from "./herdr/client.ts";
import { heldHerdrSocketStatus, pinnedHerdrSocketStatus } from "./herdr-discovery.ts";
import { createServer } from "./index.ts";
import { AgentDetector, catalogLocator, defaultLoginProbe } from "./agent-catalog-detect.ts";
import { ShellAgentLocator } from "./shell-agent.ts";

const socket = process.env["OVIS_SESSION_SOCKET"];
const stateDir = process.env["OVIS_SESSION_STATE"];
if (!socket || !stateDir) throw new Error("session-entry.ts runs only as session-bridge.ts starts it");
// the same checks as the machine profile's pinned session: this account's socket under its herdr folders, checked before every connection
const { status, place, reason } = await pinnedHerdrSocketStatus(socket);
if (status !== "usable") throw new Error(reason ?? `The herdr session at ${socket} is not usable`);
const unavailable = join(stateDir, "unavailable", "herdr.sock");
checkHerdrSockets((path) => heldHerdrSocketStatus(path, place) === "usable" ? path : unavailable);
process.env["HERDR_SOCKET"] = socket;
const token = randomBytes(32).toString("hex");
const server = createServer({ port: 0, hostname: "127.0.0.1", token, machines: false, bridgeOnly: true, stateDir, shellAgents: new ShellAgentLocator(), agentDetector: new AgentDetector({ locate: catalogLocator({ probe: defaultLoginProbe() }) }) });
process.send?.({ type: "ready", port: server.port, token });
for await (const _chunk of Bun.stdin.stream()) {}
server.stop();
process.exit(0);
