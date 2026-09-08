UUID := codex-usage-monitor@theophilediot.github.io
RUNTIME := app-server.js files.js usage.js history.js monitor.js statusline.js codex-usage-symbolic.svg LICENSE NOTICE
FEDORA ?= 44

.PHONY: test test-native test-shell test-prefs test-compat pack
test:
	gjs -m tests/test-usage.js
	gjs -m tests/test-history.js
	gjs -m tests/test-files.js
	gjs -m tests/test-client.js
	gjs -m tests/test-monitor.js
	gjs -m tests/test-statusline.js
	glib-compile-schemas --strict schemas
	glib-compile-schemas --strict --dry-run schemas

pack: test
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--schema=schemas/org.gnome.shell.extensions.codex-usage-monitor.gschema.xml \
		$(foreach file,$(RUNTIME),--extra-source=$(file)) .

test-native: test
	gjs -m tests/test-native-config.js

test-shell: pack
	python3 tests/test-shell.py

test-prefs: test
	GSETTINGS_BACKEND=memory GDK_BACKEND=x11 GSK_RENDERER=cairo \
		GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0:/usr/lib64/gnome-shell/girepository-1.0 \
		LD_LIBRARY_PATH=/usr/lib/gnome-shell:/usr/lib64/gnome-shell xvfb-run -a gjs -m tests/test-prefs.js

test-compat:
	docker build --build-arg FEDORA=$(FEDORA) -f tests/Containerfile -t codex-monitor-gnome:fedora$(FEDORA) tests
	docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
		--tmpfs /work:exec,mode=1777 --mount "type=bind,src=$(CURDIR),dst=/src,readonly" \
		codex-monitor-gnome:fedora$(FEDORA) python3 /src/tests/test-container.py
