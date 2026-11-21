import { createContext, useContext } from "react";

/** OVIS_UPDATES_OFF on the server (`updates_off` in /api/health): the page shows and asks for nothing about updates */
export const UpdatesOffContext = createContext(false);
export const useUpdatesOff = (): boolean => useContext(UpdatesOffContext);

/**
 * What the health answer says about updates. Until it has been read nothing is asked, so a server
 * with updates turned off is never sent an update request while its answer is on its way.
 */
export function updatesState(health: { updates_off?: boolean } | null): "unknown" | "off" | "on" {
  return health === null ? "unknown" : health.updates_off === true ? "off" : "on";
}
