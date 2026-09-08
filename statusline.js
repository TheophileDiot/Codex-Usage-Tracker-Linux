// Native Codex footer configuration, not a status-line command renderer.
// Catalogue baseline: openai/codex rust-v0.153.4, tui status_line_setup.rs.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {loadJson, writeJson, statePath} from './files.js';

export const FIELD_CATALOG = [
    ['model', 'Model', 'Active model', 'gpt-5.4'],
    ['model-with-reasoning', 'Model and reasoning', 'Active model with reasoning effort', 'gpt-5.4 high'],
    ['reasoning', 'Reasoning effort', 'Current reasoning effort', 'high'],
    ['current-dir', 'Current directory', 'Current working directory', '~/work/monitor'],
    ['project-name', 'Project', 'Project directory name', 'monitor'],
    ['hostname', 'Hostname', 'Machine running Codex', 'workstation'],
    ['git-branch', 'Git branch', 'Current branch', 'main'],
    ['pull-request-number', 'Pull request', 'Pull request for the current branch, when available', 'PR #42'],
    ['branch-changes', 'Branch changes', 'Committed changes compared with the default branch', '+128 -24'],
    ['run-state', 'Run state', 'Whether Codex is working or waiting', 'working'],
    ['permissions', 'Permissions', 'Current permissions mode', 'workspace'],
    ['approval-mode', 'Approval mode', 'Current approval policy', 'on-request'],
    ['context-remaining', 'Context remaining', 'Available context window', '76% context left'],
    ['context-used', 'Context used', 'Context window already used', '24% context used'],
    ['five-hour-limit', 'Five-hour quota', 'Remaining five-hour quota, when supplied', '5h 82% left'],
    ['weekly-limit', 'Weekly quota', 'Remaining weekly quota, when supplied', 'week 64% left'],
    ['codex-version', 'Codex version', 'CLI version', 'v0.153.4'],
    ['context-window-size', 'Context size', 'Model context window size', '272K context'],
    ['used-tokens', 'Used tokens', 'Tokens currently occupying context', '65K used'],
    ['total-input-tokens', 'Total input tokens', 'Session input token total', '148K in'],
    ['total-output-tokens', 'Total output tokens', 'Session output token total', '12K out'],
    ['thread-credits', 'Thread credits', 'Enterprise thread credits, when supplied', '12 credits'],
    ['estimated-thread-cost', 'Estimated thread cost', 'Enterprise estimated cost, when supplied', '$0.42'],
    ['thread-id', 'Thread ID', 'Current conversation identifier', '019a…7bf2'],
    ['fast-mode', 'Fast mode', 'Shown when fast mode is active', 'fast'],
    ['raw-output', 'Raw output', 'Shown when raw output mode is active', 'raw'],
    ['thread-title', 'Thread title', 'Current conversation title', 'Refine preferences'],
    ['workspace-headline', 'Workspace headline', 'Workspace status, when available', 'Preferences update'],
    ['task-progress', 'Task progress', 'Current plan progress, when available', '2/4 tasks'],
].map(([id, label, description, sample]) => Object.freeze({id, label, description, sample}));

const focused = ['five-hour-limit', 'weekly-limit', 'context-used'];
const balanced = [...focused, 'model-with-reasoning', 'project-name', 'git-branch'];
export const PRESETS = Object.freeze({
    focused: Object.freeze(focused),
    balanced: Object.freeze(balanced),
    detailed: Object.freeze([...balanced, 'context-window-size', 'used-tokens',
        'total-input-tokens', 'total-output-tokens', 'task-progress', 'fast-mode']),
});
export const TITLE_PRESET = Object.freeze(['activity', 'project-name', 'git-branch', 'thread-title']);
const KEYS = ['tui.status_line', 'tui.status_line_use_colors', 'tui.terminal_title'];
const ids = new Set(FIELD_CATALOG.map(field => field.id));
const copy = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class FooterConfigError extends Error {}
const transactions = new Map();

/** Illustrative data only; Codex decides availability and exact terminal layout. */
export function samplePreview(fields, width = 80) {
    const parts = [];
    for (const id of fields) {
        const sample = FIELD_CATALOG.find(field => field.id === id)?.sample;
        if (!sample || [...parts, sample].join(' · ').length > width)
            break;
        parts.push(sample);
    }
    return {text: parts.join(' · '), omitted: fields.length - parts.length};
}

function entry(config, key) {
    const name = key.slice(4);
    return Object.hasOwn(config.tui ?? {}, name)
        ? {present: true, value: copy(config.tui[name])}
        : {present: false};
}

