import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {CodexClient} from './app-server.js';
import {clean, resolveCodex, resolveHome} from './files.js';
import {FIELD_CATALOG, FooterConfigError, FooterManager, PRESETS, TITLE_PRESET, samplePreview} from './statusline.js';

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function choiceRow(title, choices, selected = 0, subtitle = '') {
    return new Adw.ComboRow({title, subtitle,
        model: Gtk.StringList.new(choices), selected});
}

function pathRow(settings, key, title, subtitle) {
    const row = new Adw.EntryRow({title, text: settings.get_string(key),
        show_apply_button: true, tooltip_text: subtitle});
    row.connect('apply', () => settings.set_string(key, row.text.trim()));
    return row;
}

/** Native preferences construction is separate from the Shell loader for smoke tests. */
export function buildPreferences(window, settings, {clientFactory = options => new CodexClient(options)} = {}) {
    window.set_default_size(760, 760);
    const general = new Adw.PreferencesPage({title: 'Monitor', icon_name: 'view-statistics-symbolic'});
    const connection = new Adw.PreferencesGroup({title: 'Codex connection',
        description: 'Uses your installed Codex CLI and its selected configuration directory.'});
    const executable = pathRow(settings, 'codex-executable', 'Codex executable',
        'Leave empty for automatic discovery, or enter an absolute executable path.');
    const home = pathRow(settings, 'codex-home', 'Codex home',
        'Leave empty for CODEX_HOME or ~/.codex. Press the checkmark to save a path.');
    connection.add(executable);
    connection.add(home);
    const pathsHint = new Adw.ActionRow({title: 'Automatic discovery',
        subtitle: 'Empty paths use the discovered CLI and CODEX_HOME or ~/.codex. Confirm edits with the checkmark.'});
    connection.add(pathsHint);
    const refresh = new Adw.SpinRow({title: 'Quota refresh interval', subtitle: 'Seconds between quota checks',
        adjustment: new Gtk.Adjustment({lower: 30, upper: 3600, step_increment: 30,
            page_increment: 60, value: settings.get_int('refresh-interval')}), digits: 0});
    settings.bind('refresh-interval', refresh, 'value', Gio.SettingsBindFlags.DEFAULT);
    connection.add(refresh);
    general.add(connection);

    const panel = new Adw.PreferencesGroup({title: 'Top bar'});
    panel.add(switchRow(settings, 'show-panel-icon', 'Show monitor icon'));
    panel.add(switchRow(settings, 'show-panel-usage', 'Show quota used',
        'Percentages in the top bar show the quota already consumed.'));
    const positions = ['left', 'center', 'right'];
    const position = choiceRow('Position', ['Left', 'Center', 'Right'],
        Math.max(0, positions.indexOf(settings.get_string('panel-position'))));
    position.connect('notify::selected', () => settings.set_string('panel-position', positions[position.selected]));
    panel.add(position);
    general.add(panel);

    const alerts = new Adw.PreferencesGroup({title: 'Quota notifications',
        description: 'One notification per threshold in each reset window.'});
    alerts.add(switchRow(settings, 'notify-warning', '75% used', 'Early warning before quota runs low'));
    alerts.add(switchRow(settings, 'notify-critical', '90% used', 'Critical quota warning'));
    alerts.add(switchRow(settings, 'notify-exhausted', 'Quota exhausted', 'Notify when no quota remains'));
    general.add(alerts);
    window.add(general);

    const footerPage = new Adw.PreferencesPage({title: 'Codex footer', icon_name: 'utilities-terminal-symbolic'});
    const editor = new FooterEditor(window, settings, footerPage, [executable, home], clientFactory);
    window.add(footerPage);
    return editor;
}

