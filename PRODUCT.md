# Product

Codex Usage Monitor is an independent GNOME desktop companion for a local Codex CLI user.
It shows quota pressure, resets, account activity, and recent session records, and configures
Codex's native footer. Its interface and identity are original; selected tested GNOME and
history foundations come from the author's Claude tracker under MIT.

## Platform and integration

- GNOME Shell 46 is the supported initial desktop. Later versions require a runtime smoke
  test before being advertised in metadata.
- Codex CLI 0.153.4 or newer, GJS ES modules, Libadwaita preferences, and native GNOME APIs.
- A private stdio connection to the user's installed Codex app-server supplies data.
  The monitor creates no conversations, runs no inference, and never requests exported
  credentials. Codex owns authentication and normal refresh of its managed tokens.
- One selected Codex home at a time; discover the executable from PATH or conventional
  installations, including NVM, with explicit executable/home settings available.

## Information and truth boundaries

- The panel shows remaining 5-hour and weekly quotas only from the main `codex` bucket,
  matching the native CLI. Missing main windows are omitted. The popup names all additional
  buckets and uses actual window durations.
- Overview shows percentages, reset countdowns and local clock times, spending controls,
  supplied credit balances, and available reset-credit counts. All are informational.
- Activity separates locally sampled percentage history from server-provided daily token
  activity and account summaries. Gaps remain gaps. A drop may represent a quota reset.
- Sessions lists the ten newest recorded sessions in the selected Codex home, which can
  include records from previous logins. Recorded model/reasoning and last-update timestamps
  are snapshots, not live state from other Codex processes. Prompt previews and turns are
  discarded. Per-thread usage appears only when the server provides it.
- Credit balances retain their source units. Dollar estimates require explicit USD data;
  subscription percentages are never converted into estimated money or token allowances.
- Missing values are unavailable rather than zero. Malformed responses do not replace
  successful snapshots. Each section has its own freshness/error state.

## Storage and refresh

Quota reads default to once per minute with overlapping refreshes coalesced and errors
backed off. Account activity is cached for 15 minutes; manual refresh bypasses that cache.
Sessions refresh when their view opens. Detail requests allow one active request and one
latest queued selection. Account epochs prevent old responses from crossing a login change.

Seven days of five-minute percentage samples and notification baselines are stored below
the selected home's hash in the XDG state directory. Account histories have separate keys.
Quota/account/activity/session snapshots otherwise remain in memory; after re-enable the
monitor obtains fresh account data before associating saved history. Files are private.

Alerts at 75, 90, and 100 percent used are individually configurable and are emitted once
per crossing and reset window. The initial baseline is silent. Disabling the extension
cancels its requests, timers, streams, and owned process.

## Native CLI settings

Preferences exposes the 29 native fields verified in Codex 0.153.4, ordered selection,
Focused/Balanced/Detailed presets, native theme colors, and an optional terminal title.
Sample previews explain truncation; the actual TUI owns rendering and data availability.

Apply and Restore use versioned Codex config edits. They preserve unrelated keys and
original managed values, journal interrupted changes, and retain subsequent user edits.
Only explicit buttons mutate configuration. Closing preferences prevents new operations.
Disabling the GNOME extension leaves the configured native footer usable independently.
