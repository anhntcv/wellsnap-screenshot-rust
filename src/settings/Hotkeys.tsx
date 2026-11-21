import { useId, useState, type ReactNode } from "react";
import type { Platform } from "../shared/ipc";
import { api } from "../shared/ipc";
import type { TFunction } from "../shared/i18n";
import { CaptureFix, ConflictCard, useConflicts } from "../shared/ui/ConflictCard";
import { alternativeKey, captureAdvice, fixSteps, isTaken, suspectsOf, takenText } from "../shared/ui/conflicts";
import { Button, Notice, Row, Switch } from "../shared/ui/controls";
import { defaultHotkeys, formatAccelerator, sameAccelerator, suggestedHotkeys } from "../shared/ui/hotkey";
import { Icon } from "../shared/ui/icons";
import { PrintScreenCard } from "../shared/ui/PrintScreenCard";
import { PageHead } from "./General";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { captureStatus, fullScreenSaveStatus, fullScreenStatus, smartPasteStatus, type RowStatus } from "./hotkeyStatus";
import { openLink, pasteTargetsUrl } from "./links";
import type { PageProps } from "./types";

interface Fix {
  steps: string[];
  alternative: string | null;
  onRecheck: () => Promise<void>;
}

/** Another hotkey row. An empty value is a key that is turned off; `yields`: it is turned off on a clash. */
interface Other {
  value: string;
  label: string;
  yields: boolean;
}