class FooterEditor {
    constructor(window, settings, page, paths, clientFactory) {
        this._settings = settings;
        this._paths = paths;
        this._clientFactory = clientFactory;
        this._client = null;
        this._manager = null;
        this._closed = false;
        this._busy = false;
        this._generation = 0;
        this._fields = [...PRESETS.balanced];
        this._rows = [];
        this._managed = false;
        this._unsupported = false;
        this._loading = false;

        const status = new Adw.PreferencesGroup({title: 'Native terminal footer',
            description: 'Select what Codex displays below the prompt. Changes are written only when you choose Apply or Restore.'});
        this._status = new Adw.ActionRow({title: 'Connecting to Codex…',
            subtitle: 'No configuration has been changed.'});
        this._reload = new Gtk.Button({icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Reload Codex configuration', valign: Gtk.Align.CENTER});
        this._reload.connect('clicked', () => this._connect());
        this._status.add_suffix(this._reload);
        status.add(this._status);
        page.add(status);

        const layout = new Adw.PreferencesGroup({title: 'Layout'});
        this._preset = choiceRow('Preset', ['Custom', 'Focused', 'Balanced', 'Detailed'], 2,
            'Focused keeps quotas first; Balanced adds model and project context.');
        this._preset.connect('notify::selected', () => {
            if (this._loading || this._preset.selected === 0)
                return;
            this._fields = [...PRESETS[['', 'focused', 'balanced', 'detailed'][this._preset.selected]]];
            this._unsupported = false;
            this._renderFields();
            this._updateSensitivity();
        });
        layout.add(this._preset);
        this._colors = new Adw.SwitchRow({title: 'Use native footer colors', active: true,
            subtitle: 'Preserves your existing Codex theme.'});
        layout.add(this._colors);
        this._title = new Adw.SwitchRow({title: 'Apply terminal title preset',
            subtitle: 'Activity, project, branch and thread title. Off leaves the current title unchanged.'});
        layout.add(this._title);
        page.add(layout);

        const preview = new Adw.PreferencesGroup({title: 'Sample preview',
            description: 'Illustrative values. Codex controls the exact rendering and hides fields without data.'});
        this._width = choiceRow('Terminal width', ['40 columns · narrow', '80 columns · typical', '120 columns · wide'], 1);
        this._width.connect('notify::selected', () => this._preview());
        preview.add(this._width);
        const previewRow = new Adw.PreferencesRow();
        this._sample = new Gtk.Label({xalign: 0, wrap: true, selectable: true,
            margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16});
        this._sample.add_css_class('monospace');
        previewRow.set_child(this._sample);
        preview.add(previewRow);
        this._previewNote = new Adw.ActionRow({title: 'Sample values only'});
        preview.add(this._previewNote);
        page.add(preview);

        const actions = new Adw.PreferencesGroup();
        const actionRow = new Adw.ActionRow({title: 'Save to the selected Codex home',
            subtitle: 'Restore keeps settings changed outside this monitor.'});
        this._restore = new Gtk.Button({label: 'Restore', valign: Gtk.Align.CENTER, sensitive: false});
        this._restore.connect('clicked', () => this._change('restore'));
        this._apply = new Gtk.Button({label: 'Apply to Codex', valign: Gtk.Align.CENTER, sensitive: false});
        this._apply.add_css_class('suggested-action');
        this._apply.connect('clicked', () => this._change('apply'));
        actionRow.add_suffix(this._restore);
        actionRow.add_suffix(this._apply);
        actions.add(actionRow);
        page.add(actions);

        this._fieldGroup = new Adw.PreferencesGroup({title: 'Fields and order',
            description: 'Enable fields and move them with the arrow buttons. Catalogue: Codex 0.153.4, 29 native fields.'});
        page.add(this._fieldGroup);
        this._renderFields();

        const signals = ['codex-executable', 'codex-home'].map(key =>
            settings.connect(`changed::${key}`, () => this._connect()));
        window.connect('close-request', () => {
            this._closed = true;
            this._generation++;
            for (const id of signals)
                settings.disconnect(id);
            this._manager?.dispose();
            this._client?.stop().catch(() => {});
            this._manager = null;
            return false;
        });
        this._connect();
    }

    _renderFields() {
        for (const row of this._rows)
            this._fieldGroup.remove(row);
        this._rows = [];
        const selected = this._fields.filter(id => FIELD_CATALOG.some(field => field.id === id));
        const order = [...selected, ...FIELD_CATALOG.map(field => field.id).filter(id => !selected.includes(id))];
        for (const id of order) {
            const field = FIELD_CATALOG.find(item => item.id === id);
            const index = this._fields.indexOf(id);
            const row = new Adw.SwitchRow({title: field.label, subtitle: field.description, active: index !== -1});
            row.connect('notify::active', () => {
                this._fields = row.active ? [...this._fields, id] : this._fields.filter(item => item !== id);
                this._preset.selected = 0;
                this._renderFields();
            });
            for (const [delta, icon, verb] of [[-1, 'go-up-symbolic', 'Move up'], [1, 'go-down-symbolic', 'Move down']]) {
                const move = new Gtk.Button({icon_name: icon, valign: Gtk.Align.CENTER,
                    tooltip_text: `${verb}: ${field.label}`, sensitive: index !== -1 &&
                        index + delta >= 0 && index + delta < this._fields.length});
                move.add_css_class('flat');
                move.connect('clicked', () => {
                    [this._fields[index], this._fields[index + delta]] =
                        [this._fields[index + delta], this._fields[index]];
                    this._preset.selected = 0;
                    this._renderFields();
                });
                row.add_suffix(move);
            }
            this._rows.push(row);
            this._fieldGroup.add(row);
        }
        this._preview();
    }

    _preview() {
        const result = samplePreview(this._fields, [40, 80, 120][this._width.selected]);
        this._sample.label = result.text || 'Footer disabled';
        this._previewNote.title = result.omitted
            ? `${this._fields.length - result.omitted} fields fit · ${result.omitted} omitted in this sample`
            : `${this._fields.length} fields fit`;
        this._previewNote.subtitle = 'Sample quota percentages show remaining usage; context used shows consumed context.';
    }

    _updateSensitivity() {
        this._apply.sensitive = Boolean(this._manager) && !this._busy && !this._unsupported;
        this._restore.sensitive = Boolean(this._manager) && !this._busy && this._managed;
        this._reload.sensitive = !this._busy;
        for (const path of this._paths)
            path.sensitive = !this._busy;
        this._preset.sensitive = !this._busy;
        this._colors.sensitive = !this._busy;
        this._title.sensitive = !this._busy;
        this._fieldGroup.sensitive = !this._busy;
    }

    _setSnapshot(snapshot) {
        this._loading = true;
        this._fields = [...snapshot.fields];
        this._unsupported = this._fields.some(id => !FIELD_CATALOG.some(field => field.id === id));
        this._managed = snapshot.managed;
        this._colors.active = snapshot.colors;
        this._title.active = JSON.stringify(snapshot.title) === JSON.stringify(TITLE_PRESET);
        this._preset.selected = Math.max(0, ['', 'focused', 'balanced', 'detailed'].findIndex(name =>
            name && JSON.stringify(PRESETS[name]) === JSON.stringify(this._fields)));
        this._loading = false;
        this._renderFields();
    }

    async _connect() {
        const generation = ++this._generation;
        const oldClient = this._client;
        this._manager?.dispose();
        this._manager = null;
        this._client = null;
        this._busy = true;
        this._status.title = 'Connecting to Codex…';
        this._status.subtitle = 'Reading the selected user configuration.';
        this._updateSensitivity();
        try {
            await oldClient?.stop();
            if (this._closed || generation !== this._generation)
                return;
            const home = resolveHome(this._settings.get_string('codex-home'));
            const executable = await resolveCodex(this._settings.get_string('codex-executable'));
            if (this._closed || generation !== this._generation)
                return;
            const client = this._clientFactory({executable, home});
            this._client = client;
            await client.start();
            if (this._closed || generation !== this._generation) {
                await client.stop();
                return;
            }
            const manager = new FooterManager(client, {home});
            this._manager = manager;
            const snapshot = await manager.read();
            if (this._closed || generation !== this._generation) {
                manager.dispose();
                await client.stop();
                return;
            }
            this._setSnapshot(snapshot);
            this._status.title = this._unsupported ? 'Choose a preset before applying'
                : snapshot.configured ? 'Connected to Codex' : 'Footer not configured';
            this._status.subtitle = this._unsupported
                ? 'Your current footer includes fields outside this catalogue. Choose a preset to replace them.'
                : !snapshot.configured ? 'The preview is not active. Choose Apply to Codex to enable this footer.'
                    : `CLI ${clean(client.version ?? 'version unavailable')} · ${clean(home)}${snapshot.theme ? ` · Theme: ${clean(snapshot.theme)}` : ''}`;
        } catch (error) {
            if (!this._closed && generation === this._generation) {
                this._status.title = 'Could not read Codex configuration';
                this._status.subtitle = error instanceof FooterConfigError
                    ? clean(error.message, 400)
                    : 'Check the executable, Codex home and config.toml syntax, then reload. No configuration was changed.';
                this._manager?.dispose();
                this._manager = null;
                await this._client?.stop().catch(() => {});
                this._client = null;
            }
        } finally {
            if (!this._closed && generation === this._generation) {
                this._busy = false;
                this._updateSensitivity();
            }
        }
    }

    async _change(operation) {
        if (!this._manager || this._busy)
            return;
        const manager = this._manager;
        const generation = this._generation;
        this._busy = true;
        this._updateSensitivity();
        try {
            const result = operation === 'apply'
                ? await manager.apply({fields: this._fields, colors: this._colors.active,
                    title: this._title.active ? TITLE_PRESET : null})
                : await manager.restore();
            if (this._closed || generation !== this._generation)
                return;
            const snapshot = await manager.read();
            if (this._closed || generation !== this._generation)
                return;
            this._setSnapshot(snapshot);
            this._status.title = operation === 'apply' ? 'Footer applied' : 'Restore complete';
            this._status.subtitle = operation === 'apply'
                ? 'Saved to the selected Codex home. Existing terminal sessions may need to be reopened.'
                : `Restored ${result.restored.length} settings. Preserved ${result.skipped.length} settings changed outside this monitor.`;
        } catch (error) {
            if (!this._closed && generation === this._generation) {
                this._status.title = 'Configuration change needs attention';
                // FooterManager supplies fixed messages, never raw config or server errors.
                this._status.subtitle = error instanceof FooterConfigError
                    ? clean(error.message, 400)
                    : 'Could not confirm the change. Reload the selected Codex home before trying again.';
                this._managed = true;
            }
        } finally {
            if (!this._closed && generation === this._generation) {
                this._busy = false;
                this._updateSensitivity();
            }
        }
    }
}

export default class CodexUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        buildPreferences(window, this.getSettings());
    }
}
