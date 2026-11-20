/**
 * Private links to one herdr session: whoever opens one drives that session and reaches nothing else of
 * this PC. A link's address is shown once, when it is made; the server keeps only a hash of it.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import "./SessionLinksDialog.css";

import type { SessionLink } from "../../shared/session-links.ts";
import { ApiError, createSessionLink, fetchSessionLinks, revokeSessionLink } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";

interface Props {
  machineId: string;
  machineName: string;
  onClose: () => void;
}

const failure = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

export function SessionLinksDialog({ machineId, machineName, onClose }: Props) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  const address = useRef<HTMLInputElement>(null);
  const [links, setLinks] = useState<SessionLink[] | null>(null);
  const [made, setMade] = useState<{ url: string; copied: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (surface.current === null || event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, surface]);

  const load = useCallback(() => fetchSessionLinks().then((all) => setLinks(all.filter((link) => link.machine_id === machineId)), (reason: unknown) => setError(failure(reason))), [machineId]);
  useEffect(() => { void load(); }, [load]);

  const act = async (deed: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try { await deed(); await load(); } catch (reason) { setError(failure(reason)); } finally { setBusy(false); }
  };
  const create = () => act(async () => { setMade({ url: (await createSessionLink(machineId)).url, copied: false }); });
  const copy = async (url: string): Promise<void> => {
    if (await copyText(url, address.current)) setMade({ url, copied: true });
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal session-links-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Private link to {name}", { name: machineName })}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body session-links-body">
          <p className="session-links-note">{t("Anyone who opens a private link can operate this session with full control, and reaches nothing else on this PC. Revoke a link to end its access at once.")}</p>
          {made !== null && <div className="session-links-made" role="status">
            <label htmlFor={`${id}-url`}>{t("Copy this link now: it is shown only once and cannot be read back.")}</label>
            <div className="session-links-url">
              <input ref={address} id={`${id}-url`} className="input" type="text" readOnly value={made.url} onFocus={(event) => event.currentTarget.select()} />
              <button type="button" className="btn" onClick={() => void copy(made.url)}>{t(made.copied ? "Copied" : "Copy")}</button>
            </div>
          </div>}
          {error !== null && <p className="session-links-error" role="alert">{error}</p>}
          <ul className="session-links-list" aria-label={t("Links to this session")}>
            {links?.map((link) => <li key={link.id} className="session-links-row">
              <span className="session-links-created">{t("Created {when}", { when: new Date(link.created_at).toLocaleString() })}</span>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(() => revokeSessionLink(link.id))}>{t("Revoke")}</button>
            </li>)}
          </ul>
          {links !== null && links.length === 0 && <p className="session-links-empty">{t("No links to this session yet.")}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-primary" disabled={busy || links === null} onClick={() => void create()}>{t("Create private link")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