export function Hotkeys({ t, lang, platform, settings, info, update, refreshInfo }: PageProps) {
  const defaults = defaultHotkeys(platform);
  const status = info?.hotkeys;
  const pasteKeys = formatAccelerator(platform === "macos" ? "Cmd+V" : "Ctrl+V", platform);
  const [openFailed, setOpenFailed] = useState(false);
  const conflicts = useConflicts(platform, settings.captureHotkey);
  const advice = captureAdvice({
    hotkey: settings.captureHotkey,
    status,
    printScreen: conflicts.printScreen,
    report: conflicts.report,
    platform,
  });

  const recheck = async () => {
    try {
      await api.hotkeysRecheck();
    } catch {
      // The status line is re-read below either way; the published status also rescans the conflicts.
    }
    refreshInfo();
  };
  // Windows: re-registering helps whenever another program may have held the key. "other" counts too, since
  // a core that does not classify errors yet reports a taken key that way. macOS keeps its usual texts.
  const fix: Fix | undefined =
    isTaken(advice) || (platform === "windows" && advice?.kind === "other")
      ? {
          steps: fixSteps(suspectsOf(advice), conflicts.printScreen, t),
          alternative: alternativeKey(advice, conflicts.report, [settings.captureHotkey, settings.smartPasteHotkey], platform),
          onRecheck: recheck,
        }
      : undefined;

  // A row refuses a combination another row already has, except that the full screen keys give way: when
  // Print Screen is taken and capture moves to Ctrl+PrintScreen, the core turns the full screen key off
  // (Settings::sanitize) and the row says so. Saving also gives way to the full screen editor key.
  const assigned = {
    capture: { value: settings.captureHotkey, label: t("settings.hotkeys.capture"), rank: 0 },
    smartPaste: { value: settings.smartPasteHotkey, label: t("settings.hotkeys.smartPaste"), rank: 0 },
    fullScreen: { value: settings.fullScreenHotkey, label: t("settings.hotkeys.fullScreen"), rank: 1 },
    fullScreenSave: { value: settings.fullScreenSaveHotkey, label: t("settings.hotkeys.fullScreenSave"), rank: 2 },
  };
  type Assigned = keyof typeof assigned;
  const othersThan = (own: Assigned): Other[] =>
    (Object.keys(assigned) as Assigned[])
      .filter((k) => k !== own)
      .map((k) => ({ value: assigned[k].value, label: assigned[k].label, yields: assigned[k].rank > assigned[own].rank }));
  const suggested = suggestedHotkeys(platform);

  return (
    <>
      <PageHead title={t("settings.hotkeys.title")} lead={t("settings.hotkeys.lead")} />
      <section className="group">
        <HotkeyRow
          label={t("settings.hotkeys.capture")}
          description={t("settings.hotkeys.captureDesc")}
          value={settings.captureHotkey}
          fallback={defaults.capture}
          others={othersThan("capture")}
          offerPrintScreen={platform === "windows"}
          status={captureStatus(status)}
          statusText={takenText(advice, formatAccelerator(settings.captureHotkey, platform), t)}
          fix={fix}
          platform={platform}
          t={t}
          save={(captureHotkey) => update({ captureHotkey })}
        />
        <HotkeyRow
          label={t("settings.hotkeys.fullScreen")}
          description={t("settings.hotkeys.fullScreenDesc")}
          value={settings.fullScreenHotkey}
          fallback={defaults.fullScreen}
          suggestion={suggested.fullScreen}
          others={othersThan("fullScreen")}
          canTurnOff
          status={fullScreenStatus(status, settings.fullScreenHotkey)}
          platform={platform}
          t={t}
          save={(fullScreenHotkey) => update({ fullScreenHotkey })}
        />
        <HotkeyRow
          label={t("settings.hotkeys.fullScreenSave")}
          description={
            t("settings.hotkeys.fullScreenSaveDesc") +
            (platform === "macos"
              ? ` ${t("settings.hotkeys.fullScreenSaveMac", { shot3: formatAccelerator("Cmd+Shift+3", platform) })}`
              : "")
          }
          value={settings.fullScreenSaveHotkey}
          fallback={defaults.fullScreenSave}
          suggestion={suggested.fullScreenSave}
          others={othersThan("fullScreenSave")}
          canTurnOff
          status={fullScreenSaveStatus(status, settings.fullScreenSaveHotkey)}
          platform={platform}
          t={t}
          save={(fullScreenSaveHotkey) => update({ fullScreenSaveHotkey })}
        />
        <HotkeyRow
          label={t("settings.hotkeys.smartPaste")}
          description={t("settings.hotkeys.smartPasteDesc")}
          link={
            <button type="button" className="link-btn" onClick={async () => setOpenFailed(!(await openLink(pasteTargetsUrl(lang))))}>
              {t("settings.hotkeys.smartPasteWhere")}
              <Icon name="external" size={13} />
            </button>
          }
          value={settings.smartPasteHotkey}
          fallback={defaults.smartPaste}
          others={othersThan("smartPaste")}
          status={smartPasteStatus(status)}
          platform={platform}
          t={t}
          save={(smartPasteHotkey) => update({ smartPasteHotkey })}
        />
        <Row
          label={t("settings.hotkeys.ctrlV", { keys: pasteKeys })}
          description={
            t("settings.hotkeys.ctrlVDesc", { keys: pasteKeys }) +
            (platform === "macos" ? ` ${t("settings.hotkeys.ctrlVMac", { keys: pasteKeys })}` : "")
          }
        >
          {({ labelId, descId }) => (
            <Switch
              labelledBy={labelId}
              describedBy={descId}
              checked={settings.ctrlVPaste}
              onChange={(ctrlVPaste) => update({ ctrlVPaste })}
            />
          )}
        </Row>
      </section>
      {openFailed && <Notice tone="warning">{t("settings.support.openFailed")}</Notice>}

      {platform === "windows" && (
        <>
          <PrintScreenCard t={t} />
          <ConflictCard t={t} platform={platform} hotkey={settings.captureHotkey} advice={advice} printScreen={conflicts.printScreen} />
        </>
      )}
      {platform === "macos" && (
        <Notice tone="info">
          {t("settings.hotkeys.macSystem", {
            shot3: formatAccelerator("Cmd+Shift+3", platform),
            shot4: formatAccelerator("Cmd+Shift+4", platform),
            shot5: formatAccelerator("Cmd+Shift+5", platform),
            ours: formatAccelerator(defaults.capture, platform),
          })}
        </Notice>
      )}
    </>
  );
}

