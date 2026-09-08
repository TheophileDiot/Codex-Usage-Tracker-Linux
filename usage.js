// Pure data projections. Absent service values are never converted to zero.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const percent = value => typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value)) : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 8.64e12 ? value : null;

export function clean(value, max = 200) {
    return typeof value === 'string'
        ? value.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max) : '';
}

export function quotaColor(used) {
    return used >= 90 ? 'critical' : used >= 75 ? 'warning' : 'healthy';
}

function durationLabel(minutes, slot) {
    if (minutes === 10080) return 'Weekly';
    if (minutes === 300) return '5 hours';
    if (minutes === null) return slot === 'primary' ? 'Primary limit' : 'Secondary limit';
    if (minutes % 1440 === 0) return `${minutes / 1440} days`;
    if (minutes % 60 === 0) return `${minutes / 60} hours`;
    return `${minutes} minutes`;
}

export function normalizeQuotas(response) {
    if (!object(response) || !object(response.rateLimitsByLimitId) && !object(response.rateLimits))
        throw new Error('Codex returned an unrecognized quota response.');
    const buckets = object(response.rateLimitsByLimitId)
        ? Object.entries(response.rateLimitsByLimitId)
        : [[response.rateLimits.limitId || 'codex', response.rateLimits]];
    buckets.sort(([a], [b]) => a === 'codex' ? -1 : b === 'codex' ? 1 : a.localeCompare(b));
    const result = {accountId: clean(response.accountId, 200) || null, windows: [], credits: [], individualLimits: [], resetCredits: null};
    for (const [key, bucket] of buckets.slice(0, 100)) {
        if (!object(bucket)) continue;
        const bucketId = clean(key, 200);
        const bucketName = clean(bucket.limitName, 100) || (bucketId === 'codex' ? 'Codex' : bucketId);
        for (const slot of ['primary', 'secondary']) {
            const source = bucket[slot];
            if (!object(source)) continue;
            const usedPercent = percent(source.usedPercent);
            if (usedPercent === null) continue;
            const durationMinutes = count(source.windowDurationMins) || null;
            result.windows.push({
                id: `${encodeURIComponent(bucketId)}:${slot}:${durationMinutes ?? 'unknown'}`,
                bucketId, bucketName, slot, label: durationLabel(durationMinutes, slot),
                durationMinutes, usedPercent, remainingPercent: 100 - usedPercent,
                resetsAt: timestamp(source.resetsAt), planType: clean(bucket.planType, 80) || null,
            });
        }
        if (object(bucket.credits)) {
            const credits = bucket.credits;
            result.credits.push({bucketId, label: bucketName, hasCredits: credits.hasCredits === true,
                unlimited: credits.unlimited === true, balance: clean(credits.balance, 100) || null});
        }
        if (object(bucket.individualLimit)) {
            const source = bucket.individualLimit;
            const remainingPercent = percent(source.remainingPercent);
            if (remainingPercent !== null)
                result.individualLimits.push({id: `${encodeURIComponent(bucketId)}:individual`, bucketId,
                    label: `${bucketName} spending limit`, remainingPercent,
                    used: clean(source.used, 100) || null, limit: clean(source.limit, 100) || null,
                    resetsAt: timestamp(source.resetsAt)});
        }
    }
    const availableCount = count(response.rateLimitResetCredits?.availableCount);
    if (availableCount !== null) result.resetCredits = {availableCount};
    return result;
}

export function normalizeAccount(response) {
    if (!object(response) || !('account' in response)) throw new Error('Codex returned an unrecognized account response.');
    const account = response.account;
    if (!object(account)) return {kind: 'none', label: 'Not signed in', plan: null, eligible: false};
    const kind = clean(account.type, 60) || 'unknown';
    const eligible = ['chatgpt', 'chatgptAuthTokens', 'agentIdentity', 'personalAccessToken'].includes(kind);
    return {kind, label: clean(account.email || account.name, 160) || (eligible ? 'Codex account' : kind === 'apiKey' ? 'API key' : 'Other provider'),
        plan: clean(account.planType, 60) || null, eligible};
}

function micros(value) {
    const parsed = count(value);
    if (parsed === null) return null;
    return `${Math.floor(parsed / 1000000)}${parsed % 1000000 ? `.${String(parsed % 1000000).padStart(6, '0').replace(/0+$/, '')}` : ''}`;
}

export function normalizeActivity(response) {
    if (!object(response) || !object(response.summary) && !object(response.threadUsage))
        throw new Error('Codex returned an unrecognized activity response.');
    const summary = Object.fromEntries(['lifetimeTokens', 'peakDailyTokens', 'longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays']
        .map(key => [key, count(response.summary?.[key])]));
    const daily = (Array.isArray(response.dailyUsageBuckets) ? response.dailyUsageBuckets : [])
        .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item?.startDate) &&
            Number.isFinite(Date.parse(item.startDate)) && new Date(item.startDate).toISOString().slice(0, 10) === item.startDate && count(item.tokens) !== null)
        .map(item => ({date: item.startDate, tokens: item.tokens}))
        .sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
    const source = response.threadUsage;
    const thread = object(source) ? {id: clean(source.threadId, 100), credits: micros(source.estimatedUsageCreditsMicros),
        costUsd: micros(source.estimatedUsageUsdMicros), groups: (Array.isArray(source.groups) ? source.groups : [])
            .filter(object).slice(0, 100).map(group => ({model: clean(group.model, 100) || null,
                effort: clean(group.reasoningEffort, 40) || null, speed: clean(group.speed, 40) || null,
                inputTokens: count(group.inputTokens), cachedInputTokens: count(group.cachedInputTokens),
                outputTokens: count(group.outputTokens), totalTokens: count(group.totalTokens),
                credits: micros(group.estimatedUsageCreditsMicros)}))} : null;
    return {summary, daily, thread};
}

export function normalizeSessions(response) {
    if (!object(response) || !Array.isArray(response.data)) throw new Error('Codex returned an unrecognized session response.');
    return response.data.filter(item => object(item) && typeof item.id === 'string').slice(0, 10).map(item => {
        const cwd = clean(item.cwd, 500);
        const project = cwd.split('/').filter(Boolean).at(-1) || 'Session';
        const id = clean(item.id, 100);
        return {id, title: clean(item.name, 150) || `${project} · ${id.slice(0, 8)}`, project, cwd,
            model: clean(item.model, 100) || null, reasoning: clean(item.reasoningEffort, 40) || null,
            updatedAt: timestamp(item.updatedAt), source: typeof item.source === 'string' ? clean(item.source, 50) : null};
    });
}

export function formatCount(value) {
    return count(value) === null ? 'Unavailable' : new Intl.NumberFormat(undefined, {notation: 'compact', maximumFractionDigits: 1}).format(value);
}

export function formatReset(value, now = Date.now()) {
    if (timestamp(value) === null) return null;
    if (value * 1000 <= now) return 'Reset reached · awaiting refresh';
    const minutes = Math.ceil((value * 1000 - now) / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    const relative = days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
    const absolute = new Date(value * 1000).toLocaleString(undefined, {
        ...(days ? {weekday: 'short'} : {}), hour: '2-digit', minute: '2-digit',
    });
    return `Resets in ${relative} · ${absolute}`;
}

export function ageLabel(value, now = Date.now()) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not fetched';
    const seconds = Math.max(0, Math.floor((now - value) / 1000));
    if (seconds < 60) return 'Updated just now';
    if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `Updated ${Math.floor(seconds / 3600)}h ago`;
    return `Updated ${Math.floor(seconds / 86400)}d ago`;
}
