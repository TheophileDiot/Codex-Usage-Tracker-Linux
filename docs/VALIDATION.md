# Validation evidence

Verified on 2026-09-08 with Codex CLI 0.153.4, GNOME Shell 46, and GJS 1.80.2.

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
- Measured quota fills were 66%, 38%, and 82% of their tracks. At 2x St scaling the
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

GNOME 47 and later, other distributions, and other account/billing plans remain unqualified.
The GNOME 46 test environment emits an upstream GJS warning when GI wraps a subprocess
pipe as the relocated `Gio.UnixOutputStream` type; transport and cleanup tests pass. Isolated
desktop startup also logs unavailable optional portal/session services. These are distinct
from extension JavaScript errors.

The richer custom CLI renderer remains an upstream feature request. This release uses
stock footer fields and does not modify the Codex binary.

## References

- [Codex app-server protocol](https://developers.openai.com/codex/app-server/)
- [Footer fields at 0.153.4](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/bottom_pane/status_line_setup.rs)
- [Native theme styling](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/bottom_pane/status_line_style.rs)
- [Versioned configuration edits](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/config_manager_service.rs)
- [Custom rendering request](https://github.com/openai/codex/issues/17827)
