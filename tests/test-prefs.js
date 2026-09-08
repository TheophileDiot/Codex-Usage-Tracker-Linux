import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const scratch = GLib.dir_make_tmp('codex-preferences-test-XXXXXX');
GLib.setenv('XDG_STATE_HOME', scratch, true);
Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const {buildPreferences} = await import('../prefs.js');
const {PRESETS} = await import('../statusline.js');
Adw.init();
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const source = Gio.SettingsSchemaSource.new_from_directory(root.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.codex-usage-monitor', true)});
settings.set_string('codex-executable', '/usr/bin/true');
settings.set_string('codex-home', scratch);
let config = {}, writes = 0, stopped = 0, version = 1;
const window = new Adw.PreferencesWindow();
const editor = buildPreferences(window, settings, {clientFactory: ({home}) => ({
    version: '0.153.4', start: async () => {}, stop: async () => { stopped++; },
    request: async (method, params) => {
        if (method === 'config/read') return {config, layers: [{name: {type: 'user', file: `${home}/config.toml`}, version: `${version}`, config, disabledReason: null}]};
        writes++;
        config.tui ??= {};
        for (const edit of params.edits) {
            const key = edit.keyPath.slice(4);
            if (edit.value === null) delete config.tui[key];
            else config.tui[key] = edit.value;
        }
        return {version: `${++version}`};
    },
})});
function assert(value, message) { if (!value) throw new Error(message); }
const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {resolve(); return GLib.SOURCE_REMOVE;}));
function remove(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const list = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let item; while ((item = list.next_file(null))) remove(file.get_child(item.get_name()));
        list.close(null);
    }
    file.delete(null);
}
try {
    window.present();
    const deadline = Date.now() + 3000;
    while (editor._busy) {assert(Date.now() < deadline, 'UI connection timeout'); await wait(10);}
    assert(editor._manager, editor._status.subtitle);
    assert(writes === 0 && editor._rows.length === 29, 'construct 29 fields without changing configuration');
    assert(editor._status.title === 'Footer not configured', 'A sample preview must not imply the footer is installed');
    editor._preset.selected = 3;
    assert(JSON.stringify(editor._fields) === JSON.stringify(PRESETS.detailed), 'Detailed preset');
    editor._rows[0].active = false;
    assert(!editor._fields.includes('five-hour-limit'), 'field toggle');
    editor._width.selected = 0;
    assert(editor._sample.label.length <= 40, 'narrow sample preview');
    await editor._change('apply');
    assert(writes === 1 && editor._restore.sensitive, 'Apply enables restoration');
    await editor._change('restore');
    assert(writes === 2 && !editor._restore.sensitive, 'Restore releases managed settings');
    window.set_visible_page(editor._sample.get_ancestor(Adw.PreferencesPage.$gtype));
    await wait(250);
    const style = Adw.StyleManager.get_default();
    style.color_scheme = Adw.ColorScheme.FORCE_LIGHT;
    await wait(150);
    const light = editor._sample.get_color();
    const lightBase = window.get_color().to_string();
    style.color_scheme = Adw.ColorScheme.FORCE_DARK;
    await wait(150);
    const dark = editor._sample.get_color();
    const darkBase = window.get_color().to_string();
    assert(light.red < dark.red && light.to_string() === lightBase && dark.to_string() === darkBase, 'native light/dark foreground adapts');
    window.close();
    assert(stopped === 1, 'preferences client stops on close');
    print('native preferences checks passed (29 fields, presets, Apply/Restore, light/dark, close)');
} finally {
    if (!editor._closed) window.close();
    remove(Gio.File.new_for_path(scratch));
}
