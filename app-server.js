// Owns one Codex app-server process. No sessions/threads are created here.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MAX_LINE_BYTES = 4 * 1024 * 1024;

function io(object, method, finish, ...args) {
    return new Promise((resolve, reject) => object[method](...args, (source, result) => {
        try {
            resolve(source[finish](result));
        } catch (error) {
            reject(error);
        }
    }));
}

async function close(stream) {
    try {
        await io(stream, 'close_async', 'close_finish', GLib.PRIORITY_DEFAULT, null);
    } catch (_) {
        // A cancelled/failed pipe can already be closed during shutdown.
    }
}

export class RpcError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'RpcError';
        this.code = code;
    }
}

export class CodexClient {
    constructor({executable, home, timeoutMs = 20000, onNotification = () => {}, onExit = () => {}}) {
        this._executable = executable;
        this._home = home;
        this._timeoutMs = timeoutMs;
        this._onNotification = onNotification;
        this._onExit = onExit;
        this._session = null;
        this._startPromise = null;
        this._version = null;
    }

    get running() {
        return Boolean(this._session?.ready && !this._session.stopping);
    }

    get version() {
        return this._version;
    }

    start() {
        if (this._session?.stopping)
            return Promise.reject(new Error('Codex app-server stopped'));
        if (!this._startPromise) {
            const promise = this._launch();
            this._startPromise = promise;
            promise.catch(() => {
                if (this._startPromise === promise && !this._session)
                    this._startPromise = null;
            });
        }
        return this._startPromise;
    }

    async request(method, params = {}) {
        await this.start();
        const session = this._session;
        if (!session || session.stopping)
            throw new Error('Codex app-server stopped');
        return this._request(session, method, params);
    }

    stop() {
        if (this._session)
            return this._shutdown(this._session, new Error('Codex app-server stopped'), false);
        this._startPromise = null;
        return Promise.resolve();
    }

