# Validation evidence

Verified on 2026-09-08. The original native Codex checks used CLI 0.153.4,
GNOME Shell 46.0, and GJS 1.80.2 on Ubuntu 24.04. Additional desktop checks are below.

## GNOME compatibility

Offline assertions, package installation, headless desktop interaction, and preferences
checks passed on:

- GNOME 46.0 on Ubuntu 24.04.
- GNOME 48.8 on Fedora 42.
- GNOME 49.9 on Fedora 43.
- GNOME 50.4 on Fedora 44.

Each desktop run checks keyboard navigation, quota geometry at 1x and 2x scale,
light-theme foreground, notifications, and disable/re-enable cleanup. The quota checks
verify that 34% used appears as 34% and fills 34% of the track. Empty and exhausted quotas
produce empty and full bars. Preferences tests
verify the unconfigured-footer message and require Apply before any settings write.

The Fedora checks copy read-only source into a temporary container workspace. They use
synthetic Codex responses and private D-Bus sessions, with no network, host desktop
socket, or Codex credentials. Reproduce them with Docker:

```sh
make test-compat FEDORA=42
make test-compat FEDORA=43
make test-compat FEDORA=44
```

The image build downloads Fedora packages; the test container itself has no network.
These are headless software-rendering checks, not qualification of every GPU or display.

GNOME 47 remains unqualified and is omitted from the metadata. The Fedora 41/GNOME 47.10
compositor exits with SIGSEGV, including a control run with this extension disabled.
A normal user account produced the same failure. GNOME 51 and later remain untested.

The runtime uses the newer `orientation` property when available and the GNOME 46
`vertical` fallback otherwise. Preferences specify GTK 4 and Libadwaita 1; shared data
modules don't import either UI toolkit. Objects, signal handlers, timers, and the owned
Codex subprocess are cleaned up on disable. The package omits the numeric `version`
field so extensions.gnome.org can assign it, and retains `version-name` for source releases.

## Automated and native checks

- Offline assertions cover response normalization, missing/zero values, explicit currency
  amounts, private storage, history retention and alert transitions, subprocess framing,
  fragmented UTF-8, concurrent requests, timeouts, blocked pipes, child reaping, account
  changes, bounded session-detail requests, and configuration recovery/concurrency.
- Real Codex configuration tests use a temporary home. Apply/Restore, absent original
  keys, unrelated updates, comments, and stale-version rejection passed.
- Native Libadwaita preferences instantiate all 29 fields and exercise presets, toggles,
  narrow preview, Apply/Restore, and client cleanup. Theme tests compare labels with
  Libadwaita's own foreground values instead of imposing custom colors.
- The packaged extension was installed in a private headless GNOME session. Synthetic
  data populated all three tabs. Keyboard arrow navigation, completed-but-unavailable
  billing, and disable/re-enable passed.
- Measured quota fills were 34%, 62%, and 18% of their tracks. At 2x St scaling the
  track height doubled and the percentages remained proportional. The light preference
  retained the shell's foreground opacity. This is actor-scale verification, not a claim
  of qualification on every physical HiDPI monitor.
- The package contains its runtime modules, stylesheet, icon, attribution, and schema XML.
  The standard GNOME installer compiles the schema during installation.

Screenshots use synthetic demonstration data. The test creates its own desktop/session;
it does not install into or control the active user desktop.

## Authenticated read-only check

The installed CLI successfully returned a ChatGPT Pro account, main and additional quota
buckets, reset information, all account summary fields, daily activity, and ten recent
session records with model/reasoning metadata. The sampled session had no returned billing
details. The monitor displays that as unavailable rather than a zero cost or a loading state.

The probe created no turns and performed no configuration edits. The NVM command wrapper
and its native app-server descendant both exited; no owned process remained.

## Review and limits

Independent review found and the implementation fixed stale cross-account activity,
unbounded detail requests, preferences restarting after closure, overlapping restore
journals, and the completed-but-unavailable billing state. Focused regression tests cover
these cases; the final bounded re-review had no remaining concrete findings.

Other distributions and account/billing plans remain unqualified beyond the checks above.
The GNOME 46 test environment emits an upstream GJS warning when GI wraps a subprocess
pipe as the relocated `Gio.UnixOutputStream` type; transport and cleanup tests pass. Isolated
desktop startup also logs unavailable optional portal/session services. These are distinct
from extension JavaScript errors.

The richer custom CLI renderer remains an upstream feature request. This release uses
stock footer fields and does not modify the Codex binary.

## References

- [GNOME extension review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
- [GNOME extension best practices](https://gjs.guide/extensions/review-guidelines/best-practices.html)
- [GNOME 48 layout API changes](https://gjs.guide/extensions/upgrading/gnome-shell-48.html#st-widgets-orientation)
- [GNOME 50 porting guide](https://gjs.guide/extensions/upgrading/gnome-shell-50.html)
- [Codex app-server protocol](https://developers.openai.com/codex/app-server/)
- [Footer fields at 0.153.4](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/bottom_pane/status_line_setup.rs)
- [Native theme styling](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/bottom_pane/status_line_style.rs)
- [Versioned configuration edits](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/config_manager_service.rs)
- [Custom rendering request](https://github.com/openai/codex/issues/17827)
