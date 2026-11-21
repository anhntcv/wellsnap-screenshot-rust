//! Global hotkeys: capture (always), the two full screen keys (always, unless turned off) and smart paste (only
//! while there is something to paste: a snapshot set or a recent single copy with separate text), to keep the
//! combination free for other apps otherwise.
//!
//! Every change runs on the main thread. The plugin's unregister_all holds its shortcut map lock while it waits
//! for the main thread, and a hotkey press on the main thread takes the same lock, so calling it from a worker
//! can deadlock. Running there also keeps concurrent `apply` calls from interleaving.

use crate::state::{AppState, HotkeyStatus};
use std::str::FromStr;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Status error for a chord WellSnap refuses to take (the frontend matches this text).
pub const RESERVED: &str = "reserved";

/// Re-registers the hotkeys from the current settings. Skipped while Settings records a combination: the
/// recorder resumes afterwards, and `resume` applies whatever changed meanwhile.
pub fn apply(app: &AppHandle) {
    on_main_thread(app, |app| {
        if !app.state::<AppState>().hotkeys_suspended.load(Ordering::SeqCst) {
            apply_now(app);
        }
    });
}

/// While the user records a new combination in Settings, nothing must be registered, otherwise the OS
/// delivers the press to us instead of to the recorder.
pub fn suspend(app: &AppHandle) {
    on_main_thread(app, |app| {
        let state = app.state::<AppState>();
        state.hotkeys_suspended.store(true, Ordering::SeqCst);
        if let Err(err) = app.global_shortcut().unregister_all() {
            log::warn!("unregister_all failed: {err}");
        }
        crate::ctrl_v::sync(app, false);
        publish(app, HotkeyStatus::default());
    });
}

pub fn resume(app: &AppHandle) {
    on_main_thread(app, |app| {
        app.state::<AppState>().hotkeys_suspended.store(false, Ordering::SeqCst);
        apply_now(app);
    });
}

/// The hotkey status once every change queued so far has run, e.g. right after `apply` from a worker thread.
pub fn settled_status(app: &AppHandle) -> HotkeyStatus {
    let (tx, rx) = mpsc::channel();
    let queued = app.run_on_main_thread({
        let app = app.clone();
        move || {
            let _ = tx.send(app.state::<AppState>().hotkeys.lock().unwrap().clone());
        }
    });
    let settled = queued.ok().and_then(|_| rx.recv_timeout(Duration::from_secs(2)).ok());
    settled.unwrap_or_else(|| app.state::<AppState>().hotkeys.lock().unwrap().clone())
}

fn on_main_thread(app: &AppHandle, f: impl FnOnce(&AppHandle) + Send + 'static) {
    let handle = app.clone();
    // Runs inline when already on the main thread.
    if let Err(err) = app.run_on_main_thread(move || f(&handle)) {
        log::warn!("hotkey change could not be dispatched: {err}");
    }
}

fn apply_now(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let has_content = state.has_smart_paste_content();
    let shortcuts = app.global_shortcut();
    if let Err(err) = shortcuts.unregister_all() {
        log::warn!("unregister_all failed: {err}");
    }

    let mut status = HotkeyStatus::default();
    if is_reserved(&settings.capture_hotkey) {
        log::warn!("capture hotkey {} is a clipboard shortcut, not registered", settings.capture_hotkey);
        status.capture_error = Some(RESERVED.to_string());
    } else {
        match shortcuts.on_shortcut(settings.capture_hotkey.as_str(), |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                crate::overlay::begin_capture(app);
            }
        }) {
            Ok(()) => status.capture_registered = true,
            Err(err) => {
                // Another program holds the key: a fact about the machine, counted, not reported as a bug.
                log::warn!("capture hotkey {} not registered: {err}", settings.capture_hotkey);
                // Once per failure, not on every re-apply (settings saved, recheck) that finds it still taken.
                if state.hotkeys.lock().unwrap().capture_error.is_none() {
                    crate::telemetry::count("hotkey_failures");
                }
                status.capture_error = Some(err.to_string());
            }
        }
    }

    if has_content && settings.smart_paste_hotkey != settings.capture_hotkey {
        if is_reserved(&settings.smart_paste_hotkey) {
            log::warn!("smart paste hotkey {} is a clipboard shortcut, not registered", settings.smart_paste_hotkey);
            status.smart_paste_error = Some(RESERVED.to_string());
        } else {
            match shortcuts.on_shortcut(settings.smart_paste_hotkey.as_str(), |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    crate::actions::smart_paste(app);
                }
            }) {
                Ok(()) => status.smart_paste_registered = true,
                Err(err) => {
                    log::warn!("smart paste hotkey {} not registered: {err}", settings.smart_paste_hotkey);
                    status.smart_paste_error = Some(err.to_string());
                }
            }
        }
    }
    // Watched under the same condition as the smart paste hotkey; it also takes a press only while the
    // clipboard still holds WellSnap's copy.
    crate::ctrl_v::sync(app, has_content && settings.ctrl_v_paste);

    // Always registered, like capture, unless turned off (empty).
    let mut ours = vec![settings.capture_hotkey.as_str()];
    if status.smart_paste_registered {
        ours.push(settings.smart_paste_hotkey.as_str());
    }
    (status.full_screen_registered, status.full_screen_error) =
        register_optional(app, "full screen", &settings.full_screen_hotkey, &ours, crate::overlay::begin_full_screen);
    ours.push(settings.full_screen_hotkey.as_str());
    (status.full_screen_save_registered, status.full_screen_save_error) = register_optional(
        app,
        "full screen save",
        &settings.full_screen_save_hotkey,
        &ours,
        crate::overlay::save_full_screen,
    );

    status.capture_error_kind = status.capture_error.as_deref().map(crate::conflicts::classify);
    status.smart_paste_error_kind = status.smart_paste_error.as_deref().map(crate::conflicts::classify);
    status.full_screen_error_kind = status.full_screen_error.as_deref().map(crate::conflicts::classify);
    status.full_screen_save_error_kind = status.full_screen_save_error.as_deref().map(crate::conflicts::classify);
    publish(app, status);
}

