import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {loadJson, writeJson, statePath, resolveHome, resolveCodex, clean} from './files.js';
import {formatCount, formatReset, ageLabel, quotaColor} from './usage.js';
import {hourlySeries, notificationTransition} from './history.js';
import {UsageMonitor} from './monitor.js';

const TABS = ['Overview', 'Activity', 'Sessions'];
const CHART_HEIGHT = 48; // CSS logical pixels; actor heights use stage coordinates.

function label(text = '', style = '', wrap = false) {
    const actor = new St.Label({text: clean(text), style_class: style, x_expand: true});
    actor.clutter_text.ellipsize = wrap ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
    actor.clutter_text.line_wrap = wrap;
    actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return actor;
}

function column(style = '') {
    return new St.BoxLayout({vertical: true, style_class: style, x_expand: true});
}

function iconButton(name, title) {
    return new St.Button({
        child: new St.Icon({icon_name: name, icon_size: 16}),
        style_class: 'cum-icon-button',
        accessible_name: title,
        can_focus: true,
    });
}

function dateLabel(seconds) {
    if (!Number.isFinite(seconds))
        return 'Time unavailable';
    return GLib.DateTime.new_from_unix_local(Math.floor(seconds))?.format('%b %e, %H:%M') ?? 'Time unavailable';
}

const QuotaProgress = GObject.registerClass(
class QuotaProgress extends St.Widget {
    _init(remaining, used) {
        super._init({style_class: 'cum-track', x_expand: true});
        this._fraction = Math.max(0, Math.min(100, remaining)) / 100;
        this.add_child(new St.Widget({style_class: `cum-fill cum-${quotaColor(used)}`}));
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        // Allocations already include scale; setting preferred widths here would queue another layout.
        const fillBox = this.get_theme_node().get_content_box(box);
        fillBox.x2 = fillBox.x1 + fillBox.get_width() * this._fraction;
        this.get_first_child().allocate(fillBox);
    }
});

