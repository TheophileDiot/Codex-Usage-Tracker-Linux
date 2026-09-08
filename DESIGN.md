# Interface direction

An original compact GNOME monitor with system typography and native popup surfaces.
Use a restrained teal accent; amber and red indicate pressure. Text inherits the active
theme foreground rather than relying on colored percentages to communicate meaning.

The panel uses the monochrome ChatGPT/OpenAI Blossom mark and concise main-bucket used percentages.
The popup is approximately 400 logical pixels wide and constrains its scrollable content
to the monitor height. Its fixed header identifies Codex/account and provides Refresh and
Preferences. Keyboard-accessible Overview, Activity, and Sessions tabs separate distinct
questions instead of presenting one long dashboard.

Overview emphasizes large used percentages, slim usage meters that fill as consumption rises, bucket labels,
and explicit reset times. Secondary credit details stay compact. Activity labels the
source, scale, and gaps of its charts. Session rows use saved titles/project/model/effort
and last-update times, with optional usage details disclosed on selection.

All variable text uses plain labels with control and bidi characters removed. Rows wrap
or ellipsize instead of forcing horizontal overflow. Focus survives session detail
updates. Tab arrows, Home, and End move between tabs. Native controls retain visible
focus. Actor geometry follows actual allocation or GNOME scale factors; CSS pixels and
Clutter actor coordinates must not be mixed.

Preferences uses native Libadwaita controls. The footer editor has presets, ordered
switch rows, up/down controls, sample-width preview, Apply/Restore, and clear conflict
feedback. Changing the preview never changes the live Codex configuration. Native theme
colors are optional, and the user's syntax theme is preserved.
