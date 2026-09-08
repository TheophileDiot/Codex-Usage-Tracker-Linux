"""Isolated GNOME 46 rendering/lifecycle test; requires a private D-Bus socket.

The test uses synthetic account data and temporary settings, never the active desktop.
"""
import ast
import contextlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time

project = pathlib.Path(__file__).resolve().parents[1]
(project/'.work').mkdir(exist_ok=True)
uuid = 'codex-usage-monitor@theophilediot.github.io'
driver = 'codex-monitor-test-driver@local'
if '--private-session' not in sys.argv:
    env = dict(os.environ)
    env.pop('DBUS_SESSION_BUS_ADDRESS', None)
    with tempfile.TemporaryDirectory(prefix='codex-shell-test-') as scratch:
        env['CODEX_MONITOR_TEST_ROOT']=scratch
        with open(project/'.work/private-bus.log','w') as log:
            process=subprocess.Popen(['dbus-run-session', '--', sys.executable, __file__, '--private-session'],env=env,stderr=log,start_new_session=True)
            try:
                result=process.wait(timeout=60)
            finally:
                # Reap this test session's activated helpers before removing runtime mounts.
                try:os.killpg(process.pid,signal.SIGTERM)
                except ProcessLookupError:pass
                time.sleep(.5)
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait(timeout=5)
                time.sleep(.2)
    raise SystemExit(result)

