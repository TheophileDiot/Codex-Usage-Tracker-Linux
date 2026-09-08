import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {FIELD_CATALOG, PRESETS, TITLE_PRESET, FooterManager, samplePreview} from '../statusline.js';
import {loadJson} from '../files.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}
function equal(a, b, message) {
    assert(JSON.stringify(a) === JSON.stringify(b), message);
}
async function rejects(fn, fragment) {
    try {
        await fn();
    } catch (error) {
        assert(error.message.includes(fragment), `Expected ${fragment}, got ${error.message}`);
        return;
    }
    throw new Error(`Expected rejection: ${fragment}`);
}
const copy = value => JSON.parse(JSON.stringify(value));
function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return {promise, release};
}
const directory = GLib.dir_make_tmp('codex-footer-tests-XXXXXX');
let sequence = 0;
class Server {
    constructor(config = {}) {
        this.config = copy(config);
        this.version = 1;
        this.calls = [];
        this.conflict = false;
        this.invalid = false;
        this.missing = false;
    }
    async request(method, params) {
        this.calls.push({method, params: copy(params)});
        if (method === 'config/read') {
            assert(params.includeLayers === true, 'Reads must include original user layer');
            if (this.invalid)
                throw new Error('a secret-bearing parse error must never be displayed');
            return {config: copy(this.config), origins: {}, layers: this.missing ? [] : [{
                name: {type: 'user', file: '/tmp/test-codex-home/config.toml'},
                version: `${this.version}`, config: copy(this.config), disabledReason: null,
            }]};
        }
        assert(method === 'config/batchWrite', 'No unexpected config operation');
        assert(params.filePath === '/tmp/test-codex-home/config.toml', 'Only user file can be written');
        if (this.conflict) {
            this.conflict = false;
            this.version++;
        }
        if (params.expectedVersion !== `${this.version}`)
            throw new Error('version conflict');
        const next = copy(this.config);
        for (const edit of params.edits) {
            assert(edit.mergeStrategy === 'replace', 'Atomic replacement edits');
            assert(edit.keyPath.startsWith('tui.'), 'Only managed TUI keys');
            next.tui ??= {};
            const key = edit.keyPath.slice(4);
            if (edit.value === null)
                delete next.tui[key];
            else
                next.tui[key] = copy(edit.value);
        }
        this.config = next;
        return {status: 'ok', version: `${++this.version}`, filePath: params.filePath};
    }
    writes() {
        return this.calls.filter(call => call.method === 'config/batchWrite');
    }
}
function manager(server, options = {}) {
    return new FooterManager(server, {
        home: '/tmp/test-codex-home',
        stateFile: `${directory}/state-${++sequence}.json`,
        ...options,
    });
}
const selection = {fields: PRESETS.balanced, colors: true, title: TITLE_PRESET};