    async _launch() {
        if (typeof this._executable !== 'string' || !GLib.path_is_absolute(this._executable) ||
            typeof this._home !== 'string' || !GLib.path_is_absolute(this._home))
            throw new Error('Codex executable and home must be absolute paths');
        if (!Number.isFinite(this._timeoutMs) || this._timeoutMs <= 0)
            throw new Error('Codex request timeout must be positive');
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE,
        });
        launcher.setenv('CODEX_HOME', this._home, true);
        launcher.setenv('PATH', `${GLib.path_get_dirname(this._executable)}:${GLib.getenv('PATH') || '/usr/bin:/bin'}`, true);
        launcher.set_cwd(GLib.get_home_dir());
        let process;
        try {
            process = launcher.spawnv([this._executable, 'app-server', '--listen', 'stdio://']);
        } catch (_) {
            throw new Error('Could not launch the configured Codex executable');
        } finally {
            launcher.close();
        }
        const session = {
            process,
            input: process.get_stdin_pipe(),
            output: process.get_stdout_pipe(),
            cancellable: new Gio.Cancellable(),
            pending: new Map(),
            nextId: 1,
            writeTail: Promise.resolve(),
            ready: false,
            stopping: false,
            exited: false,
        };
        this._session = session;
        this._version = null;
        // Never cancel wait_async: stop() must reap the process even after I/O cancellation.
        session.waitPromise = io(process, 'wait_async', 'wait_finish', null);
        session.waitPromise.then(() => {
            session.exited = true;
            if (!session.stopping)
                this._shutdown(session, new Error('Codex app-server exited unexpectedly'), true);
        }).catch(() => {
            if (!session.stopping)
                this._shutdown(session, new Error('Could not wait for Codex app-server'), true);
        });
        session.readPromise = this._read(session).catch(error => {
            if (!session.stopping)
                this._shutdown(session, error, true);
        });
        try {
            const result = await this._request(session, 'initialize', {
                clientInfo: {name: 'codex_usage_monitor', title: 'Codex Usage Monitor', version: '0.1.0'},
                capabilities: {experimentalApi: false},
            });
            await this._write(session, {method: 'initialized', params: {}});
            if (session.stopping)
                throw new Error('Codex app-server stopped');
            this._version = typeof result?.userAgent === 'string'
                ? result.userAgent.match(/^[^\s/]+\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/)?.[1] ?? null
                : null;
            session.ready = true;
            return result;
        } catch (error) {
            await this._shutdown(session, error, false);
            throw error;
        }
    }

    _request(session, method, params) {
        if (session.stopping)
            return Promise.reject(new Error('Codex app-server stopped'));
        if (typeof method !== 'string' || !method)
            return Promise.reject(new Error('Codex request method must be a nonempty string'));
        const id = session.nextId++;
        return new Promise((resolve, reject) => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timeoutMs, () => {
                session.pending.delete(id);
                reject(new Error('Codex app-server request timed out'));
                return GLib.SOURCE_REMOVE;
            });
            session.pending.set(id, {resolve, reject, timer});
            this._write(session, {id, method, params}).catch(error => {
                this._settle(session, id, error);
                if (!session.stopping)
                    this._shutdown(session, new Error('Could not write to Codex app-server'), true);
            });
        });
    }

    _write(session, message) {
        const operation = session.writeTail.then(async () => {
            if (session.stopping)
                throw new Error('Codex app-server stopped');
            if (Object.hasOwn(message, 'id') && !session.pending.has(message.id))
                return; // A queued request can time out before its write starts.
            const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
            // Unix pipes may block even an async write above Linux PIPE_BUF.
            for (let offset = 0; offset < bytes.length; offset += 4096) {
                await io(session.input, 'write_all_async', 'write_all_finish',
                    bytes.subarray(offset, offset + 4096), GLib.PRIORITY_DEFAULT, session.cancellable);
            }
        });
        session.writeTail = operation.catch(() => {});
        return operation;
    }

    _settle(session, id, error, result) {
        const pending = session.pending.get(id);
        if (!pending)
            return;
        session.pending.delete(id);
        GLib.Source.remove(pending.timer);
        if (error)
            pending.reject(error);
        else
            pending.resolve(result);
    }

    async _read(session) {
        let fragments = [];
        let length = 0;
        const decoder = new TextDecoder('utf-8', {fatal: true});
        while (!session.stopping) {
            const bytes = await io(session.output, 'read_bytes_async', 'read_bytes_finish',
                65536, GLib.PRIORITY_DEFAULT, session.cancellable);
            const data = bytes.toArray();
            if (data.length === 0)
                throw new Error('Codex app-server output closed unexpectedly');
            for (let offset = 0; offset < data.length;) {
                const newline = data.indexOf(10, offset);
                const end = newline === -1 ? data.length : newline;
                length += end - offset;
                if (length > MAX_LINE_BYTES)
                    throw new Error('Codex app-server response exceeded the size limit');
                fragments.push(data.subarray(offset, end));
                if (newline !== -1) {
                    const line = new Uint8Array(length);
                    let position = 0;
                    for (const fragment of fragments) {
                        line.set(fragment, position);
                        position += fragment.length;
                    }
                    fragments = [];
                    length = 0;
                    if (line.length) {
                        let message;
                        try {
                            message = JSON.parse(decoder.decode(line));
                        } catch (_) {
                            throw new Error('Codex app-server returned invalid JSON');
                        }
                        this._dispatch(session, message);
                    }
                }
                offset = end + (newline === -1 ? 0 : 1);
            }
        }
    }

    _dispatch(session, message) {
        if (session.stopping)
            return;
        if (!message || typeof message !== 'object' || Array.isArray(message))
            throw new Error('Codex app-server returned an invalid message');
        if (typeof message.method === 'string') {
            // This read-only client cannot approve server requests or start work.
            if (!Object.hasOwn(message, 'id')) {
                try {
                    this._onNotification(message.method, message.params ?? {});
                } catch (_) {
                    // A consumer callback must not damage the protocol reader.
                }
            }
            return;
        }
        if (!session.pending.has(message.id))
            return; // Late, duplicate, and unknown responses have no owner.
        if (Object.hasOwn(message, 'error')) {
            if (typeof message.error?.code !== 'number' || typeof message.error?.message !== 'string')
                throw new Error('Codex app-server returned an invalid RPC error');
            this._settle(session, message.id, new RpcError(message.error.code, message.error.message));
        } else if (Object.hasOwn(message, 'result')) {
            this._settle(session, message.id, null, message.result);
        } else {
            throw new Error('Codex app-server returned an invalid response');
        }
    }

    _exitedWithin(session, ms) {
        if (session.exited)
            return Promise.resolve(true);
        return new Promise(resolve => {
            let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                timer = 0;
                resolve(false);
                return GLib.SOURCE_REMOVE;
            });
            session.waitPromise.finally(() => {
                if (timer) {
                    GLib.Source.remove(timer);
                    timer = 0;
                }
                resolve(true);
            }).catch(() => {});
        });
    }

    _shutdown(session, error, unexpected) {
        if (session.stopping)
            return session.shutdownPromise;
        session.stopping = true;
        session.ready = false;
        session.cancellable.cancel();
        for (const id of session.pending.keys())
            this._settle(session, id, error);
        session.shutdownPromise = (async () => {
            await session.writeTail;
            await close(session.input);
            // EOF allows Codex and the NVM launcher to reap their own children.
            if (!await this._exitedWithin(session, 250)) {
                session.process.send_signal(15); // The native Node launcher forwards SIGTERM.
                if (!await this._exitedWithin(session, 500))
                    session.process.force_exit();
            }
            await session.waitPromise.catch(() => {});
            await session.readPromise;
            await close(session.output);
            if (this._session === session) {
                this._session = null;
                this._startPromise = null;
                this._version = null;
            }
            if (unexpected) {
                try {
                    this._onExit(error);
                } catch (_) {
                    // Never log service payloads or consumer callback failures.
                }
            }
        })();
        return session.shutdownPromise;
    }
}