/// Registers a hotkey that may be turned off (empty accelerator). Returns whether it is registered and why not.
/// A key another WellSnap action already holds is skipped: Settings refuses such a pair anyway.
fn register_optional(
    app: &AppHandle,
    what: &str,
    accelerator: &str,
    ours: &[&str],
    action: fn(&AppHandle),
) -> (bool, Option<String>) {
    if accelerator.trim().is_empty() {
        return (false, None);
    }
    if is_reserved(accelerator) {
        log::warn!("{what} hotkey {accelerator} is a clipboard shortcut, not registered");
        return (false, Some(RESERVED.to_string()));
    }
    if ours.iter().any(|other| same_chord(accelerator, other)) {
        log::warn!("{what} hotkey {accelerator} is used by another WellSnap action, not registered");
        return (false, None);
    }
    let registered = app.global_shortcut().on_shortcut(accelerator, move |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            action(app);
        }
    });
    match registered {
        Ok(()) => (true, None),
        Err(err) => {
            log::warn!("{what} hotkey {accelerator} not registered: {err}");
            (false, Some(err.to_string()))
        }
    }
}

/// The same key and modifiers, however written ("cmd+shift+1" and "Shift+Super+1").
pub fn same_chord(a: &str, b: &str) -> bool {
    match (Shortcut::from_str(a), Shortcut::from_str(b)) {
        (Ok(a), Ok(b)) => a.mods == b.mods && a.key == b.key,
        _ => false,
    }
}

fn publish(app: &AppHandle, status: HotkeyStatus) {
    let previous = std::mem::replace(&mut *app.state::<AppState>().hotkeys.lock().unwrap(), status.clone());
    let _ = app.emit("hotkeys:status", &status);
    // The tray shows whether capture works. Suspending publishes a status without an error, so the tray does not
    // call the key broken while Settings records a new one. After the lock is released: menu calls must not run
    // under an AppState lock (tray.rs).
    if crate::tray::capture_off(&previous) != crate::tray::capture_off(&status) {
        crate::tray::refresh(app);
    }
}

/// The platform's clipboard and undo chords (Ctrl or Cmd with V, C, X, A, Z, Y). As a global hotkey they would
/// hijack copy and paste in every app, and smart paste's own synthetic paste would trigger the hotkey again.
fn is_reserved(accelerator: &str) -> bool {
    let primary = if cfg!(target_os = "macos") { Modifiers::SUPER } else { Modifiers::CONTROL };
    Shortcut::from_str(accelerator).is_ok_and(|s| {
        s.mods == primary
            && matches!(s.key, Code::KeyV | Code::KeyC | Code::KeyX | Code::KeyA | Code::KeyZ | Code::KeyY)
    })
}

/// Checks the syntax only; whether the OS accepts it is known after `apply`.
pub fn validate(accelerator: &str) -> Result<(), String> {
    Shortcut::from_str(accelerator).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_reserved, same_chord, validate};

    #[test]
    fn same_chord_ignores_spelling() {
        assert!(same_chord("cmd+shift+1", "Super+Shift+1"));
        assert!(same_chord("Ctrl+PrintScreen", "ctrl+printscreen"));
        assert!(!same_chord("Ctrl+PrintScreen", "Shift+PrintScreen"));
        assert!(!same_chord("", "Ctrl+PrintScreen"), "a turned off key clashes with nothing");
        assert!(!same_chord("garbage+", "garbage+"));
    }

    #[test]
    fn accepts_default_accelerators() {
        for accel in ["PrintScreen", "Ctrl+PrintScreen", "Super+Alt+V", "Cmd+Shift+2", "Ctrl+Cmd+V", "Alt+Shift+S"] {
            assert!(validate(accel).is_ok(), "{accel} should parse");
        }
    }

    #[test]
    fn rejects_garbage() {
        assert!(validate("Ctrl+").is_err());
        assert!(validate("NotAKey").is_err());
    }

    #[test]
    fn clipboard_chords_are_reserved() {
        let primary = if cfg!(target_os = "macos") { "Cmd" } else { "Ctrl" };
        for key in ["V", "C", "X", "A", "Z", "Y"] {
            assert!(is_reserved(&format!("{primary}+{key}")), "{primary}+{key}");
            assert!(is_reserved(&format!("{}+{key}", primary.to_lowercase())));
        }
        // Other modifiers on top make it a different chord.
        assert!(!is_reserved(&format!("{primary}+Shift+V")));
        assert!(!is_reserved(&format!("{primary}+Alt+V")));
        assert!(!is_reserved("Super+Alt+V"));
        assert!(!is_reserved("Ctrl+Cmd+V"));
        assert!(!is_reserved("PrintScreen"));
        assert!(!is_reserved(&format!("{primary}+B")));
        assert!(!is_reserved("garbage+"));
    }
}
