// Opt-in authenticated reads only. Prints availability, never credentials or prompts.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {CodexClient} from '../app-server.js';
import {resolveCodex, resolveHome} from '../files.js';
import {normalizeAccount, normalizeQuotas, normalizeActivity, normalizeSessions} from '../usage.js';

if (!ARGV.includes('--live')) throw new Error('Pass --live to read the existing Codex account.');
const client = new CodexClient({executable: await resolveCodex(), home: resolveHome()});
function children(pid) {
    try {
        const text = new TextDecoder().decode(GLib.file_get_contents(`/proc/${pid}/task/${pid}/children`)[1]);
        return text.trim().split(/\s+/).filter(Boolean).flatMap(child => [child, ...children(child)]);
    } catch { return []; }
}
let pids = [];
const output = {};
try {
    await client.start();
    output.version = client.version;
    const account = normalizeAccount(await client.request('account/read', {refreshToken:false}));
    output.account = {kind:account.kind,plan:account.plan,eligible:account.eligible};
    if (account.eligible) {
        try {
            const quotas = normalizeQuotas(await client.request('account/rateLimits/read'));
            output.quotas = quotas.windows.map(x => ({bucket:x.bucketId,minutes:x.durationMinutes,used:x.usedPercent,remaining:x.remainingPercent,resetsAt:x.resetsAt}));
            output.creditBuckets = quotas.credits.length;
            output.resetCreditsAvailable = quotas.resetCredits !== null;
        } catch (error) { output.quotaError = {code:error.code??null,kind:/429/.test(error.message)?'rate-limited':/401|403|auth/i.test(error.message)?'authorization':'request-failed'}; }
        try {
            const activity = normalizeActivity(await client.request('account/usage/read'));
            output.activity = {availableSummaryFields:Object.keys(activity.summary).filter(x=>activity.summary[x]!==null),days:activity.daily.length};
        } catch (error) { output.activityError = {code:error.code??null}; }
    }
    try {
        const sessions = normalizeSessions(await client.request('thread/list',{limit:10,sortKey:'updated_at',useStateDbOnly:true}));
        output.sessions = {count:sessions.length,withModel:sessions.filter(x=>x.model).length,withReasoning:sessions.filter(x=>x.reasoning).length};
        if (account.eligible && sessions.length) {
            try {
                const detail = normalizeActivity(await client.request('account/usage/read',{threadId:sessions[0].id}));
                output.threadUsage = {available:detail.thread!==null,groups:detail.thread?.groups.length??0,dollarEstimate:detail.thread?.costUsd!==null && detail.thread?.costUsd!==undefined};
            } catch (error) { output.threadUsageError = {code:error.code??null}; }
        }
    } catch (error) { output.sessionsError = {code:error.code??null}; }
    const pid = client._session.process.get_identifier();
    pids = [pid, ...children(pid)];
} finally {
    await client.stop();
    output.remainingOwnedProcesses = pids.filter(pid=>Gio.File.new_for_path(`/proc/${pid}`).query_exists(null)).length;
    print(JSON.stringify(output));
    if (output.remainingOwnedProcesses) throw new Error('Owned app-server processes survived shutdown');
}
