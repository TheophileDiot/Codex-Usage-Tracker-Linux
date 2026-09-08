import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
function assert(ok,message) { if (!ok) throw new Error(message); }
const scratch=GLib.dir_make_tmp('codex-monitor-test-XXXXXX');
GLib.setenv('XDG_STATE_HOME',scratch,true);
const module=await import('../monitor.js').catch(()=>({}));
assert(typeof module.UsageMonitor === 'function','UsageMonitor controller implemented');
const {UsageMonitor}=module;
const wait=ms=>new Promise(resolve=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));
class Server {
    constructor() { this.version='0.153.4';this.identity='one';this.fail=false;this.calls=[];this.stopped=false;this.hold=null; }
    async start() { this.stopped=false;return {}; }
    async stop() { this.stopped=true; }
    async request(method,params={}) {
        this.calls.push({method,params});
        if(method==='account/read')return {account:{type:'chatgpt',email:`${this.identity}@example.test`,planType:'pro'}};
        if(method==='account/rateLimits/read') {
            if(this.hold)await this.hold;
            if(this.fail)throw new Error('HTTP429 body contains private details');
            return {accountId:this.identity,rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:2000000000}}};
        }
        if(method==='thread/list')return {data:[{id:'t1',name:'Example',cwd:'/tmp/project',updatedAt:2}]};
        if(method==='account/usage/read')return {summary:{lifetimeTokens:123},threadUsage:params.threadId?{threadId:params.threadId,estimatedUsageCreditsMicros:1000000,groups:[]}:null};
        throw new Error('unexpected method');
    }
}
const server=new Server();let updates=0;let lastState=null;
const monitor=new UsageMonitor({executable:'/usr/bin/false',home:scratch,client:server,onUpdate:state=>{assert(state!==lastState,'new shallow state snapshot');lastState=state;updates++;}});
try {
    await monitor.start();
    assert(monitor.state.quota.windows[0].usedPercent===25 && monitor.state.activity.summary.lifetimeTokens===123,'initial quotas/activity');
    const activityBefore=server.calls.filter(x=>x.method==='account/usage/read').length;
    await monitor.loadActivity();
    assert(server.calls.filter(x=>x.method==='account/usage/read').length===activityBefore,'activity tab uses cache');
    await monitor.loadActivity({force:true});
    assert(server.calls.filter(x=>x.method==='account/usage/read').length===activityBefore+1,'manual activity refresh bypasses cache');
    const quota=monitor.state.quota;const key=monitor.state.accountKey;
    server.fail=true;await monitor.refresh();
    assert(monitor.state.quota===quota && monitor.state.quotaError,'last good quota on failure');
    assert(!JSON.stringify(monitor.state).includes('private details'),'raw service errors not exposed');
    server.fail=false;server.identity='two';await monitor.refresh();
    assert(monitor.state.accountKey!==key && monitor.state.history.samples.length===1,'account changes cannot mix histories');
    await monitor.loadSessions();
    assert(monitor.state.sessions[0].id==='t1','recent metadata fetched');
    assert(server.calls.find(x=>x.method==='thread/list').params.useStateDbOnly===true,'no scan-and-repair');
    await monitor.loadSessionUsage('t1');
    assert(monitor.state.detail.thread.id==='t1','optional detail');
    let release;server.hold=new Promise(resolve=>{release=resolve;});
    const before=server.calls.filter(x=>x.method==='account/rateLimits/read').length;
    const p=monitor.refresh(),q=monitor.refresh();await wait(10);release();await Promise.all([p,q]);
    assert(server.calls.filter(x=>x.method==='account/rateLimits/read').length===before+1,'coalesced requests');
    server.hold=new Promise(resolve=>{release=resolve;});
    const pending=monitor.refresh();await wait(10);await monitor.stop();const after=updates;release();await pending;
    assert(updates===after && server.stopped,'late work ignored after stop');
    assert(!server.calls.some(x=>/start|resume|write|consume|login/.test(x.method)),'monitor issues read methods only');
} finally { await monitor.stop(); }
// A missing quota key must not collapse distinct account lifetimes.
const changing = new Server(); changing.fail = true;
let releaseActivity;
const delayedActivity = new Promise(resolve => { releaseActivity = resolve; });
const request = changing.request.bind(changing);
changing.request = async (method, params) => {
    if (method === 'account/usage/read' && changing.identity === 'one') return delayedActivity;
    return request(method, params);
};
const switching = new UsageMonitor({executable:'/usr/bin/false',home:scratch,client:changing});
try {
    await switching.refresh();
    const old = switching.loadActivity();
    changing.identity='two';await switching.refresh();
    releaseActivity({summary:{lifetimeTokens:111}});await old;await wait(5);
    assert(switching.state.activity?.summary.lifetimeTokens !== 111,'old account activity discarded even when both quota keys are null');
    await switching.loadActivity();
    assert(switching.state.activity?.summary.lifetimeTokens === 123,'new account can fetch fresh activity');
} finally {await switching.stop();}
// Only the latest pending selection should follow an active detail request.
const selecting=new Server();let releaseDetail;let active=0,peak=0,detailCalls=0;
const detailGate=new Promise(resolve=>{releaseDetail=resolve;});
const normal=selecting.request.bind(selecting);
selecting.request=async(method,params={})=>{
    if(method==='account/usage/read' && params.threadId){detailCalls++;peak=Math.max(peak,++active);await detailGate;active--;}
    return normal(method,params);
};
const bounded=new UsageMonitor({executable:'/usr/bin/false',home:scratch,client:selecting});
try {
    await bounded.start();await bounded.loadSessions();
    const requests=Array.from({length:40},()=>bounded.loadSessionUsage('t1'));
    await wait(5);releaseDetail();await Promise.all(requests);
    assert(peak===1 && detailCalls<=2,'rapid selection is bounded to active plus latest queued request');
} finally {await bounded.stop();}
// Test fixture cleanup only.
function remove(file){if(file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,null)===Gio.FileType.DIRECTORY){const e=file.enumerate_children('standard::name',Gio.FileQueryInfoFlags.NONE,null);let x;while((x=e.next_file(null)))remove(file.get_child(x.get_name()));e.close(null);}file.delete(null);}
remove(Gio.File.new_for_path(scratch));
print('monitor checks passed');
