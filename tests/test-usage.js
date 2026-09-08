import GLib from 'gi://GLib';

function assert(ok, message) { if (!ok) throw new Error(message); }
function equal(actual, expected, message) { assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`); }
const usage = await import('../usage.js').catch(() => ({}));
assert(typeof usage.normalizeQuotas === 'function', 'Codex quota normalization is implemented');
const {normalizeQuotas, normalizeAccount, normalizeActivity, normalizeSessions, clean, formatReset} = usage;
const window = {usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000};
const snapshot = {limitId: 'codex', primary: window, secondary: {...window, windowDurationMins: 10080, usedPercent: 0}, planType: 'pro', credits: {hasCredits: true, unlimited: false, balance: '12.500'}};
let data = normalizeQuotas({rateLimits: snapshot});
equal(data.windows.map(x => [x.durationMinutes, x.usedPercent, x.remainingPercent]), [[300,25,75],[10080,0,100]], 'explicit zero survives');
assert(data.credits[0].balance === '12.500', 'credit text retains units/precision');
data = normalizeQuotas({rateLimits: snapshot, rateLimitsByLimitId: {codex: {...snapshot,primary: null}, model_bucket: {limitName:'New model',primary:{...window,windowDurationMins:15}}}, rateLimitResetCredits:{availableCount:0}});
equal(data.windows.map(x => x.durationMinutes), [10080,15], 'multi-bucket response is authoritative');
assert(data.resetCredits.availableCount === 0, 'zero reset credits preserved');
assert(data.windows[0].id !== data.windows[1].id, 'bucket/window identities distinct');
const missing = normalizeQuotas({rateLimits: {limitId:'codex', primary:{usedPercent:null,windowDurationMins:300},secondary:{usedPercent:'25'}}});
equal(missing.windows, [], 'missing and numeric strings do not become invented percentages');
equal(normalizeQuotas({rateLimitsByLimitId:{}}).windows, [], 'empty legitimate response has no windows');
let malformed = false;
try { normalizeQuotas({surprise:true}); } catch { malformed = true; }
assert(malformed, 'malformed payload rejected instead of replacing cached values');
assert(normalizeQuotas({rateLimits:{primary:{...window,usedPercent:150}}}).windows[0].remainingPercent === 0, 'over-limit bar bounded');
assert(normalizeAccount({account:{type:'chatgpt',email:'a@example.test',planType:'pro'}}).eligible, 'ChatGPT account supported');
assert(!normalizeAccount({account:{type:'apiKey'}}).eligible, 'API billing not represented as ChatGPT quota');
assert(!normalizeAccount({account:null}).eligible, 'no login handled');
const activity = normalizeActivity({summary:{lifetimeTokens:0,peakDailyTokens:null,currentStreakDays:Number.MAX_SAFE_INTEGER+1},dailyUsageBuckets:[{startDate:'2026-09-08',tokens:0},{startDate:'bad',tokens:1}],threadUsage:{threadId:'thread-a',estimatedUsageCreditsMicros:1250000,estimatedUsageUsdMicros:250000,groups:[]}});
assert(activity.summary.lifetimeTokens === 0 && activity.summary.peakDailyTokens === null && activity.summary.currentStreakDays === null, 'counts retain missing/unsafe distinctions');
equal(activity.daily, [{date:'2026-09-08',tokens:0}], 'daily data validates dates and zero');
equal([activity.thread.credits,activity.thread.costUsd], ['1.25','0.25'], 'micros converted only from explicit values');
assert(normalizeActivity({summary:{}}).thread === null, 'no fabricated thread billing');
const sessions = normalizeSessions({data:[{id:'abc',cwd:'/home/u/project',name:null,preview:'SECRET PROMPT',model:'gpt-6',reasoningEffort:'high',updatedAt:3},{id:'def',cwd:'/tmp/repo',name:'\u001b[31mhostile\u202etitle',updatedAt:4}]});
assert(sessions[0].title.includes('project') && !JSON.stringify(sessions).includes('SECRET PROMPT'), 'session preview content discarded');
assert(!sessions[1].title.includes('\u001b') && !sessions[1].title.includes('\u202e'), 'untrusted session label sanitized');
assert(clean('a\nb\u202e') === 'ab', 'control stripping');
assert(formatReset(null) === null, 'unknown reset is not the Unix epoch');
assert(formatReset(100,101000).includes('refresh'), 'expired reset does not fabricate a new window');
print('usage checks passed');