function validEntry(value) {
    return object(value) && typeof value.present === 'boolean' &&
        (!value.present || Object.hasOwn(value, 'value'));
}

/** One manager belongs to one selected home for its entire lifetime. */
export class FooterManager {
    constructor(client, {home, stateFile = statePath('native-footer.json', home),
        load = loadJson, save = writeJson}) {
        this.client = client;
        this.home = GLib.canonicalize_filename(home, null);
        this.stateFile = GLib.canonicalize_filename(stateFile, null);
        this._load = load;
        this._save = save;
        this._busy = false;
        this._disposed = false;
    }

    dispose() {
        this._disposed = true;
    }

    _assertActive() {
        if (this._disposed)
            throw new FooterConfigError('These preferences were closed or reconnected. No new configuration request was sent.');
    }

    async _state() {
        this._assertActive();
        let state;
        try {
            state = await this._load(this.stateFile);
        } catch (_) {
            throw new FooterConfigError('Cannot read restore state. No configuration was changed.');
        }
        this._assertActive();
        if (state === null)
            return {format: 1, home: this.home, original: {}, applied: {}, pending: null};
        if (state.home !== this.home)
            throw new FooterConfigError('Restore state belongs to a different Codex home. No configuration was changed.');
        const maps = [state.original, state.applied];
        if (state.pending)
            maps.push(state.pending.before, state.pending.after);
        if (state.format !== 1 || maps.some(map => !object(map) || Object.entries(map)
            .some(([key, value]) => !KEYS.includes(key) || !validEntry(value))) ||
            Object.keys(state.applied).some(key => !Object.hasOwn(state.original, key)) ||
            (state.pending && (!['apply', 'restore'].includes(state.pending.kind) ||
                Object.keys(state.pending.after).some(key => !Object.hasOwn(state.original, key) ||
                    !Object.hasOwn(state.pending.before, key)))))
            throw new FooterConfigError('Invalid restore state. No configuration was changed.');
        return copy(state);
    }

    async _snapshot() {
        this._assertActive();
        let response;
        try {
            response = await this.client.request('config/read', {includeLayers: true});
        } catch (_) {
            throw new FooterConfigError('Cannot read Codex configuration. Check its syntax and connection.');
        }
        this._assertActive();
        const candidates = Array.isArray(response?.layers)
            ? response.layers.filter(layer => layer?.name?.type === 'user') : null;
        const user = candidates?.length === 1 ? candidates[0] : null;
        const path = GLib.build_filenamev([this.home, 'config.toml']);
        if (!user || (user.disabledReason !== null && user.disabledReason !== undefined) || typeof user.version !== 'string' || !user.version ||
            user.name.file !== path || !object(user.config) ||
            (user.config.tui !== undefined && !object(user.config.tui)))
            throw new FooterConfigError('Cannot identify an active, versioned user layer for this Codex home. No configuration was changed.');
        return {config: user.config, effective: response.config ?? {},
            version: user.version, filePath: path};
    }

    async _persist(state, afterWrite = false) {
        try {
            await this._save(this.stateFile, state);
        } catch (_) {
            throw new FooterConfigError(afterWrite
                ? 'Codex changed the configuration, but saving recovery state failed. Keep this home selected and use Restore to recover.'
                : 'Cannot save private restore state. No configuration was changed.');
        }
    }

    async _recover(state, snapshot) {
        this._assertActive();
        if (!state.pending)
            return;
        for (const [key, value] of Object.entries(state.pending.after)) {
            const current = entry(snapshot.config, key);
            if (state.pending.kind === 'apply') {
                // A saved journal covers a committed write even if the final state save failed.
                if (equal(current, value)) {
                    state.applied[key] = value;
                } else if (!equal(current, state.pending.before[key]) || !Object.hasOwn(state.applied, key)) {
                    // No confirmed write, or a later user edit: relinquish ownership.
                    delete state.applied[key];
                    delete state.original[key];
                }
            } else if (!equal(current, state.pending.before[key]) || equal(current, value)) {
                delete state.applied[key];
                delete state.original[key];
            }
        }
        state.pending = null;
        await this._persist(state);
        this._assertActive();
    }

    async read() {
        const state = await this._state();
        const snapshot = await this._snapshot();
        const tui = snapshot.effective.tui ?? {};
        return {
            fields: Array.isArray(tui.status_line) ? [...tui.status_line] : [...PRESETS.balanced],
            colors: typeof tui.status_line_use_colors === 'boolean' ? tui.status_line_use_colors : true,
            title: Array.isArray(tui.terminal_title) ? [...tui.terminal_title] : null,
            theme: typeof tui.theme === 'string' ? tui.theme : null,
            managed: Object.keys(state.applied).length > 0 || Boolean(state.pending),
            version: snapshot.version,
            filePath: snapshot.filePath,
        };
    }

