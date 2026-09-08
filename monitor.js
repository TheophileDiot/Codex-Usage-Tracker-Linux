import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {CodexClient} from './app-server.js';
import {loadJson, writeJson, statePath} from './files.js';
import {normalizeAccount, normalizeQuotas, normalizeActivity, normalizeSessions} from './usage.js';
import {sanitizeHistory, addHistorySample} from './history.js';

function explanation(error, section) {
    if (error?.code === -32601) return `This Codex version does not provide ${section}.`;
    const message = String(error?.message || '');
    if (/429|rate.?limit/i.test(message)) return 'Codex is rate limiting requests. Keeping the last successful data; retrying less often.';
    if (/auth|401|403|sign.?in/i.test(message)) return `Codex could not authorize ${section}. Check your Codex login and account access.`;
    if (/timed out/i.test(message)) return `Codex took too long to return ${section}. Keeping the last successful data.`;
    return `Could not refresh ${section}. Check your Codex connection; the last successful data remains visible.`;
}

function supported(version) {
    const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
    return parts && (parts[0] > 0 || parts[1] > 153 || parts[1] === 153 && parts[2] >= 4);
}

/** Account reads only. Live per-turn telemetry remains inside each native Codex TUI. */
export class UsageMonitor {
    constructor({executable, home, refreshSeconds = 60, onUpdate = () => {}, client = null}) {
        this._home = home;
        this._refreshSeconds = Math.min(3600, Math.max(30, refreshSeconds));
        this._onUpdate = onUpdate;
        this._client = client || new CodexClient({executable, home,
            onNotification: method => {
                if (!this._stopped && ['account/updated', 'account/rateLimits/updated'].includes(method))
                    this._schedule(250);
            },
            onExit: () => {
                if (!this._stopped) {
                    this._set({connection: 'error', message: 'The Codex connection stopped. Reconnecting automatically.'});
                    this._schedule(this._refreshSeconds * 1000);
                }
            }});
        this._stopped = false;
        this._generation = 0;
        this._timer = 0;
        this._failures = 0;
        this._identity = null;
        this._io = new Gio.Cancellable();
        this._refreshing = null;
        this._activityPending = null;
        this._sessionsPending = null;
        this._detailSequence = 0;
        this._accountEpoch = 0;
        this._detailPending = null;
        this._detailQueued = null;
        this.state = {connection: 'connecting', message: null, busy: false,
            account: null, quota: null, quotaAt: null, quotaError: null,
            activity: null, activityAt: null, activityError: null,
            sessions: [], sessionsAt: null, sessionsError: null,
            detail: null, detailAt: null, detailError: null,
            history: sanitizeHistory(null), accountKey: null};
    }

    _set(values) {
        if (this._stopped) return;
        this.state = {...this.state, ...values};
        this._onUpdate({...this.state});
    }

    _schedule(delay = this._refreshSeconds * 1000) {
        if (this._timer) GLib.Source.remove(this._timer);
        this._timer = 0;
        if (this._stopped) return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timer = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async start() {
        await this.refresh();
        if (this.state.account?.eligible && !this._stopped) await this.loadActivity();
    }

    refresh() {
        if (this._stopped) return Promise.resolve();
        if (this._refreshing) return this._refreshing;
        const task = this._refresh().finally(() => {
            if (this._refreshing === task) this._refreshing = null;
            if (!this._stopped) {
                this._set({busy: false});
                this._schedule(Math.max(this._refreshSeconds * 1000,
                    Math.min(900000, this._refreshSeconds * 1000 * 2 ** Math.min(this._failures, 4))));
            }
        });
        this._refreshing = task;
        return task;
    }

    _clearAccountData() {
        this._accountEpoch++;
        this._detailSequence++;
        this._detailQueued = null;
        this._set({quota: null, quotaAt: null, quotaError: null, activity: null, activityAt: null, activityError: null,
            sessions: [], sessionsAt: null, sessionsError: null, detail: null, detailAt: null, detailError: null,
            history: sanitizeHistory(null), accountKey: null});
    }

    async _refresh() {
        const generation = this._generation;
        this._set({busy: true});
        try {
            await this._client.start();
            if (!supported(this._client.version)) {
                this._set({connection: 'error', message: 'Codex CLI 0.153.4 or newer is required. Select a current executable in Preferences.'});
                this._failures++;
                return;
            }
            const account = normalizeAccount(await this._client.request('account/read', {refreshToken: false}));
            if (this._stopped || generation !== this._generation) return;
            const identity = JSON.stringify([account.kind, account.label]);
            if (identity !== this._identity) {
                this._identity = identity;
                this._clearAccountData();
            }
            this._set({account, connection: 'ready', message: null});
            if (!account.eligible) {
                this._failures = 0;
                this._set({quotaError: account.kind === 'none'
                    ? 'Sign in through Codex to see account usage.'
                    : 'Account quotas are available for Codex backend accounts. Native session fields still work with other providers.'});
                return;
            }
            const quota = normalizeQuotas(await this._client.request('account/rateLimits/read'));
            if (this._stopped || generation !== this._generation) return;
            const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,
                JSON.stringify([this._home, identity, quota.accountId]), -1);
            if (this.state.accountKey !== key) {
                this._clearAccountData();
                this._set({accountKey: key});
                try {
                    const loaded = await loadJson(statePath(`history-${key}.json`, this._home), this._io);
                    if (!this._stopped) this._set({history: sanitizeHistory(loaded)});
                } catch {
                    if (!this._stopped) this._set({message: 'Saved history could not be read. Starting a fresh chart.'});
                }
            }
            if (this._stopped || generation !== this._generation) return;
            const now = Date.now();
            const {history, changed} = addHistorySample(this.state.history, quota.windows, now);
            this._failures = 0;
            this._set({quota, quotaAt: now, quotaError: null, history, connection: 'ready'});
            if (changed) {
                try { await writeJson(statePath(`history-${key}.json`, this._home), history, this._io); }
                catch { if (!this._stopped) this._set({message: 'Quota data is current, but local history could not be saved.'}); }
            }
            if (!this._stopped && (!this.state.activityAt || now - this.state.activityAt >= 900000))
                void this.loadActivity();
        } catch (error) {
            if (this._stopped || generation !== this._generation) return;
            this._failures++;
            this._set({connection: 'error', quotaError: explanation(error, 'quotas')});
        }
    }

