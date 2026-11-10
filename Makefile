# ServerLife — build and release
#
#   make            show this help
#   make setup      install dependencies and build native modules
#   make run        build the renderer and launch the app
#   make dist-mac   package for macOS (Apple Silicon)
#
# Cross-compiling has real prerequisites; `make check-cross` reports which of
# them are present on this machine. For reproducible multi-platform releases,
# prefer `make release-ci`, which runs the build on each OS via GitHub Actions.

SHELL      := /bin/bash
NPM        := npm
NODE       := node
VERSION    := $(shell $(NODE) -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)
RELEASE    := release
UNAME_S    := $(shell uname -s)

# Electron refuses to start as an app when this is inherited from a parent
# Electron process (VS Code's integrated terminal sets it).
RUN_ENV    := env -u ELECTRON_RUN_AS_NODE

.DEFAULT_GOAL := help
.PHONY: help setup install rebuild build watch run dev clean distclean \
        icon lint verify test test-e2e test-integration audit outdated dist-mac dist-mac-universal dist-linux dist-win \
        dist-all check-cross notes release release-ci version bump-patch bump-minor

## ---------------------------------------------------------------- help

help:
	@echo "ServerLife $(VERSION)"
	@echo
	@echo "Setup"
	@echo "  make setup           Install dependencies, rebuild native modules"
	@echo "  make rebuild         Rebuild node-pty against Electron's ABI"
	@echo
	@echo "Develop"
	@echo "  make build           Bundle the renderer"
	@echo "  make watch           Rebuild the renderer on change"
	@echo "  make run             Build and launch"
	@echo "  make dev             Launch with logging and devtools"
	@echo "  make verify          Syntax-check every source file"
	@echo "  make lint            Lint with the rules Teleport uses (oxlint)"
	@echo "  make test            Syntax check, then the unit tests"
	@echo "  make test-e2e        The real app in Electron (a throwaway profile)"
	@echo "  make test-integration  OpenSSH + Teleport in Docker (TELEPORT_VERSION=…)"
	@echo
	@echo "Security"
	@echo "  make audit           Fail on high/critical known vulnerabilities (npm audit)"
	@echo "  make outdated        Report which dependencies have newer stable versions"
	@echo
	@echo "Package  (output in ./$(RELEASE))"
	@echo "  make dist-mac        macOS arm64 (Apple Silicon) dmg + zip"
	@echo "  make dist-mac-universal  macOS arm64 + x64"
	@echo "  make dist-linux      Linux x64 + arm64 AppImage, deb, tar.gz"
	@echo "  make dist-win        Windows x64 installer + zip"
	@echo "  make dist-all        Every target above"
	@echo "  make check-cross     Report cross-build prerequisites"
	@echo
	@echo "Release"
	@echo "  make bump-patch      0.1.0 -> 0.1.1"
	@echo "  make bump-minor      0.1.0 -> 0.2.0"
	@echo "  make notes           Preview the release notes for $(VERSION)"
	@echo "  make release         Lint, then tag v$(VERSION) and push"
	@echo
	@echo "Clean"
	@echo "  make clean           Remove build output"
	@echo "  make distclean       Also remove node_modules"

## ---------------------------------------------------------------- setup

setup: install rebuild icon build
	@echo "Ready. Run: make run"

install:
	$(NPM) install

# Native modules are compiled for Node's ABI on install and must be rebuilt
# for Electron's.
rebuild:
	npx electron-rebuild -f -w node-pty

## ---------------------------------------------------------------- develop

icon:
	$(NODE) tools/make-icon.mjs

build:
	$(NODE) build.mjs

watch:
	$(NODE) build.mjs --watch

run: build
	$(RUN_ENV) npx electron .

dev: build
	$(RUN_ENV) npx electron . --enable-logging