    async _transaction(operation) {
        this._assertActive();
        if (this._busy)
            throw new FooterConfigError('A configuration change is already in progress.');
        this._busy = true;
        const previous = transactions.get(this.stateFile) ?? Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        transactions.set(this.stateFile, current);
        let lock = null;
        try {
            await previous;
            this._assertActive();
            // Preferences-only module: exclusive creation also protects separate prefs processes.
            if (GLib.mkdir_with_parents(GLib.path_get_dirname(this.stateFile), 0o700) !== 0)
                throw new FooterConfigError('Cannot prepare private restore state. No configuration was changed.');
            const file = Gio.File.new_for_path(`${this.stateFile}.lock`);
            try {
                const stream = file.create(Gio.FileCreateFlags.PRIVATE, null);
                lock = file;
                stream.close(null);
            } catch (_) {
                throw new FooterConfigError('Restore state is locked by another or interrupted preferences update. Close other preferences windows before retrying. No configuration was changed.');
            }
            return await operation();
        } finally {
            try {
                if (lock)
                    lock.delete(null);
            } finally {
                release();
                if (transactions.get(this.stateFile) === current)
                    transactions.delete(this.stateFile);
                this._busy = false;
            }
        }
    }

    async _write(state, snapshot, after, kind) {
        this._assertActive();
        const keys = Object.keys(after);
        if (keys.length === 0)
            return;
        state.filePath = snapshot.filePath;
        state.version = snapshot.version;
        state.fingerprint = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,
            JSON.stringify(Object.fromEntries(KEYS.map(key => [key, entry(snapshot.config, key)]))), -1);
        state.pending = {kind,
            before: Object.fromEntries(keys.map(key => [key, entry(snapshot.config, key)])),
            after: copy(after)};
        await this._persist(state);
        this._assertActive();
        let result;
        try {
            result = await this.client.request('config/batchWrite', {
                filePath: snapshot.filePath,
                expectedVersion: snapshot.version,
                edits: keys.map(key => ({keyPath: key,
                    value: after[key].present ? after[key].value : null, mergeStrategy: 'replace'})),
            });
        } catch (_) {
            throw new FooterConfigError('Codex rejected or could not confirm the configuration change. Reload to check the current settings before trying again.');
        }
        for (const key of keys) {
            if (kind === 'apply')
                state.applied[key] = copy(after[key]);
            else {
                delete state.applied[key];
                delete state.original[key];
            }
        }
        state.version = result?.version ?? snapshot.version;
        state.pending = null;
        await this._persist(state, true);
    }

    async apply({fields, colors, title = null}) {
        if (!Array.isArray(fields) || fields.some(id => !ids.has(id)))
            throw new FooterConfigError('Unknown footer field. Choose a supported native field.');
        if (new Set(fields).size !== fields.length)
            throw new FooterConfigError('Duplicate footer fields are not supported.');
        if (typeof colors !== 'boolean' || (title !== null && !equal(title, TITLE_PRESET)))
            throw new FooterConfigError('Invalid footer colors or title preset.');
        return this._transaction(async () => {
            const state = await this._state();
            const snapshot = await this._snapshot();
            await this._recover(state, snapshot);
            this._assertActive();
            const after = {'tui.status_line': {present: true, value: [...fields]},
                'tui.status_line_use_colors': {present: true, value: colors}};
            if (title)
                after['tui.terminal_title'] = {present: true, value: [...title]};
            for (const key of Object.keys(after)) {
                if (!Object.hasOwn(state.original, key))
                    state.original[key] = entry(snapshot.config, key);
            }
            await this._write(state, snapshot, after, 'apply');
            return {changed: Object.keys(after)};
        });
    }

    async restore() {
        return this._transaction(async () => {
            const state = await this._state();
            const snapshot = await this._snapshot();
            await this._recover(state, snapshot);
            this._assertActive();
            const after = {};
            const skipped = [];
            for (const [key, applied] of Object.entries(state.applied)) {
                if (equal(entry(snapshot.config, key), applied))
                    after[key] = state.original[key];
                else {
                    skipped.push(key);
                    delete state.applied[key];
                    delete state.original[key];
                }
            }
            if (Object.keys(after).length)
                await this._write(state, snapshot, after, 'restore');
            else
                await this._persist(state);
            return {restored: Object.keys(after), skipped};
        });
    }
}