try {
    assert(FIELD_CATALOG.length === 29, 'Exact upstream field count');
    assert(new Set(FIELD_CATALOG.map(field => field.id)).size === 29, 'Unique field IDs');
    equal(PRESETS.focused, ['five-hour-limit', 'weekly-limit', 'context-used'], 'Focused order');
    equal(PRESETS.detailed, [...PRESETS.balanced, 'context-window-size', 'used-tokens',
        'total-input-tokens', 'total-output-tokens', 'task-progress', 'fast-mode'], 'Detailed order');
    equal(TITLE_PRESET, ['activity', 'project-name', 'git-branch', 'thread-title'], 'Title preset');
    for (const width of [40, 80, 120]) {
        const preview = samplePreview(PRESETS.detailed, width);
        assert(preview.text.length <= width, 'Preview respects sample width');
        assert(preview.omitted > 0 || width === 120, 'Preview reports fields without space');
    }

    const original = {model: 'unchanged', instructions: 'line one\nline two',
        tui: {theme: 'nord', status_line: ['git-branch'], terminal_title: ['project-name']},
        mcp_servers: {sample: {args: ['a', 'b'], env: {SECRET: 'test-only'}}}};
    const server = new Server(original);
    const footer = manager(server);
    await footer.read();
    assert(server.writes().length === 0, 'Reading preferences never mutates config');
    await footer.apply(selection);
    equal(server.config.tui.status_line, PRESETS.balanced, 'Applies ordered native fields');
    equal(server.config.tui.terminal_title, TITLE_PRESET, 'Applies native title');
    equal(server.config.instructions, original.instructions, 'Multiline unrelated config preserved at API boundary');
    equal(server.config.mcp_servers, original.mcp_servers, 'Unrelated tables preserved');
    assert(server.config.tui.theme === 'nord', 'CLI theme is never replaced');
    const mode = Gio.File.new_for_path(footer.stateFile)
        .query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode');
    assert((mode & 0o777) === 0o600, 'Private restore state');
    const saved = await loadJson(footer.stateFile);
    assert(!JSON.stringify(saved).includes('test-only'), 'Unrelated secret is not persisted');
    await footer.apply({...selection, fields: PRESETS.focused});
    await footer.restore();
    equal(server.config, original, 'Repeated Apply preserves the first originals; absent colors are removed');
    assert(server.writes()[2].params.edits.some(edit =>
        edit.keyPath === 'tui.status_line_use_colors' && edit.value === null), 'Absent original uses native clear');

    const changed = new Server(original);
    const safe = manager(changed);
    await safe.apply(selection);
    changed.config.tui.status_line = ['hostname'];
    changed.version++;
    const restored = await safe.restore();
    equal(restored.skipped, ['tui.status_line'], 'Restore reports user-edited keys');
    equal(changed.config.tui.status_line, ['hostname'], 'Restore preserves user-edited key');
    equal(changed.config.tui.terminal_title, original.tui.terminal_title, 'Other originals restored');
    assert(!('status_line_use_colors' in changed.config.tui), 'Other absent original cleared');

    const conflict = new Server(original);
    const conflicted = manager(conflict);
    conflict.conflict = true;
    await rejects(() => conflicted.apply(selection), 'rejected');
    equal(conflict.config, original, 'Version conflict never mutates config');
    await conflicted.apply(selection);
    await conflicted.restore();
    equal(conflict.config, original, 'Failed transaction recovery retains originals');

    const later = new Server(original);
    const retry = manager(later);
    later.conflict = true;
    await rejects(() => retry.apply(selection), 'rejected');
    later.config.tui.status_line = ['hostname'];
    later.version++;
    await retry.apply(selection);
    await retry.restore();
    equal(later.config.tui.status_line, ['hostname'], 'A failed first install does not claim later user edits');

    const fresh = new Server(original);
    const refetched = manager(fresh);
    await refetched.read();
    fresh.config.tui.status_line = ['current-dir'];
    fresh.version++;
    await refetched.apply({fields: PRESETS.focused, colors: false});
    equal(fresh.config.tui.terminal_title, original.tui.terminal_title, 'Optional title off leaves title untouched');
    await refetched.restore();
    equal(fresh.config.tui.status_line, ['current-dir'], 'Apply captures fresh user layer, not the UI snapshot');

    const invalid = new Server(original);
    invalid.invalid = true;
    await rejects(() => manager(invalid).apply(selection), 'read');
    assert(invalid.writes().length === 0, 'Invalid config is never overwritten');
    const absent = new Server();
    const absentFooter = manager(absent);
    assert((await absentFooter.read()).configured === false, 'An absent footer must be identified as unconfigured');
    await absentFooter.apply({fields: [], colors: false});
    assert((await absentFooter.read()).configured === true, 'An explicitly empty footer is configured, not missing');
    equal(absent.config.tui.status_line, [], 'Empty native footer is supported');
    const missing = new Server();
    missing.missing = true;
    await rejects(() => manager(missing).apply(selection), 'user layer');
    assert(missing.writes().length === 0, 'No versionless write when user layer is absent');

    const disk = new Server(original);
    await rejects(() => manager(disk, {save: async () => { throw new Error('disk full'); }}).apply(selection), 'restore state');
    assert(disk.writes().length === 0, 'Recovery state must be durable before mutation');
    let saves = 0;
    let stored = null;
    const recovery = manager(disk, {
        load: async () => stored,
        save: async (_path, value) => {
            if (++saves === 2)
                throw new Error('disk full');
            stored = copy(value);
        },
    });
    await rejects(() => recovery.apply(selection), 'recovery');
    equal(disk.config.tui.status_line, PRESETS.balanced, 'Applied config has recoverable journal');
    await recovery.restore();
    equal(disk.config, original, 'Restore recovers interrupted state save');

    let restoreSaves = 0;
    let restoreStored = null;
    const restoreServer = new Server(original);
    const interruptedRestore = manager(restoreServer, {
        load: async () => restoreStored,
        save: async (_path, value) => {
            if (++restoreSaves === 4)
                throw new Error('disk full');
            restoreStored = copy(value);
        },
    });
    await interruptedRestore.apply(selection);
    await rejects(() => interruptedRestore.restore(), 'recovery');
    equal(restoreServer.config, original, 'Successful restore survives final save failure');
    restoreServer.config.tui.status_line = ['hostname'];
    restoreServer.version++;
    await interruptedRestore.restore();
    equal(restoreServer.config.tui.status_line, ['hostname'], 'Journal recovery preserves user edit after restoration');
    assert(restoreServer.writes().length === 2, 'Recovered restoration never repeats its config write');

    const corruptServer = new Server(original);
    const corruptState = manager(corruptServer, {load: async () => ({
        format: 1, home: '/tmp/test-codex-home', original: {}, applied: {},
        pending: {kind: 'apply', before: {}, after: {'tui.status_line': {present: true, value: []}}},
    })});
    await rejects(() => corruptState.restore(), 'Invalid restore state');
    assert(corruptServer.writes().length === 0, 'Incomplete journal never authorizes a write');

    for (const operation of ['apply', 'restore']) {
        const closingServer = new Server(original);
        let running = true;
        let restarts = 0;
        const closingClient = {request: async (method, params) => {
            if (!running) {
                restarts++;
                running = true;
            }
            return closingServer.request(method, params);
        }};
        let closingState = null;
        let pauseSave = false;
        const saving = gate();
        const releaseSave = gate();
        const closing = manager(closingClient, {
            load: async () => closingState,
            save: async (_path, state) => {
                if (pauseSave) {
                    saving.release();
                    await releaseSave.promise;
                }
                closingState = copy(state);
            },
        });
        if (operation === 'restore')
            await closing.apply(selection);
        const writesBeforeClose = closingServer.writes().length;
        pauseSave = true;
        const pending = closing[operation](selection);
        const cancelled = rejects(() => pending, 'closed');
        await saving.promise;
        closing.dispose();
        running = false;
        releaseSave.release();
        await cancelled;
        assert(closingServer.writes().length === writesBeforeClose,
            `${operation} never writes after disposal during journal persistence`);
        assert(restarts === 0, `${operation} never restarts a stopped client`);
    }

    const loadingState = gate();
    const stateLoaded = gate();
    const unopened = new Server(original);
    const closingRead = manager(unopened, {load: async () => {
        loadingState.release();
        await stateLoaded.promise;
        return null;
    }});
    const pendingRead = closingRead.read();
    const cancelledRead = rejects(() => pendingRead, 'closed');
    await loadingState.promise;
    closingRead.dispose();
    stateLoaded.release();
    await cancelledRead;
    assert(unopened.calls.length === 0, 'Disposal during state load prevents a config request and auto-start');

    const sharedServer = new Server(original);
    let sharedState = null;
    let stateReads = 0;
    const firstReading = gate();
    const continueReading = gate();
    const sharedOptions = {
        stateFile: `${directory}/concurrent-state.json`,
        load: async () => {
            const captured = sharedState === null ? null : copy(sharedState);
            if (++stateReads === 1) {
                firstReading.release();
                await continueReading.promise;
            }
            return captured;
        },
        save: async (_path, value) => { sharedState = copy(value); },
    };
    const windowOne = manager(sharedServer, sharedOptions);
    const windowTwo = manager(sharedServer, sharedOptions);
    const firstApply = windowOne.apply({...selection, fields: PRESETS.focused});
    await firstReading.promise;
    const secondApply = windowTwo.apply({...selection, fields: PRESETS.detailed});
    await Promise.resolve();
    assert(stateReads === 1, 'Overlapping manager waits before capturing restore state');
    continueReading.release();
    await Promise.all([firstApply, secondApply]);
    await windowTwo.restore();
    equal(sharedServer.config, original, 'Concurrent managers never lose the first originals');

    const heldServer = new Server(original);
    const heldPath = `${directory}/held-state.json`;
    const heldLock = Gio.File.new_for_path(`${heldPath}.lock`);
    heldLock.create(Gio.FileCreateFlags.PRIVATE, null).close(null);
    try {
        await rejects(() => manager(heldServer, {stateFile: heldPath}).apply(selection), 'locked');
        assert(heldServer.calls.length === 0, 'Existing interprocess lock prevents reads and writes');
        assert(heldLock.query_exists(null), 'Another or abandoned lock is never removed automatically');
    } finally {
        heldLock.delete(null);
    }

    const sharedPath = `${directory}/home-state.json`;
    const first = manager(new Server(), {stateFile: sharedPath});
    await first.apply(selection);
    const other = manager(new Server(), {stateFile: sharedPath, home: '/tmp/other-codex-home'});
    await rejects(() => other.restore(), 'different Codex home');
    const validation = manager(new Server());
    await rejects(() => validation.apply({fields: ['invented'], colors: true}), 'Unknown footer field');
    await rejects(() => validation.apply({fields: ['model', 'model'], colors: true}), 'Duplicate');
    print('Native footer configuration checks passed');
} finally {
    const folder = Gio.File.new_for_path(directory);
    const entries = folder.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let entry;
    while ((entry = entries.next_file(null)))
        folder.get_child(entry.get_name()).delete(null);
    entries.close(null);
    folder.delete(null);
}