# No test framework here yet; this catches syntax errors across the tree,
# which is what most breakage looks like in practice.
verify:
	@echo "Checking main process sources..."
	@for f in src/main/*.js tools/*.mjs build.mjs; do \
	  $(NODE) --check "$$f" || exit 1; \
	done
	@echo "Checking renderer sources..."
	@for f in src/renderer/js/*.js; do \
	  $(NODE) --input-type=module --check < "$$f" || exit 1; \
	done
	@echo "All sources parse."

# The JavaScript rules Teleport lints its own web code with — see .oxlintrc.jsonc.
# Errors fail it, as does a disable comment that no longer suppresses anything;
# warnings are printed and let through. A release does not tag with an error.
lint:
	npx --no-install oxlint -c .oxlintrc.jsonc --report-unused-disable-directives-severity error .

# The unit tests, bundled before they run — see tools/run-tests.mjs for why.
# `make test FILTER=tags` runs one file's worth.
test: verify
	@$(NODE) tools/run-tests.mjs $(FILTER)

# The real app in Electron, driven over the DevTools protocol, for what only a
# renderer can answer — layout, mostly. A throwaway profile, so it runs beside
# a ServerLife already in use. See tests/e2e/.
test-e2e: build
	@for f in tests/e2e/*.e2e.mjs; do echo "== $$f"; $(NODE) $$f || exit 1; done

# The modules that talk to servers, against a real OpenSSH host and a real
# Teleport cluster in Docker — see tests/integration/README.md. Defaults to the
# newest Teleport release; `make test-integration TELEPORT_VERSION=17.7.30`
# picks another, and TELEPORT_CLIENT_VERSION puts a different tsh in front of
# it. The stack is removed afterwards whether it passed or not.
#
# `run` rather than `up --abort-on-container-exit`: the one-shot setup service
# finishing counts as a container exiting, and `up` then half-aborts the stack
# and never returns.
IT_COMPOSE := docker compose -f tests/integration/compose.yml
test-integration:
	@v="$(TELEPORT_VERSION)"; [ -n "$$v" ] || v=$$(COUNT=1 tests/integration/teleport-versions.sh) || exit 1; \
	c="$(TELEPORT_CLIENT_VERSION)"; [ -n "$$c" ] || c=$$v; \
	echo "Integration tests: Teleport $$v cluster, tsh $$c"; \
	export TELEPORT_VERSION=$$v TELEPORT_CLIENT_VERSION=$$c; \
	$(IT_COMPOSE) build -q && $(IT_COMPOSE) run --rm runner; \
	status=$$?; \
	[ $$status -eq 0 ] || $(IT_COMPOSE) logs --no-color --tail=60 proxy node; \
	$(IT_COMPOSE) down -v --remove-orphans >/dev/null 2>&1; \
	exit $$status

## ---------------------------------------------------------------- security

# Known vulnerabilities in the installed dependency tree, checked against
# npm's advisory database. --audit-level=high means a moderate finding in
# some unrelated dev tool doesn't fail this — electron, node-pty, serialport
# and ws run in the main process with real filesystem and network access, so
# a high or critical advisory against any of them is what's worth stopping
# for. Exit code is npm audit's own, so this is the one to put in CI.
audit:
	$(NPM) audit --audit-level=high

# Whether the pinned versions have moved on since package.json was last
# touched, electron included. Informational only, and always exits 0: a
# patch or minor behind is normal between releases and is not a vulnerability
# by itself (`make audit` is what gates on an actual one) — this is a report
# to read before cutting a release, not a check to fail on.
outdated:
	@$(NPM) outdated || true

## ---------------------------------------------------------------- package

dist-mac: build icon
	$(NPM) run dist:mac
	@$(MAKE) --no-print-directory _list

dist-mac-universal: build icon
	$(NPM) run dist:mac:universal
	@$(MAKE) --no-print-directory _list

dist-linux: build icon
	$(NPM) run dist:linux
	@$(MAKE) --no-print-directory _list

dist-win: build icon
	$(NPM) run dist:win
	@$(MAKE) --no-print-directory _list

dist-all: build icon
	$(NPM) run dist:all
	@$(MAKE) --no-print-directory _list

_list:
	@echo
	@echo "Artifacts in $(RELEASE):"
	@ls -1sh $(RELEASE)/*.dmg $(RELEASE)/*.zip $(RELEASE)/*.AppImage \
	         $(RELEASE)/*.deb $(RELEASE)/*.tar.gz $(RELEASE)/*.exe 2>/dev/null || true

# Each foreign target needs a toolchain this machine may not have.
check-cross:
	@echo "Host: $(UNAME_S)"
	@echo
	@printf "%-28s" "macOS target:"; \
	  if [ "$(UNAME_S)" = "Darwin" ]; then echo "OK (native)"; \
	  else echo "UNAVAILABLE - macOS builds require macOS"; fi
	@printf "%-28s" "Linux target:"; \
	  if [ "$(UNAME_S)" = "Linux" ]; then echo "OK (native)"; \
	  elif command -v docker >/dev/null 2>&1; then echo "OK via docker"; \
	  else echo "needs docker (electron-builder runs the Linux build in a container)"; fi
	@printf "%-28s" "Windows target:"; \
	  if command -v wine64 >/dev/null 2>&1 || command -v wine >/dev/null 2>&1; then echo "OK via wine"; \
	  elif [ "$(UNAME_S)" = "Linux" ] && command -v docker >/dev/null 2>&1; then echo "OK via docker"; \
	  else echo "needs wine (brew install --cask wine-stable) or build on Windows"; fi
	@echo
	@echo "Reliable path for all three: make release-ci"

## ---------------------------------------------------------------- release

version:
	@echo $(VERSION)

bump-patch:
	$(NPM) version patch --no-git-tag-version
	@echo "Now $$($(NODE) -p "require('./package.json').version") - update CHANGELOG.md"

bump-minor:
	$(NPM) version minor --no-git-tag-version
	@echo "Now $$($(NODE) -p "require('./package.json').version") - update CHANGELOG.md"

# What CI will use as the release body. Worth a look before tagging: the notes
# are cut from the changelog, so a missing or misnamed heading shows up here.
notes:
	@$(NODE) tools/release-notes.mjs $(VERSION)

# Tags are prefixed `serverlife-v` so a tag says what it is releasing.
release: lint
	@git diff --quiet || { echo "Working tree is dirty; commit first."; exit 1; }
	git tag -a "serverlife-v$(VERSION)" -m "ServerLife $(VERSION)"
	git push origin "serverlife-v$(VERSION)"
	@echo "Tag pushed. CI builds macOS, Linux and Windows artifacts."

release-ci:
	@echo "Push a tag to trigger .github/workflows/serverlife-release.yml:"
	@echo "  make bump-patch && git commit -am 'release' && make release"

## ---------------------------------------------------------------- clean

clean:
	rm -rf $(RELEASE) src/renderer/app.js src/renderer/vendor

distclean: clean
	rm -rf node_modules build/icon.png