function HotkeyRow({
  label,
  description,
  link,
  value,
  fallback,
  suggestion,
  others,
  offerPrintScreen,
  canTurnOff,
  status,
  statusText: ownerText,
  fix,
  platform,
  t,
  save,
}: {
  label: string;
  description: string;
  /** Under the description, but not part of the recorder's accessible description. */
  link?: ReactNode;
  value: string;
  /** The default; empty when the key is off by default (saving the full screen on macOS). */
  fallback: string;
  /** What "Turn on" assigns while the key is off. */
  suggestion?: string;
  others: Other[];
  offerPrintScreen?: boolean;
  /** Offers a button that turns the hotkey off (saves an empty value). */
  canTurnOff?: boolean;
  status: RowStatus;
  /** Replaces the generic text, e.g. to name the program that holds the key. */
  statusText?: string | null;
  fix?: Fix;
  platform: Platform;
  t: TFunction;
  save: (accelerator: string) => Promise<boolean>;
}) {
  const [error, setError] = useState<string | null>(null);
  /** Which other key was turned off to make room for this one. */
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const descId = useId();

  /** Checks for a clash with the other hotkeys and the syntax, then saves. Returns true when saved. */
  const apply = async (accelerator: string): Promise<boolean> => {
    setNote(null);
    if (sameAccelerator(accelerator, value, platform)) {
      setError(null);
      return true;
    }
    const clashes = others.filter((o) => o.value && sameAccelerator(accelerator, o.value, platform));
    const blocking = clashes.find((o) => !o.yields);
    if (blocking) {
      setError(t("settings.hotkeys.conflict", { action: blocking.label }));
      return false;
    }
    setBusy(true);
    try {
      try {
        await api.validateHotkey(accelerator);
      } catch {
        setError(t("settings.hotkeys.invalid"));
        return false;
      }
      // The core turns the yielding keys off when it saves (Settings::sanitize).
      const ok = await save(accelerator);
      setError(ok ? null : t("settings.hotkeys.saveFailed"));
      if (ok && clashes.length > 0) {
        // At most one: the full screen keys never share a combination.
        setNote(t("settings.hotkeys.yielded", { hotkey: formatAccelerator(accelerator, platform), action: clashes[0].label }));
      }
      return ok;
    } finally {
      setBusy(false);
    }
  };

  /** An empty accelerator: the core registers nothing for it. */
  const turnOff = async () => {
    setNote(null);
    setBusy(true);
    try {
      const ok = await save("");
      setError(ok ? null : t("settings.hotkeys.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  // Not offered when another action holds the combination (e.g. capture moved to Ctrl+PrintScreen): the user
  // records another one instead.
  const offer = canTurnOff && !value ? fallback || suggestion || "" : "";
  const turnOn = offer && !others.some((o) => o.value && sameAccelerator(offer, o.value, platform)) ? offer : "";

  const statusText =
    ownerText ??
    (status === "ok"
      ? t("settings.hotkeys.statusOk")
      : status === "idle"
        ? t("settings.hotkeys.statusIdle")
        : status === "taken"
          ? t("settings.hotkeys.statusTaken")
          : status === "reserved"
            ? t("settings.hotkeys.statusReserved")
            : null);

  return (
    <Row
      label={label}
      description={
        <>
          <span id={descId}>{description}</span>
          {link && <div>{link}</div>}
        </>
      }
      stacked
    >
      {() => (
        <div className="hotkey-row">
          <div className="hotkey-controls">
            <HotkeyRecorder
              value={value}
              action={label}
              platform={platform}
              t={t}
              describedBy={descId}
              busy={busy}
              onRecord={apply}
              onInvalid={(reason) =>
                setError(
                  reason === "needsModifier"
                    ? t(platform === "macos" ? "settings.hotkeys.needsModifierMac" : "settings.hotkeys.needsModifierWin")
                    : reason === "reserved"
                      ? t("settings.hotkeys.reserved")
                      : t("settings.hotkeys.unsupportedKey"),
                )
              }
              onCancel={() => setError(null)}
            />
            {offerPrintScreen && !sameAccelerator(value, "PrintScreen", platform) && (
              <Button size="s" variant="ghost" icon="keyboard" disabled={busy} onClick={() => apply("PrintScreen")}>
                {t("settings.hotkeys.usePrintScreen")}
              </Button>
            )}
            {turnOn ? (
              <Button size="s" variant="ghost" icon="check" disabled={busy} onClick={() => apply(turnOn)}>
                {t("settings.hotkeys.turnOn", { hotkey: formatAccelerator(turnOn, platform) })}
              </Button>
            ) : (
              fallback &&
              value &&
              !sameAccelerator(value, fallback, platform) && (
                <Button
                  size="s"
                  variant="ghost"
                  icon="reset"
                  disabled={busy}
                  title={t("settings.hotkeys.resetHint", { hotkey: formatAccelerator(fallback, platform) })}
                  onClick={() => apply(fallback)}
                >
                  {t("settings.hotkeys.reset")}
                </Button>
              )
            )}
            {canTurnOff && value && (
              <Button size="s" variant="ghost" icon="x" disabled={busy} onClick={turnOff}>
                {t("settings.hotkeys.turnOff")}
              </Button>
            )}
          </div>
          {error ? (
            <p className="hotkey-status hotkey-status-error" role="alert">
              {error}
            </p>
          ) : note ? (
            <p className="hotkey-status hotkey-status-idle" aria-live="polite">
              <span className="status-dot" aria-hidden="true" />
              {note}
            </p>
          ) : (
            statusText && (
              <p className={`hotkey-status hotkey-status-${status}`} aria-live="polite">
                <span className="status-dot" aria-hidden="true" />
                {statusText}
              </p>
            )
          )}
          {fix && (
            <CaptureFix
              t={t}
              platform={platform}
              steps={fix.steps}
              alternative={fix.alternative}
              busy={busy}
              collapsed
              onRecheck={fix.onRecheck}
              onUseAlternative={(accelerator) => void apply(accelerator)}
            />
          )}
        </div>
      )}
    </Row>
  );
}
