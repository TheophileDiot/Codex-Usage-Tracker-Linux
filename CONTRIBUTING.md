# Contributing

Thanks for helping improve Codex Usage Monitor. Small fixes, clear bug reports, and
documentation improvements are welcome.

## Reporting a bug

Include your Linux distribution, GNOME Shell and Codex CLI versions, and whether you
use Wayland or X11. Name the extension version or commit you tested, then give the steps
to reproduce the problem, what you expected, and what happened.

If the problem concerns quotas or billing, distinguish a missing value from a zero.
The data available depends on your account and the Codex backend. Supported GNOME
versions are 46 and 48–50; see the [compatibility evidence](docs/VALIDATION.md#gnome-compatibility)
before adding another version to the metadata.

Share only the log lines needed to show the problem. Remove credentials, account
identifiers, private paths, session titles, and prompt content from logs and screenshots.
Use [SECURITY.md](SECURITY.md) for vulnerabilities.

## Proposing a change

For a larger feature, open an issue describing the use case before writing it. Keep pull
requests focused so I can review the behavior and its checks together. Include a before
and after screenshot with synthetic data when changing the UI.

Read [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md) before changing behavior or
presentation. Match the surrounding JavaScript and reuse the existing GJS helpers.
Preserve unavailable values, account separation, and explicit Apply/Restore actions for
Codex configuration writes.

## Checking your work

Run the offline assertions and schema validation from the repository root:

```sh
make test
```

For a behavior change, add a focused regression assertion under `tests/`. Use
`make test-native` for native configuration changes, `make test-prefs` for preferences,
and `make test-shell` for the panel or popup. The native check uses a temporary Codex
home; the desktop checks use isolated test sessions. See
[docs/VALIDATION.md](docs/VALIDATION.md) for their scope and requirements.

State which checks you ran and which you couldn't run. Leave generated files under
`dist/`, `.work/`, and `schemas/gschemas.compiled` out of the pull request. Keep the
existing license and attribution notices when adapting code.