    loadActivity({force = false} = {}) {
        if (this._stopped || !this.state.account?.eligible) return Promise.resolve();
        if (this._activityPending) return this._activityPending;
        if (!force && this.state.activityAt && Date.now() - this.state.activityAt < 900000) return Promise.resolve();
        const epoch = this._accountEpoch;
        const task = this._client.request('account/usage/read').then(response => {
            if (!this._stopped && epoch === this._accountEpoch)
                this._set({activity: normalizeActivity(response), activityAt: Date.now(), activityError: null});
        }).catch(error => {
            if (!this._stopped && epoch === this._accountEpoch)
                this._set({activityError: explanation(error, 'account activity')});
        }).finally(() => {
            if (this._activityPending === task) this._activityPending = null;
            if (!this._stopped && epoch !== this._accountEpoch) return this.loadActivity();
        });
        this._activityPending = task;
        return task;
    }

    loadSessions() {
        if (this._stopped) return Promise.resolve();
        if (this._sessionsPending) return this._sessionsPending;
        const epoch = this._accountEpoch;
        const task = this._client.request('thread/list', {limit: 10, sortKey: 'updated_at', useStateDbOnly: true}).then(response => {
            if (!this._stopped && epoch === this._accountEpoch)
                this._set({sessions: normalizeSessions(response), sessionsAt: Date.now(), sessionsError: null});
        }).catch(error => {
            if (!this._stopped && epoch === this._accountEpoch)
                this._set({sessionsError: explanation(error, 'recent sessions')});
        }).finally(() => {
            if (this._sessionsPending === task) this._sessionsPending = null;
            if (!this._stopped && epoch !== this._accountEpoch) return this.loadSessions();
        });
        this._sessionsPending = task;
        return task;
    }

    loadSessionUsage(id) {
        if (this._stopped || !this.state.sessions.some(session => session.id === id)) return Promise.resolve();
        const request = {id, epoch: this._accountEpoch, sequence: ++this._detailSequence};
        this._set({detail: null, detailAt: null, detailError: null});
        if (this._detailPending) {
            this._detailQueued = request;
            return this._detailPending;
        }
        return this._requestDetail(request);
    }

    _requestDetail({id, epoch, sequence}) {
        const task = this._client.request('account/usage/read', {threadId: id}).then(response => {
            if (!this._stopped && epoch === this._accountEpoch && sequence === this._detailSequence)
                this._set({detail: normalizeActivity(response), detailAt: Date.now(), detailError: null});
        }).catch(error => {
            if (!this._stopped && epoch === this._accountEpoch && sequence === this._detailSequence)
                this._set({detailError: explanation(error, 'session usage')});
        }).finally(() => {
            if (this._detailPending === task) this._detailPending = null;
            const queued = this._detailQueued;
            this._detailQueued = null;
            if (!this._stopped && queued?.epoch === this._accountEpoch) return this._requestDetail(queued);
        });
        this._detailPending = task;
        return task;
    }

    stop() {
        if (this._stopPromise) return this._stopPromise;
        this._stopped = true;
        this._generation++;
        this._detailSequence++;
        this._detailQueued = null;
        if (this._timer) GLib.Source.remove(this._timer);
        this._timer = 0;
        this._io.cancel();
        this._stopPromise = this._client.stop();
        return this._stopPromise;
    }
}
