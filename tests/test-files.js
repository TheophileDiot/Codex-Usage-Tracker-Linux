import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
function assert(ok,message) { if (!ok) throw new Error(message); }
const files = await import('../files.js').catch(()=>({}));
assert(typeof files.writeJson === 'function','Private asynchronous storage is implemented');
const dir=GLib.dir_make_tmp('codex-files-test-XXXXXX');
const path=GLib.build_filenamev([dir,'nested','state.json']);
assert(await files.loadJson(path) === null,'missing file returns null');
await files.writeJson(path,{value:1});
assert((await files.loadJson(path)).value === 1,'round trip');
const info=Gio.File.new_for_path(path).query_info('unix::mode',Gio.FileQueryInfoFlags.NONE,null);
assert((info.get_attribute_uint32('unix::mode') & 0o777) === 0o600,'private file mode');
assert(files.statePath('history.json','/a') !== files.statePath('history.json','/b'),'home isolation');
let rejected=false;
try { files.statePath('../escape','/a'); } catch { rejected=true; }
assert(rejected,'state file names cannot traverse');
const executable=await files.resolveCodex('/usr/bin/gjs');
assert(executable === '/usr/bin/gjs','explicit executable path resolved');
const cancel=new Gio.Cancellable(); cancel.cancel();
rejected=false;
try { await files.writeJson(path,{value:2},cancel); } catch { rejected=true; }
assert(rejected && (await files.loadJson(path)).value===1,'cancelled write preserves previous file');
Gio.File.new_for_path(path).delete(null);
Gio.File.new_for_path(GLib.path_get_dirname(path)).delete(null);
Gio.File.new_for_path(dir).delete(null);
print('file checks passed');
