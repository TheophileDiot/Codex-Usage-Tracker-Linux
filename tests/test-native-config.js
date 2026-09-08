// Real Codex API, isolated home: never writes the user's configuration.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {CodexClient} from '../app-server.js';
import {resolveCodex} from '../files.js';
import {FooterManager, PRESETS, TITLE_PRESET} from '../statusline.js';

function assert(ok, message) { if (!ok) throw new Error(message); }
function remove(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const list = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let entry; while ((entry = list.next_file(null))) remove(file.get_child(entry.get_name()));
        list.close(null);
    }
    file.delete(null);
}
function read(path) { return new TextDecoder().decode(GLib.file_get_contents(path)[1]); }
const home = GLib.dir_make_tmp('codex-native-config-XXXXXX');
const client = new CodexClient({executable: await resolveCodex(), home});
try {
    await client.start();
    assert(client.version === '0.153.4' || /^\d+\.\d+\.\d+/.test(client.version), 'actual CLI version identified');
    const manager = new FooterManager(client, {home, stateFile: `${home}/monitor-restore.json`});
    await manager.read(); // Even an absent config has a versioned user layer.
    await manager.apply({fields: PRESETS.balanced, colors: true, title: TITLE_PRESET});
    let response = await client.request('config/read', {includeLayers: true});
    assert(JSON.stringify(response.config.tui.status_line) === JSON.stringify(PRESETS.balanced), 'native API applied the exact preset');
    const staleVersion = response.layers.find(x => x.name.type === 'user').version;
    await client.request('config/batchWrite', {edits: [{keyPath:'tui.show_tooltips',value:false,mergeStrategy:'replace'}]});
    let rejected = false;
    try { await client.request('config/batchWrite', {expectedVersion:staleVersion,edits:[{keyPath:'tui.status_line',value:['model'],mergeStrategy:'replace'}]}); } catch { rejected = true; }
    assert(rejected, 'native service rejects a stale config version');
    const restore = await manager.restore();
    assert(restore.restored.length === 3, 'native restore removes previously absent managed keys');
    response = await client.request('config/read', {includeLayers:true});
    assert(response.config.tui.show_tooltips === false, 'unrelated concurrent preference retained');
    assert(!read(`${home}/config.toml`).includes('status_line'), 'keys removed from physical TOML');
    // A user's comments and original fields survive a new install/restore cycle.
    GLib.file_set_contents(`${home}/config.toml`, '# preserved user comment\n[tui]\nstatus_line = ["git-branch"]\nshow_tooltips = false\n');
    await manager.apply({fields:PRESETS.detailed,colors:true});
    await manager.restore();
    const text = read(`${home}/config.toml`);
    assert(text.includes('# preserved user comment') && text.includes('"git-branch"') && text.includes('show_tooltips = false'), 'native editor preserves user comments and original values');
    print(`native configuration checks passed (Codex ${client.version})`);
} finally {
    await client.stop();
    remove(Gio.File.new_for_path(home));
}
