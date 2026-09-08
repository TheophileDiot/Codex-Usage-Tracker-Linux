import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
export {clean} from './usage.js';

function matches(error, code) { return error.matches?.(Gio.io_error_quark(), code); }

export function resolveHome(value = '') {
    const home = value || GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
    if (!GLib.path_is_absolute(home)) throw new Error('Choose an absolute Codex home directory.');
    return GLib.canonicalize_filename(home, null);
}

export function statePath(filename, home = '') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) throw new Error('Invalid state filename.');
    const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, resolveHome(home), -1).slice(0, 24);
    return GLib.build_filenamev([GLib.get_user_state_dir(), 'codex-usage-monitor', key, filename]);
}

export async function loadJson(path, cancellable = null) {
    try {
        const bytes = await new Promise((resolve, reject) => Gio.File.new_for_path(path).load_contents_async(cancellable, (file, result) => {
            try { resolve(file.load_contents_finish(result)[1]); } catch (error) { reject(error); }
        }));
        if (bytes.length > 4 * 1024 * 1024) throw new Error('Saved monitor data exceeds its size limit.');
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        if (matches(error, Gio.IOErrorEnum.NOT_FOUND)) return null;
        throw error;
    }
}

async function makePrivateDirectory(file, cancellable) {
    try {
        await new Promise((resolve, reject) => file.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable, (dir, result) => {
            try { dir.make_directory_finish(result); resolve(); } catch (error) { reject(error); }
        }));
        const info = new Gio.FileInfo();
        info.set_attribute_uint32('unix::mode', 0o700);
        await new Promise((resolve, reject) => file.set_attributes_async(info, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (dir, result) => {
            try { dir.set_attributes_finish(result); resolve(); } catch (error) { reject(error); }
        }));
    } catch (error) {
        if (matches(error, Gio.IOErrorEnum.EXISTS)) return;
        if (!matches(error, Gio.IOErrorEnum.NOT_FOUND) || !file.get_parent()) throw error;
        await makePrivateDirectory(file.get_parent(), cancellable);
        await makePrivateDirectory(file, cancellable);
    }
}

const writes = new Map();
export function writeJson(path, value, cancellable = null) {
    const bytes = new GLib.Bytes(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
    const previous = writes.get(path) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
        const file = Gio.File.new_for_path(path);
        await makePrivateDirectory(file.get_parent(), cancellable);
        await new Promise((resolve, reject) => file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable, (target, result) => {
                try { target.replace_contents_finish(result); resolve(); } catch (error) { reject(error); }
            }));
    });
    writes.set(path, task);
    task.then(() => { if (writes.get(path) === task) writes.delete(path); }, () => { if (writes.get(path) === task) writes.delete(path); });
    return task;
}

async function isExecutable(path) {
    try {
        const info = await new Promise((resolve, reject) => Gio.File.new_for_path(path).query_info_async(
            'standard::type,access::can-execute', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (file, result) => {
                try { resolve(file.query_info_finish(result)); } catch (error) { reject(error); }
            }));
        return info.get_file_type() === Gio.FileType.REGULAR && info.get_attribute_boolean('access::can-execute');
    } catch { return false; }
}

export async function resolveCodex(configured = '') {
    if (configured) {
        if (!GLib.path_is_absolute(configured) || !await isExecutable(configured))
            throw new Error('Choose an executable Codex CLI file using an absolute path.');
        return configured;
    }
    const candidates = [GLib.find_program_in_path('codex'),
        ...['.local/bin/codex', '.npm-global/bin/codex'].map(path => GLib.build_filenamev([GLib.get_home_dir(), path])),
        '/usr/local/bin/codex', '/usr/bin/codex'];
    for (const candidate of candidates) if (candidate && await isExecutable(candidate)) return candidate;
    const nvm = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_home_dir(), '.nvm', 'versions', 'node']));
    try {
        const enumerator = await new Promise((resolve, reject) => nvm.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null, (file, result) => { try { resolve(file.enumerate_children_finish(result)); } catch (error) { reject(error); } }));
        let infos;
        try {
            infos = await new Promise((resolve, reject) => enumerator.next_files_async(200, GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try { resolve(source.next_files_finish(result)); } catch (error) { reject(error); }
            }));
        } finally {
            await new Promise(resolve => enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try { source.close_finish(result); } catch {} resolve();
            }));
        }
        const versions = infos.map(info => info.get_name()).filter(name => /^v\d+\.\d+\.\d+$/.test(name))
            .sort((a, b) => {
                const x = a.slice(1).split('.').map(Number), y = b.slice(1).split('.').map(Number);
                return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
            });
        for (const version of versions) {
            const path = GLib.build_filenamev([nvm.get_path(), version, 'bin', 'codex']);
            if (await isExecutable(path)) return path;
        }
    } catch { /* A machine without NVM simply has no additional candidates. */ }
    throw new Error('Codex CLI was not found. Install Codex or select its executable in Preferences.');
}
