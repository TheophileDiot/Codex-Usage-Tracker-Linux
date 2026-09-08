import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}

let clientModule;
try {
    clientModule = await import('../app-server.js');
} catch (_) {
    // An absent implementation should fail as an explicit contract assertion.
}
assert(clientModule?.CodexClient, 'CodexClient must implement the app-server transport');
const {CodexClient, RpcError} = clientModule;
const executable = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('fake-server.py').get_path();
const clients = [];
const homes = [];

function delay(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function makeClient(mode = '', options = {}) {
    const home = GLib.dir_make_tmp('codex-client-test-XXXXXX');
    homes.push(home);
    GLib.file_set_contents(`${home}/fixture.json`, JSON.stringify({mode}));
    const client = new CodexClient({executable, home, timeoutMs: 1000, ...options});
    clients.push(client);
    return {client, home};
}

async function rejected(promise, text) {
    try {
        await promise;
    } catch (error) {
        assert(!text || error.message.toLowerCase().includes(text), `Expected ${text}, received ${error.message}`);
        return error;
    }
    throw new Error(`Expected rejection: ${text}`);
}

function assertReaped(home) {
    const file = Gio.File.new_for_path(`${home}/pid`);
    if (!file.query_exists(null))
        return; // An immediate stop may kill the child before its first instruction.
    const [, bytes] = file.load_contents(null);
    const pid = new TextDecoder().decode(bytes).trim();
    assert(!Gio.File.new_for_path(`/proc/${pid}`).query_exists(null), `Owned child ${pid} was not reaped`);
}

function countFds() {
    const directory = Gio.File.new_for_path('/proc/self/fd');
    const entries = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let count = 0;
    while (entries.next_file(null))
        count++;
    entries.close(null);
    return count;
}

async function stopped(client, home) {
    await Promise.all([client.stop(), client.stop()]);
    assert(!client.running, 'A stopped client must not report running');
    assertReaped(home);
}

try {
    const notifications = [];
    const exits = [];
    const {client, home} = makeClient('', {
        onNotification: (method, params) => notifications.push({method, params}),
        onExit: error => exits.push(error),
    });
    const starting = client.start();
    assert(client.start() === starting, 'Concurrent starts must share the same initialization');
    const autoRequest = client.request('echo', {message: 'réponse 🦊', nested: {value: 1}});
    const init = await starting;
    assert(init.userAgent.includes('/0.153.4'), 'start must return initialization result');
    assert(client.running && client.version === '0.153.4', 'Initialized client must expose actual CLI version');
    assert((await autoRequest).message === 'réponse 🦊', 'Fragmented Unicode response must survive decoding');
    assert(notifications[0].params.text === 'prêt 🦊', 'Fragmented notification must reach caller');
    assert(await client.start() === init, 'Already-started initialization must be idempotent');
    const info = await client.request('inspect');
    assert(info.home === home && info.path.split(':')[0] === GLib.path_get_dirname(executable), 'Selected CODEX_HOME and executable PATH must reach child');
    assert(info.cwd === GLib.get_home_dir(), 'App-server must not inherit an unrelated project cwd');
    assert(info.initializations === 1, 'Initialization must be sent only once');
    const results = await Promise.all([client.request('hold'), client.request('release')]);
    assert(results[0] === 'first' && results[1] === 'second', 'Concurrent responses must be matched by ID');
    assert(notifications.some(value => value.method === 'test/batch'), 'Several records in one read must all be dispatched');
    const rpcError = await rejected(client.request('fail'), 'invalid parameter');
    assert(rpcError instanceof RpcError && rpcError.code === -32602, 'RPC errors must retain code and message');
    assert((await client.request('echo', {ok: true})).ok, 'An RPC error must not break the transport');
    const unsolicited = await client.request('server/request');
    assert(unsolicited === 'unsolicited request sent', 'Unsolicited server request must not be treated as a client response');
    assert(!notifications.some(value => value.method.includes('requestApproval')), 'Server requests must never trigger notification callbacks');
    await stopped(client, home);
    assert(exits.length === 0, 'Intentional stops must not fire onExit');
    const baselineFds = countFds();

    const timeout = makeClient('', {timeoutMs: 300});
    await timeout.client.start();
    await rejected(timeout.client.request('never'), 'timed out');
    assert((await timeout.client.request('echo', {ok: true})).ok, 'Request timeout must leave client usable');
    await rejected(timeout.client.request('late'), 'timed out');
    await delay(250);
    assert((await timeout.client.request('echo', {ok: true})).ok, 'Late response must be ignored without poisoning later requests');
    await stopped(timeout.client, timeout.home);

    for (const method of ['exit', 'oversize', 'malformed']) {
        const errors = [];
        const fixture = makeClient('', {onExit: error => errors.push(error)});
        await fixture.client.start();
        const pending = rejected(fixture.client.request('never'));
        await rejected(fixture.client.request(method));
        await pending;
        await stopped(fixture.client, fixture.home);
        assert(errors.length === 1, `${method}: unexpected failure must notify exactly once`);
    }

    for (const mode of ['hang-init', 'exit-init', 'fail-init']) {
        const fixture = makeClient(mode, {timeoutMs: 200});
        await rejected(fixture.client.start());
        await stopped(fixture.client, fixture.home);
    }

    const startup = makeClient('hang-init');
    const startupRejection = rejected(startup.client.start(), 'stopped');
    const startupRequest = rejected(startup.client.request('echo'), 'stopped');
    await delay(40);
    await stopped(startup.client, startup.home);
    await Promise.all([startupRejection, startupRequest]);

    const duringRequest = makeClient();
    await duringRequest.client.start();
    const cancelledRequest = rejected(duringRequest.client.request('never'), 'stopped');
    await delay(20);
    await stopped(duringRequest.client, duringRequest.home);
    await cancelledRequest;

    const blocked = makeClient('ignore-term');
    await blocked.client.start();
    const blockedRequest = rejected(blocked.client.request('block'), 'stopped');
    await delay(30);
    const queuedWrites = Array.from({length: 6}, () => rejected(
        blocked.client.request('echo', {large: 'x'.repeat(131072)}), 'stopped'));
    await delay(20);
    await stopped(blocked.client, blocked.home);
    await Promise.all([blockedRequest, ...queuedWrites]);

    const notices = [];
    const fromCallback = makeClient('', {onNotification: method => {
        notices.push(method);
        if (method === 'stop-now')
            fromCallback.client.stop();
    }});
    await fromCallback.client.start();
    await rejected(fromCallback.client.request('notices'), 'stopped');
    await stopped(fromCallback.client, fromCallback.home);
    assert(!notices.includes('after-stop'), 'Buffered notifications must not escape after stop');

    for (let i = 0; i < 3; i++) {
        const immediate = makeClient();
        const cancelledStart = rejected(immediate.client.start(), 'stopped');
        await stopped(immediate.client, immediate.home);
        await cancelledStart;
    }

    const missing = new CodexClient({executable: '/no/such/codex', home});
    clients.push(missing);
    await rejected(missing.start());
    await missing.stop();
    assert(countFds() <= baselineFds, 'Stopped clients must not leak pipe file descriptors');
    print('Client protocol, cancellation, framing, timeout and child-reaping checks passed');
} finally {
    await Promise.all(clients.map(client => client.stop()));
    for (const home of homes) {
        assertReaped(home);
        for (const name of ['fixture.json', 'pid']) {
            const file = Gio.File.new_for_path(`${home}/${name}`);
            if (file.query_exists(null))
                file.delete(null);
        }
        Gio.File.new_for_path(home).delete(null);
    }
}