const CodexIndicator = GObject.registerClass(
class CodexIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.5, 'Codex Usage Monitor');
        this._extension = extension;
        this._settings = settings;
        this._destroyed = false;
        this._generation = 0;
        this._monitor = null;
        this._state = null;
        this._tab = 0;
        this._selectedSession = null;
        this._sessionButtons = new Map();
        this._countdownId = 0;
        this._timeLabels = [];
        this._notificationSource = null;
        this._notificationSourceId = 0;
        this._notificationQueue = Promise.resolve();
        this._notificationAccounts = new Map();
        this._io = new Gio.Cancellable();
        this._theme = St.ThemeContext.get_for_stage(global.stage);
        this._icon = new Gio.FileIcon({file: extension.dir.get_child('codex-usage-symbolic.svg')});
        this._buildPanel();
        this._buildMenu();

        this._settingsId = settings.connect('changed', (_settings, key) => {
            if (['codex-executable', 'codex-home', 'refresh-interval'].includes(key))
                this._startMonitor();
            if (['show-panel-icon', 'show-panel-usage'].includes(key))
                this._updatePanel();
            if (key === 'panel-position')
                this._placePanel();
        });
        this._scaleId = this._theme.connect('notify::scale-factor', () => {
            this._resize();
            this._renderPage();
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._resize());
        this._menuId = this.menu.connect('open-state-changed', (_menu, open) => {
            this._stopCountdown();
            if (!open)
                return;
            this._resize();
            this._updateTimes();
            this._loadTab();
            this._countdownId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
                this._updateTimes();
                return GLib.SOURCE_CONTINUE;
            });
        });
        this._updatePanel();
        this._renderPage();
        this._startMonitor();
    }

    _buildPanel() {
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box cum-panel'});
        this._panelIcon = new St.Icon({gicon: this._icon, style_class: 'system-status-icon'});
        this._panelLabel = label('—', 'cum-panel-label');
        this._panelLabel.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(this._panelIcon);
        box.add_child(this._panelLabel);
        this.add_child(box);
    }

    _buildMenu() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: true, activate: false, hover: false, can_focus: false});
        item.track_hover = false;
        item.remove_style_class_name('popup-inactive-menu-item');
        item.add_style_class_name('cum-root');
        this._content = column('cum-content');
        item.add_child(this._content);
        this.menu.addMenuItem(item);

        const header = new St.BoxLayout({style_class: 'cum-header'});
        const identity = column('cum-identity');
        identity.add_child(label('Codex', 'cum-title'));
        this._accountLabel = label('Connecting…', 'cum-caption');
        identity.add_child(this._accountLabel);
        header.add_child(identity);
        this._refreshButton = iconButton('view-refresh-symbolic', 'Refresh selected view');
        this._refreshButton.connect('clicked', () => this._refresh());
        header.add_child(this._refreshButton);
        const preferences = iconButton('preferences-system-symbolic', 'Codex Usage Monitor settings');
        preferences.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        header.add_child(preferences);
        this._content.add_child(header);

        const tabs = new St.BoxLayout({style_class: 'cum-tabs', accessible_role: Atk.Role.PAGE_TAB_LIST});
        this._tabButtons = TABS.map((name, index) => {
            const button = new St.Button({
                label: name,
                style_class: 'cum-tab',
                accessible_role: Atk.Role.PAGE_TAB,
                accessible_name: name,
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', () => this._selectTab(index));
            button.connect('key-press-event', (_actor, event) => {
                const key = event.get_key_symbol();
                let target;
                if (key === Clutter.KEY_Left)
                    target = (index + 2) % 3;
                else if (key === Clutter.KEY_Right)
                    target = (index + 1) % 3;
                else if (key === Clutter.KEY_Home)
                    target = 0;
                else if (key === Clutter.KEY_End)
                    target = 2;
                else
                    return Clutter.EVENT_PROPAGATE;
                this._selectTab(target);
                this._tabButtons[target].grab_key_focus();
                return Clutter.EVENT_STOP;
            });
            tabs.add_child(button);
            return button;
        });
        this._content.add_child(tabs);
        this._scroll = new St.ScrollView({
            style_class: 'cum-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._page = column('cum-page');
        this._page.accessible_role = Atk.Role.PANEL;
        this._scroll.set_child(this._page);
        this._content.add_child(this._scroll);
        this._footer = label('Read-only usage monitor', 'cum-footer');
        this._content.add_child(this._footer);
        this._updateTabs();
    }

    _resize() {
        const monitor = Main.layoutManager.findMonitorForActor(this) ?? Main.layoutManager.primaryMonitor;
        const available = monitor ? Math.max(160, monitor.height / this._theme.scale_factor - 240) : 440;
        this._scroll.set_style(`max-height: ${Math.min(440, available)}px;`);
    }

    _placePanel() {
        const position = this._settings.get_string('panel-position');
        const boxes = {left: Main.panel._leftBox, center: Main.panel._centerBox, right: Main.panel._rightBox};
        const target = boxes[position] ?? boxes.right;
        const actor = this.container;
        if (actor.get_parent() === target)
            return;
        actor.get_parent()?.remove_child(actor);
        target.insert_child_at_index(actor, 0);
    }

    async _startMonitor() {
        const generation = ++this._generation;
        const previous = this._monitor;
        this._monitor = null;
        this._state = null;
        this._selectedSession = null;
        this._accountLabel.text = 'Connecting…';
        this._renderPage();
        this._updatePanel();
        try {
            await previous?.stop();
            const home = resolveHome(this._settings.get_string('codex-home'));
            const executable = await resolveCodex(this._settings.get_string('codex-executable'));
            if (this._destroyed || generation !== this._generation)
                return;
            this._home = home;
            const monitor = new UsageMonitor({
                executable,
                home,
                refreshSeconds: this._settings.get_int('refresh-interval'),
                onUpdate: state => {
                    if (!this._destroyed && generation === this._generation)
                        this._update(state);
                },
            });
            this._monitor = monitor;
            await monitor.start();
            if (!this._destroyed && generation === this._generation && this.menu.isOpen)
                this._loadTab();
        } catch (error) {
            if (this._destroyed || generation !== this._generation)
                return;
            const message = clean(error.message);
            this._update({connection: 'error', message, quotaError: message, activityError: message, sessionsError: message});
        }
    }

    _update(state) {
        const previous = this._state;
        this._state = {...state};
        if (previous?.accountKey !== state.accountKey)
            this._selectedSession = null;
        const account = state.account;
        this._accountLabel.text = clean(account?.label
            ? [account.label, account.plan].filter(Boolean).join(' · ')
            : state.message || 'Connecting…');
        this._refreshButton.reactive = !state.busy;
        this._refreshButton.opacity = state.busy ? 100 : 255;
        this._updatePanel();
        // Unrelated quota polls must not destroy the focused session row.
        const fields = this._tab === 0
            ? ['quota', 'quotaAt', 'quotaError', 'connection', 'message', 'account']
            : this._tab === 1
                ? ['activity', 'activityAt', 'activityError', 'quota', 'history', 'quotaError']
                : ['sessions', 'sessionsAt', 'sessionsError', 'detail', 'detailAt', 'detailError', 'accountKey'];
        if (!previous || fields.some(key => previous[key] !== state[key]))
            this._renderPage();
        this._updateTimes();
        if (state.quota && !state.quotaError && state.quotaAt &&
            (state.quotaAt !== previous?.quotaAt || state.accountKey !== previous?.accountKey))
            this._queueNotifications(state);
    }

    _updatePanel() {
        const windows = (this._state?.quota?.windows ?? []).filter(window => window.bucketId === 'codex');
        const preferred = [300, 10080].map(duration => windows.find(window => window.durationMinutes === duration)).filter(Boolean);
        const values = preferred.map(window => `${window.durationMinutes === 300 ? '5h' : '7d'} ${Math.round(window.remainingPercent)}%`);
        const stale = Boolean(this._state?.quotaError) || this._state?.connection === 'error';
        this._panelLabel.text = `${values.join('  ') || '—'}${stale ? ' !' : ''}`;
        const showUsage = this._settings.get_boolean('show-panel-usage');
        this._panelLabel.visible = showUsage;
        this._panelIcon.visible = this._settings.get_boolean('show-panel-icon') || !showUsage;
        this.accessible_name = clean(`Codex Usage Monitor. ${values.length ? `${values.join(', ')} remaining.` : 'Quota unavailable.'}${stale ? ' Showing stale data.' : ''}`);
    }

    _selectTab(index) {
        if (this._tab === index)
            return;
        this._tab = index;
        this._updateTabs();
        this._renderPage();
        this._scroll.vadjustment.value = 0;
        this._loadTab();
    }

    _updateTabs() {
        this._tabButtons.forEach((button, index) => {
            if (index === this._tab)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
            button.accessible_name = `${TABS[index]}${index === this._tab ? ', selected' : ''}`;
        });
        this._page.accessible_name = TABS[this._tab];
    }

    _loadTab() {
        if (this._tab === 1)
            this._monitor?.loadActivity();
        else if (this._tab === 2)
            this._monitor?.loadSessions();
    }

    _refresh() {
        if (!this._monitor) {
            this._startMonitor();
            return;
        }
        this._monitor.refresh();
        if (this._tab === 1)
            this._monitor.loadActivity({force: true});
        else
            this._loadTab();
        if (this._tab === 2 && this._selectedSession)
            this._monitor.loadSessionUsage(this._selectedSession);
    }

    _renderPage() {
        const focus = global.stage.get_key_focus();
        const focusedSession = [...this._sessionButtons].find(([, button]) => focus && (button === focus || button.contains(focus)))?.[0];
        this._sessionButtons = new Map();
        this._timeLabels = [];
        this._page.destroy_all_children();
        if (!this._state) {
            this._empty('Connecting to Codex', 'Reading the selected Codex account…');
            return;
        }
        if (this._tab === 0)
            this._overview();
        else if (this._tab === 1)
            this._activity();
        else
            this._sessions();
        this._updateTimes();
        if (focusedSession)
            this._sessionButtons.get(focusedSession)?.grab_key_focus();
    }

    _empty(title, description, parent = this._page) {
        const box = column('cum-empty');
        box.add_child(label(title, 'cum-section-title', true));
        box.add_child(label(description, 'cum-caption', true));
        parent.add_child(box);
    }

    _section(title, at, error, parent = this._page) {
        if (!at && !error && this._state?.connection === 'error')
            error = this._state.message;
        const row = new St.BoxLayout({style_class: 'cum-section-heading'});
        row.add_child(label(title, 'cum-section-title'));
        const time = label('', 'cum-caption');
        time.x_expand = false;
        this._timeLabels.push([time, () => at ? `${error ? 'Stale · ' : ''}${ageLabel(at)}` : 'No snapshot']);
        row.add_child(time);
        parent.add_child(row);
        if (error)
            parent.add_child(label(clean(error, 260), 'cum-error', true));
    }

    _detailRow(name, value, parent) {
        const row = new St.BoxLayout({style_class: 'cum-detail-row'});
        row.add_child(label(name, 'cum-caption'));
        const content = label(value ?? 'Unavailable', 'cum-detail-value');
        content.x_expand = false;
        row.add_child(content);
        parent.add_child(row);
    }

    _reset(at, parent) {
        const reset = label('', 'cum-caption');
        this._timeLabels.push([reset, () => formatReset(at) || 'Reset time unavailable']);
        parent.add_child(reset);
    }

    _progress(remaining, used, parent) {
        parent.add_child(new QuotaProgress(remaining, used));
    }

    _overview() {
        const state = this._state;
        this._section('Remaining allowance', state.quotaAt, state.quotaError);
        if (!state.quota) {
            const noAccount = state.account?.kind === 'none';
            const unsupported = state.account && !state.account.eligible && !noAccount;
            this._empty(noAccount ? 'Sign in with Codex' : unsupported ? 'Quota is unavailable for this account' : 'No quota snapshot yet',
                noAccount ? 'Run codex login in a terminal, then refresh.' : unsupported
                    ? 'API key and custom provider accounts do not expose ChatGPT plan allowances.'
                    : state.message || 'Codex has not returned account limits. Refresh to try again.');
            return;
        }
        for (const window of state.quota.windows) {
            const card = column('cum-quota-card');
            const heading = new St.BoxLayout({style_class: 'cum-quota-heading'});
            const identity = column('cum-quota-identity');
            identity.add_child(label(window.label, 'cum-quota-title'));
            identity.add_child(label(window.bucketName || window.bucketId || 'Account allowance', 'cum-caption'));
            heading.add_child(identity);
            const amount = label(`${Math.round(window.remainingPercent)}%`, 'cum-quota-number');
            amount.x_expand = false;
            amount.accessible_name = `${clean(window.label)}: ${Math.round(window.remainingPercent)} percent remaining`;
            heading.add_child(amount);
            card.add_child(heading);
            this._progress(window.remainingPercent, window.usedPercent, card);
            this._reset(window.resetsAt, card);
            this._page.add_child(card);
        }
        for (const limit of state.quota.individualLimits ?? []) {
            const card = column('cum-card');
            card.add_child(label(limit.label, 'cum-quota-title', true));
            this._detailRow('Used / limit', `${limit.used ?? '—'} / ${limit.limit ?? '—'}`, card);
            if (limit.remainingPercent !== null && limit.remainingPercent !== undefined) {
                this._detailRow('Remaining', `${Math.round(limit.remainingPercent)}%`, card);
                this._progress(limit.remainingPercent, 100 - limit.remainingPercent, card);
            }
            this._reset(limit.resetsAt, card);
            this._page.add_child(card);
        }
        if (state.quota.credits?.length) {
            const card = column('cum-card');
            card.add_child(label('Credits', 'cum-section-title'));
            for (const credit of state.quota.credits) {
                const value = credit.unlimited ? 'Unlimited' : credit.balance !== null && credit.balance !== undefined
                    ? `${credit.balance}` : credit.hasCredits === false ? 'No credits available' : 'Balance unavailable';
                this._detailRow(credit.label || credit.bucketId || 'Account', value, card);
            }
            card.add_child(label('Balances are shown in the units supplied by Codex.', 'cum-caption', true));
            this._page.add_child(card);
        }
        if (state.quota.resetCredits?.availableCount !== null && state.quota.resetCredits?.availableCount !== undefined)
            this._detailRow('Available reset credits', String(state.quota.resetCredits.availableCount), this._page);
        if (!state.quota.windows.length && !state.quota.individualLimits?.length && !state.quota.credits?.length)
            this._empty('No allowance windows', 'This account did not return a measurable allowance.');
    }

    _chart(values, captions, parent, percent = false) {
        const chart = new St.BoxLayout({style_class: 'cum-chart', accessible_role: Atk.Role.CHART});
        const available = values.filter(value => Number.isFinite(value));
        const maximum = percent ? 100 : Math.max(1, ...available);
        chart.accessible_name = clean(captions.join(', '), 2000);
        values.forEach((value, index) => {
            const slot = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.END});
            slot.accessible_name = clean(captions[index]);
            const bar = new St.Widget({
                style_class: `cum-chart-bar ${value === null ? 'cum-chart-missing' : percent ? `cum-${quotaColor(value)}` : 'cum-healthy'}`,
                x_expand: true,
            });
            bar.set_height((value === null ? 1 : Math.max(1, value / maximum * CHART_HEIGHT)) * this._theme.scale_factor);
            slot.add_child(bar);
            chart.add_child(slot);
        });
        parent.add_child(chart);
    }

    _activity() {
        const state = this._state;
        this._section('Allowance history · 24h', state.quotaAt, state.quotaError);
        const windows = state.quota?.windows ?? [];
        if (!windows.length)
            this._empty('No local history yet', 'History starts when Codex returns an allowance snapshot.');
        for (const window of windows) {
            const card = column('cum-card');
            card.add_child(label(`${window.label} · ${window.bucketName || window.bucketId}`, 'cum-quota-title'));
            const values = hourlySeries(state.history, window.id, Date.now());
            if (values.some(value => value !== null)) {
                this._chart(values, values.map((value, index) => `${24 - index}h ago: ${value === null ? 'no sample' : `${Math.round(value)}% used`}`), card, true);
                this._detailRow('24h ago', 'Now · % used', card);
                card.add_child(label('Gaps have no sample; a drop can reflect a reset.', 'cum-caption', true));
            } else {
                card.add_child(label('Collecting the first samples…', 'cum-caption'));
            }
            this._page.add_child(card);
        }
        this._section('Recorded activity', state.activityAt, state.activityError);
        const activity = state.activity;
        if (!activity) {
            this._empty('Activity unavailable', state.activityError ? 'The last request did not return activity.' : 'Waiting for recorded usage from Codex…');
            return;
        }
        const card = column('cum-card');
        const daily = activity.daily ?? [];
        if (daily.length) {
            card.add_child(label('Daily tokens', 'cum-quota-title'));
            this._chart(daily.map(day => day.tokens), daily.map(day => `${day.date}: ${formatCount(day.tokens)} tokens`), card);
            this._detailRow(daily[0].date, daily.at(-1).date, card);
            const last = daily.at(-1);
            this._detailRow('Latest recorded day', `${formatCount(last.tokens)} tokens`, card);
        } else {
            card.add_child(label('No daily token records returned.', 'cum-caption', true));
        }
        const summary = activity.summary ?? {};
        this._detailRow('Lifetime tokens', formatCount(summary.lifetimeTokens), card);
        this._detailRow('Peak daily tokens', formatCount(summary.peakDailyTokens), card);
        this._detailRow('Current streak', summary.currentStreakDays === null || summary.currentStreakDays === undefined ? null : `${summary.currentStreakDays} days`, card);
        this._detailRow('Longest streak', summary.longestStreakDays === null || summary.longestStreakDays === undefined ? null : `${summary.longestStreakDays} days`, card);
        this._detailRow('Longest turn', summary.longestRunningTurnSec === null || summary.longestRunningTurnSec === undefined ? null : `${summary.longestRunningTurnSec}s`, card);
        this._page.add_child(card);
    }

    _sessions() {
        const state = this._state;
        this._section('Recent session records', state.sessionsAt, state.sessionsError);
        this._page.add_child(label('Recorded metadata · not live process status', 'cum-caption', true));
        if (!state.sessions?.length) {
            this._empty(state.sessionsAt ? 'No session records' : 'Sessions unavailable', state.sessionsAt
                ? 'Codex returned no recorded sessions for this home.' : 'Waiting for session metadata from Codex…');
            return;
        }
        for (const session of state.sessions.slice(0, 10)) {
            const selected = this._selectedSession === session.id;
            const button = new St.Button({
                style_class: `cum-session${selected ? ' cum-session-selected' : ''}`,
                can_focus: true,
                x_expand: true,
                accessible_name: clean(`${session.title || 'Untitled session'}. ${session.project || ''}. Updated ${dateLabel(session.updatedAt)}. Show recorded usage.`),
            });
            const body = column('cum-session-body');
            body.add_child(label(session.title || 'Untitled session', 'cum-quota-title'));
            body.add_child(label([session.project, session.model, session.reasoning].filter(Boolean).join(' · ') || 'Metadata unavailable', 'cum-caption'));
            body.add_child(label([dateLabel(session.updatedAt), session.source].filter(Boolean).join(' · '), 'cum-caption'));
            button.set_child(body);
            button.connect('clicked', () => {
                this._selectedSession = selected ? null : session.id;
                this._renderPage();
                this._sessionButtons.get(session.id)?.grab_key_focus();
                if (this._selectedSession)
                    this._monitor?.loadSessionUsage(session.id);
            });
            this._sessionButtons.set(session.id, button);
            this._page.add_child(button);
            if (selected)
                this._sessionUsage(session);
        }
    }

    _sessionUsage(session) {
        const state = this._state;
        const card = column('cum-session-detail');
        this._section('Recorded usage', state.detailAt, state.detailError, card);
        const thread = state.detail?.thread;
        if (!thread || thread.id !== session.id) {
            card.add_child(label(state.detailAt || state.detailError
                ? 'Usage details are not available for this session/account.'
                : 'Reading optional session usage…', 'cum-caption', true));
        } else {
            this._detailRow('Credits', thread.credits, card);
            this._detailRow('Cost (USD)', thread.costUsd === null || thread.costUsd === undefined ? null : `$${thread.costUsd}`, card);
            if (!thread.groups?.length)
                card.add_child(label('No model token breakdown returned.', 'cum-caption', true));
            for (const group of thread.groups ?? []) {
                card.add_child(label([group.model, group.effort, group.speed].filter(Boolean).join(' · ') || 'Model unspecified', 'cum-quota-title', true));
                this._detailRow('Input / cached', `${formatCount(group.inputTokens)} / ${formatCount(group.cachedInputTokens)}`, card);
                this._detailRow('Output', formatCount(group.outputTokens), card);
                this._detailRow('Total tokens', formatCount(group.totalTokens), card);
                this._detailRow('Credits', group.credits, card);
            }
        }
        this._page.add_child(card);
    }

    _updateTimes() {
        for (const [actor, format] of this._timeLabels)
            actor.text = clean(format());
    }

    _queueNotifications(state) {
        if (!state.accountKey)
            return;
        const key = state.accountKey;
        const home = this._home;
        const windows = state.quota.windows.map(window => ({...window}));
        const thresholds = [[75, 'notify-warning'], [90, 'notify-critical'], [100, 'notify-exhausted']]
            .filter(([, setting]) => this._settings.get_boolean(setting)).map(([value]) => value);
        // One queue owns every load/modify/write, so rapid updates cannot overwrite a newer threshold.
        this._notificationQueue = this._notificationQueue.then(async () => {
            if (this._destroyed)
                return;
            const cacheKey = `${home}\n${key}`;
            let record = this._notificationAccounts.get(cacheKey);
            const first = !record;
            const path = statePath(`notifications-${key}.json`, home);
            if (!record) {
                let saved;
                try {
                    saved = await loadJson(path, this._io);
                } catch (error) {
                    if (error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED))
                        throw error;
                    // A damaged cache starts a silent baseline instead of disabling alerts forever.
                    saved = null;
                }
                record = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
            }
            if (this._destroyed)
                return;
            const next = {};
            const alerts = [];
            for (const window of windows) {
                const transition = notificationTransition(record[window.id], window, thresholds);
                next[window.id] = transition.state;
                if (!first && transition.threshold)
                    alerts.push(`${window.label}: ${Math.round(window.remainingPercent)}% remaining${window.bucketName ? ` · ${window.bucketName}` : ''}.`);
            }
            if (JSON.stringify(next) !== JSON.stringify(record))
                await writeJson(path, next, this._io);
            if (this._destroyed)
                return;
            this._notificationAccounts.set(cacheKey, next);
            if (this._state?.accountKey === key && this._home === home && alerts.length)
                this._notify(alerts.join(' '));
        }).catch(error => {
            if (!this._destroyed && !error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED))
                console.error(`Codex Usage Monitor: notification state unavailable: ${clean(error.message)}`);
        });
    }

    _notify(body) {
        if (!this._notificationSource) {
            const source = new MessageTray.Source({title: 'Codex Usage Monitor', icon: this._icon});
            this._notificationSourceId = source.connect('destroy', () => {
                this._notificationSource = null;
                this._notificationSourceId = 0;
            });
            this._notificationSource = source;
            Main.messageTray.add(source);
        }
        this._notificationSource.addNotification(new MessageTray.Notification({
            source: this._notificationSource,
            title: 'Codex allowance',
            body: clean(body, 700),
        }));
    }

    _stopCountdown() {
        if (this._countdownId)
            GLib.source_remove(this._countdownId);
        this._countdownId = 0;
    }

    destroy() {
        this._destroyed = true;
        ++this._generation;
        this._stopCountdown();
        this._io.cancel();
        this._settings.disconnect(this._settingsId);
        this._theme.disconnect(this._scaleId);
        Main.layoutManager.disconnect(this._monitorsId);
        this.menu.disconnect(this._menuId);
        this._monitor?.stop().catch(() => {});
        this._monitor = null;
        if (this._notificationSourceId)
            this._notificationSource.disconnect(this._notificationSourceId);
        this._notificationSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._notificationSource = null;
        this._notificationSourceId = 0;
        this._notificationAccounts.clear();
        this._sessionButtons.clear();
        this._timeLabels = [];
        super.destroy();
    }
});

export default class CodexUsageMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new CodexIndicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, this._settings.get_string('panel-position'));
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
