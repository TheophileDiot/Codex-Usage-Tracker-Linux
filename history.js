// History and alert foundations adapted from Claude Usage Tracker for Linux (MIT).
const HOUR = 3600000;
const INTERVAL = 300000;
const RETENTION = 7 * 24 * HOUR;
const LIMIT = RETENTION / INTERVAL;
const percent = n => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;

export function sanitizeHistory(raw, now = Date.now()) {
    return {version: 1, samples: (Array.isArray(raw?.samples) ? raw.samples : [])
        .filter(sample => Number.isFinite(sample?.at) && sample.at >= now - RETENTION && sample.at <= now &&
            sample.metrics && typeof sample.metrics === 'object' && !Array.isArray(sample.metrics))
        .map(sample => ({at: sample.at, metrics: Object.fromEntries(Object.entries(sample.metrics)
            .slice(0, 200).filter(([id, value]) => id.length <= 700 && percent(value) !== null)
            .map(([id, value]) => [id, percent(value)]))}))
        .sort((a, b) => a.at - b.at).slice(-LIMIT)};
}

export function addHistorySample(raw, windows, now = Date.now()) {
    const history = sanitizeHistory(raw, now);
    const previous = history.samples.at(-1);
    if (previous && now - previous.at < INTERVAL || windows.length === 0) return {history, changed: false};
    history.samples.push({at: now, metrics: Object.fromEntries(windows.map(window => [window.id, window.usedPercent]))});
    history.samples = history.samples.slice(-LIMIT);
    return {history, changed: true};
}

export function hourlySeries(raw, id, now = Date.now()) {
    const values = Array(24).fill(null);
    for (const sample of sanitizeHistory(raw, now).samples) {
        const age = now - sample.at;
        if (age >= 24 * HOUR) continue;
        const value = percent(sample.metrics[id]);
        if (value !== null) values[23 - Math.floor(age / HOUR)] = value;
    }
    return values;
}

export function notificationTransition(previous, window, thresholds) {
    const resetsAt = window?.resetsAt ?? null;
    const reached = [...new Set(thresholds)].filter(n => Number.isInteger(n) && n > 0 && n <= 100 && window?.usedPercent >= n).sort((a, b) => a - b);
    const highest = reached.at(-1) || 0;
    if (!previous || previous.resetsAt !== resetsAt)
        return {state: {resetsAt, lastThreshold: highest}, threshold: null};
    const threshold = reached.filter(n => n > (previous.lastThreshold || 0)).at(-1) || null;
    return {state: {resetsAt, lastThreshold: threshold || previous.lastThreshold || 0}, threshold};
}