with contextlib.nullcontext(os.environ['CODEX_MONITOR_TEST_ROOT']) as name:
    scratch = pathlib.Path(name)
    env = dict(os.environ)
    for key, sub in [('XDG_CONFIG_HOME','config'),('XDG_DATA_HOME','data'),('XDG_CACHE_HOME','cache'),('XDG_STATE_HOME','state'),('XDG_RUNTIME_DIR','runtime')]:
        target = scratch/sub;target.mkdir(mode=0o700);env[key]=str(target)
    env.update(GSETTINGS_BACKEND='keyfile',GSETTINGS_SCHEMA_DIR=str(project/'schemas'),LIBGL_ALWAYS_SOFTWARE='1',XDG_SESSION_TYPE='wayland',XDG_CURRENT_DESKTOP='GNOME',NO_AT_BRIDGE='1',GIO_USE_VFS='local',GVFS_DISABLE_FUSE='1')
    exts=scratch/'data/gnome-shell/extensions';exts.mkdir(parents=True)
    helper=exts/driver;helper.mkdir()
    (helper/'metadata.json').write_text(json.dumps({'uuid':driver,'name':'Isolated test driver','description':'Only inside private smoke-test compositor','shell-version':['46']}))
    (helper/'extension.js').write_text("import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js'; export default class extends Extension {enable(){global.context.unsafe_mode=true;} disable(){global.context.unsafe_mode=false;}}")
    (scratch/'codex').mkdir()
    def command(args,check=True):
        return subprocess.run(args,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15,check=check)
    # D-Bus activated helpers must use the same temporary settings as the compositor.
    command(['dbus-update-activation-environment', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
             'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'GSETTINGS_BACKEND',
             'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'GIO_USE_VFS', 'GVFS_DISABLE_FUSE'])
    archive=project/'dist'/f'{uuid}.shell-extension.zip'
    if not archive.exists():raise RuntimeError('Build the extension package with make pack first')
    command(['gnome-extensions','install','--force',str(archive)])
    command(['gsettings','set','org.gnome.shell','enabled-extensions',str([driver,uuid])])
    command(['gsettings','set','org.gnome.shell','disable-user-extensions','false'])
    command(['gsettings','set','org.gnome.shell','welcome-dialog-last-shown-version',"'46.0'"],False)
    command(['gsettings','set','org.gnome.desktop.interface','color-scheme',"'prefer-dark'"])
    command(['gsettings','set','org.gnome.shell.extensions.codex-usage-monitor','codex-executable',str(project/'tests/fixture-server.py')])
    command(['gsettings','set','org.gnome.shell.extensions.codex-usage-monitor','codex-home',str(scratch/'codex')])
    evidence=project/'.work/ui';evidence.mkdir(exist_ok=True)
    log=open(evidence/'shell.log','w')
    shell=subprocess.Popen(['gnome-shell','--headless','--wayland','--no-x11','--virtual-monitor','1280x900','--sm-disable'],env=env,stdout=log,stderr=subprocess.STDOUT)
    def evaluate(code):
        result=command(['gdbus','call','--session','--dest','org.gnome.Shell','--object-path','/org/gnome/Shell','--method','org.gnome.Shell.Eval',code],False)
        if result.returncode:return None
        raw=result.stdout.replace('(true,','(True,',1).replace('(false,','(False,',1)
        ok,value=ast.literal_eval(raw)
        if not ok:raise RuntimeError(value or 'Eval not ready')
        return json.loads(value) if value else None
    try:
        deadline=time.monotonic()+25
        while time.monotonic()<deadline:
            if shell.poll() is not None:raise RuntimeError('headless shell exited early')
            try:
                ready=evaluate(f'Main.panel.statusArea[{json.dumps(uuid)}]?._state?.quota?.windows?.length || 0')
                if ready:break
            except RuntimeError:pass
            time.sleep(.3)
        else:raise RuntimeError('extension did not produce quota data')
        evaluate(f'global.monitorTestIndicator=Main.panel.statusArea[{json.dumps(uuid)}];Main.overview.hide();global.monitorTestIndicator.menu.open();true')
        evaluate('Main.messageTray.getSources().forEach(source=>source.destroy());true')
        time.sleep(.5)
        states={}
        # Exercise real keyboard events in this isolated compositor.
        evaluate("(async()=>{const {default:C}=await import('gi://Clutter');global.testKeyboard=C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE);global.monitorTestIndicator._tabButtons[0].grab_key_focus();global.testKeyboard.notify_keyval(0,C.KEY_Right,C.KeyState.PRESSED);global.testKeyboard.notify_keyval(0,C.KEY_Right,C.KeyState.RELEASED);return true;})()")
        time.sleep(.2)
        states['keyboardTab']=evaluate('global.monitorTestIndicator._tab')
        assert states['keyboardTab']==1,'Right arrow switches tabs using real keyboard input'
        for tab,name in enumerate(['overview','activity','sessions']):
            evaluate(f'global.monitorTestIndicator._selectTab({tab});true')
            time.sleep(.5)
            if tab==2:
                states['sessions']=evaluate('global.monitorTestIndicator._state.sessions.length')
            result=command(['gdbus','call','--session','--dest','org.gnome.Shell.Screenshot','--object-path','/org/gnome/Shell/Screenshot','--method','org.gnome.Shell.Screenshot.Screenshot','false','false',str(evidence/f'{name}.png')],False)
            print(name,result.stdout.strip() or result.stderr.strip())
            bounds=evaluate('(()=>{let a=global.monitorTestIndicator.menu.actor;let [x,y]=a.get_transformed_position();return [Math.floor(x),Math.floor(y),Math.ceil(a.width),Math.ceil(a.height)];})()')
            command(['gdbus','call','--session','--dest','org.gnome.Shell.Screenshot','--object-path','/org/gnome/Shell/Screenshot','--method','org.gnome.Shell.Screenshot.ScreenshotArea',*map(str,bounds),'false',str(evidence/f'{name}-popup.png')])
            if tab==0:
                tracks=evaluate("(()=>{let result=[];function walk(a){if(a.has_style_class_name?.('cum-track'))result.push({width:a.width,height:a.height,fillWidth:a.get_first_child().width,fillHeight:a.get_first_child().height});a.get_children().forEach(walk);}walk(global.monitorTestIndicator._content);return result;})()")
                print('quota tracks:',json.dumps(tracks))
                assert len(tracks)==3 and all(t['fillWidth']>0 and t['fillHeight']>0 for t in tracks),'Visible quota fills must receive an allocation'
                for track,remaining in zip(tracks,[66,38,82]):
                    assert abs(track['fillWidth']/track['width']*100-remaining)<1,'Quota fill must match percentage'
                assert not evaluate("global.monitorTestIndicator._content.get_parent().has_style_class_name('popup-inactive-menu-item')"),'Content must inherit normal theme foreground'
        evaluate("global.monitorTestIndicator._sessionButtons.get('demo-2').emit('clicked',1);true")
        time.sleep(.3)
        labels=evaluate("(()=>{let labels=[];function walk(a){if(typeof a.text==='string')labels.push(a.text);a.get_children().forEach(walk);}walk(global.monitorTestIndicator._page);return labels;})()")
        assert any('not available' in text for text in labels),'Successful absent session billing must finish as unavailable'
        assert not any('Reading optional' in text for text in labels),'No endless loading state after absent billing'
        states['absentBilling']='unavailable'
        # Verify scale-dependent geometry and theme changes on the real actors.
        evaluate('global.monitorTestIndicator._selectTab(0);global.monitorTestIndicator._theme.scale_factor=2;true')
        time.sleep(.4)
        scaled=evaluate("(()=>{let result=[];function walk(a){if(a.has_style_class_name?.('cum-track'))result.push({width:a.width,height:a.height,fillWidth:a.get_first_child().width,fillHeight:a.get_first_child().height});a.get_children().forEach(walk);}walk(global.monitorTestIndicator._content);return result;})()")
        assert all(t['height']==10 and t['fillHeight']==10 for t in scaled),'HiDPI doubles track height'
        for track,remaining in zip(scaled,[66,38,82]):assert abs(track['fillWidth']/track['width']*100-remaining)<1,'HiDPI retains quota proportions'
        states['hidpi']='passed'
        evaluate('global.monitorTestIndicator._theme.scale_factor=1;true')
        command(['gsettings','set','org.gnome.desktop.interface','color-scheme',"'prefer-light'"])
        time.sleep(.4)
        foreground=evaluate("global.monitorTestIndicator._content.get_theme_node().get_foreground_color().alpha")
        assert foreground==255,'Light preference retains full theme foreground opacity'
        states['lightTheme']='passed'
        states['panel']=evaluate('global.monitorTestIndicator._panelLabel.text')
        states['quotaWindows']=evaluate('global.monitorTestIndicator._state.quota.windows.length')
        states['bounds']=evaluate('({menu:global.monitorTestIndicator.menu.actor.get_allocation_box(),content:global.monitorTestIndicator._content.get_allocation_box()})')
        command(['gnome-extensions','disable',uuid])
        time.sleep(.6)
        states['disabled']=evaluate(f'!Main.panel.statusArea[{json.dumps(uuid)}]')
        command(['gnome-extensions','enable',uuid])
        time.sleep(.8)
        states['reenabled']=evaluate(f'Boolean(Main.panel.statusArea[{json.dumps(uuid)}]?._state?.quota)')
        print(json.dumps(states))
        assert states['quotaWindows']==3 and states['sessions']==3 and states['disabled'] and states['reenabled']
    finally:
        shell.terminate()
        try:shell.wait(timeout=8)
        except subprocess.TimeoutExpired:shell.kill();shell.wait(timeout=5)
        log.close()
        print('shell log:',evidence/'shell.log')
