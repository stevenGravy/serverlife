'use strict';

/*
 * Phase setups: ready-made steps for a phase.yaml, put together into stages
 * and checked against the rules `tsh phase apply` itself applies.
 *
 * A Phase is a saved Beam image and how it stays current. `tsh phase apply`
 * takes a chain of stages, one YAML document each: a stage either runs
 * commands as root (a rebuild Phase, run again whenever its parent changes and
 * every day) or copies local files in (a copy Phase), and either kind can
 * declare services — programs started whenever a Beam starts from the image.
 * A setup here is one useful thing to do in a stage: install Go, keep a
 * Postgres running, clone a repository on first start, bring dotfiles in.
 *
 * What a setup produces is plain phase.yaml, shown before anything runs, so
 * nothing here is beyond what a person could write by hand. The rules follow
 * tsh's own (tool/tsh/common/phases_config.go in core): checking here means a
 * mistake is pointed at in the dialog rather than reported by a build that
 * already started.
 *
 * Commands must be repeatable: a rebuild stage runs them again on a fresh copy
 * of its parent every time it refreshes. Files under /home belong to
 * interactive work, so a command stage leaves /home alone (unless a path is
 * reserved with rebuild_home_paths) and anything a user should find in their
 * home is put there by a pre-start service on first start instead.
 */

const path = require('path');
const yaml = require('js-yaml');

// The same limits tsh checks (services.MaxPhaseNameLength, MaxPhaseBuildConfigSize).
const MAX_NAME = 54;
const MAX_BUILD_CONFIG = 32 * 1024;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_SERVICES = new Set(['bootstrap', 'beam-assemble']);
const RESERVED_ENV = new Set([
  'BEAM_BUILD_CONFIG_FILE', 'BEAM_PARENT_PHASE_NAME', 'BEAM_PHASE_NAME',
  'BEAM_WORKING_DIGEST', 'BEAM_STREAM_BUILD_LOGS', 'BEAM_BUILD_TYPE',
]);
const SERVICE_TYPES = ['background', 'pre-start'];
const SERVICE_CONTEXTS = ['user', 'runtime', 'snapshot', 'rebuild', 'build', 'all'];
const DEFAULT_PHASE = 'default:v1';
// Where copied home files wait for the pre-start service that puts them in place.
const HOME_STAGING = '/opt/serverlife/home';

const APT_ENV = [{ name: 'DEBIAN_FRONTEND', value: 'noninteractive' }];
const apt = (pkgs) => `apt-get update && apt-get install -y --no-install-recommends ${pkgs}`;
const words = (s) => String(s || '').split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
// One shell word, quoted only when it has to be.
const sq = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

/*
 * Each setup: where it goes (`stage`: commands, files, or either), the fields
 * it asks for, and what it adds to its stage. `expand` gets the field values
 * and returns any of { commands, services, files, homePaths }.
 */
const SETUPS = [
  /* ---- Packages and languages (command stages) ---- */
  {
    id: 'apt', group: 'Packages and languages', label: 'Debian packages', stage: 'commands',
    help: 'Any packages from Debian 13 (trixie), which the Beam image is built on.',
    fields: [{ key: 'packages', label: 'Packages', placeholder: 'ripgrep fd-find jq', required: true }],
    expand: (v) => ({ commands: [{ comment: `Install ${words(v.packages).join(' ')}`, shell: apt(words(v.packages).join(' ')), env: APT_ENV }] }),
  },
  {
    id: 'build-tools', group: 'Packages and languages', label: 'Compilers and build tools', stage: 'commands',
    help: 'gcc, make, pkg-config, unzip — what native modules and source builds expect.',
    expand: () => ({ commands: [{ comment: 'Install compilers and build tools', shell: apt('build-essential pkg-config unzip'), env: APT_ENV }] }),
  },
  {
    id: 'go', group: 'Packages and languages', label: 'Go', stage: 'commands',
    help: 'The official release from go.dev. Rebuilds pick up a new release when the version is left empty.',
    fields: [{ key: 'version', label: 'Version', placeholder: 'Latest — or e.g. 1.25.4' }],
    expand: (v) => ({
      commands: [{
        comment: `Install Go ${v.version || '(latest release)'}`,
        shell: [
          'set -eu',
          'v="${GO_VERSION:-}"',
          '[ -n "$v" ] || v=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -n 1)',
          'case "$v" in go*) ;; *) v="go$v" ;; esac',
          'rm -rf /usr/local/go',
          'curl -fsSL "https://go.dev/dl/$v.linux-$(dpkg --print-architecture).tar.gz" | tar -xz -C /usr/local',
          'ln -sf /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/',
          'go version',
        ].join('\n'),
        env: v.version ? [{ name: 'GO_VERSION', value: String(v.version).trim() }] : undefined,
      }],
    }),
  },
  {
    id: 'rust', group: 'Packages and languages', label: 'Rust', stage: 'commands',
    help: 'rustup with a toolchain in /usr/local, so every user and service finds cargo and rustc on the PATH.',
    fields: [{ key: 'toolchain', label: 'Toolchain', placeholder: 'stable', default: 'stable' }],
    expand: (v) => ({
      commands: [{
        comment: `Install Rust (${v.toolchain || 'stable'})`,
        shell: [
          'set -eu',
          'export RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo',
          'curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "$RUST_TOOLCHAIN"',
          'chmod -R a+rX "$RUSTUP_HOME" "$CARGO_HOME"',
          // The proxies look for RUSTUP_HOME, which a service or a plain
          // `beams exec` never sets: a small wrapper for each sets it.
          'for b in "$CARGO_HOME"/bin/*; do',
          '  n=$(basename "$b")',
          '  printf \'#!/bin/sh\\nRUSTUP_HOME="${RUSTUP_HOME:-/usr/local/rustup}" exec %s "$@"\\n\' "$b" > "/usr/local/bin/$n"',
          '  chmod 755 "/usr/local/bin/$n"',
          'done',
          'rustc --version && cargo --version',
        ].join('\n'),
        env: [{ name: 'RUST_TOOLCHAIN', value: String(v.toolchain || 'stable').trim() }],
      }],
    }),
  },
  {
    id: 'java', group: 'Packages and languages', label: 'Java (OpenJDK)', stage: 'commands',
    help: "Debian's OpenJDK, headless.",
    fields: [{ key: 'version', label: 'Version', kind: 'select', default: '21', options: ['21', '25'] }],
    expand: (v) => ({ commands: [{ comment: `Install OpenJDK ${v.version || '21'}`, shell: `${apt(`openjdk-${v.version || '21'}-jdk-headless`)} && java -version`, env: APT_ENV }] }),
  },
  {
    id: 'uv', group: 'Packages and languages', label: 'uv (Python)', stage: 'commands',
    help: 'Astral\u2019s uv — Python versions, virtualenvs and packages, fast. Python 3 itself is already in the image.',
    expand: () => ({
      commands: [{
        comment: 'Install uv',
        shell: 'curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh && uv --version',
      }],
    }),
  },
  {
    id: 'node-tools', group: 'Packages and languages', label: 'pnpm, Yarn or Bun', stage: 'commands',
    help: 'Node.js 24 and npm are already in the image; these add the other package managers.',
    fields: [{ key: 'tools', label: 'Which', placeholder: 'pnpm yarn bun', default: 'pnpm' }],
    expand: (v) => {
      const want = new Set(words(v.tools).map((w) => w.toLowerCase()));
      const npm = ['pnpm', 'yarn'].filter((t) => want.has(t));
      const commands = [];
      if (npm.length) commands.push({ comment: `Install ${npm.join(' and ')}`, shell: `npm install -g --no-audit --no-fund ${npm.join(' ')}` });
      if (want.has('bun')) {
        commands.push({
          comment: 'Install Bun',
          shell: `${apt('unzip')} && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash && bun --version`,
          env: APT_ENV,
        });
      }
      return { commands };
    },
  },

  /* ---- Cloud and infrastructure CLIs (command stages) ---- */
  {
    id: 'kube-tools', group: 'Cloud and infrastructure', label: 'kubectl and Helm', stage: 'commands',
    help: 'For clusters reached through Teleport from the Beam (tsh kube login, then kubectl).',
    expand: () => ({
      commands: [{
        comment: 'Install kubectl and Helm',
        shell: [
          'set -eu',
          'v=$(curl -fsSL https://dl.k8s.io/release/stable.txt)',
          'curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/$v/bin/linux/$(dpkg --print-architecture)/kubectl"',
          'chmod 755 /usr/local/bin/kubectl',
          'curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash',
          'kubectl version --client && helm version',
        ].join('\n'),
      }],
    }),
  },
  {
    id: 'terraform', group: 'Cloud and infrastructure', label: 'Terraform', stage: 'commands',
    help: "HashiCorp's release build, the current version on each rebuild.",
    expand: () => ({
      commands: [{
        comment: 'Install Terraform',
        shell: [
          'set -eu',
          apt('unzip'),
          'v=$(curl -fsSL https://checkpoint-api.hashicorp.com/v1/check/terraform | jq -r .current_version)',
          'curl -fsSLo /tmp/terraform.zip "https://releases.hashicorp.com/terraform/$v/terraform_${v}_linux_$(dpkg --print-architecture).zip"',
          'unzip -o -q /tmp/terraform.zip terraform -d /usr/local/bin && rm -f /tmp/terraform.zip',
          'terraform version',
        ].join('\n'),
        env: APT_ENV,
      }],
    }),
  },
  {
    id: 'aws-cli', group: 'Cloud and infrastructure', label: 'AWS CLI', stage: 'commands',
    help: 'AWS CLI v2 — use it through tsh aws, or with tsh apps login for an AWS app.',
    expand: () => ({
      commands: [{
        comment: 'Install the AWS CLI',
        shell: [
          'set -eu',
          apt('unzip'),
          'curl -fsSLo /tmp/awscli.zip "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip"',
          'unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install --update && rm -rf /tmp/aws /tmp/awscli.zip',
          'aws --version',
        ].join('\n'),
        env: APT_ENV,
      }],
    }),
  },
  {
    id: 'gcloud', group: 'Cloud and infrastructure', label: 'Google Cloud CLI', stage: 'commands',
    help: "gcloud from Google's own Debian repository.",
    expand: () => ({
      commands: [{
        comment: 'Install the Google Cloud CLI',
        shell: [
          'set -eu',
          apt('gnupg'),
          'curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor --yes -o /usr/share/keyrings/cloud.google.gpg',
          'echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list',
          apt('google-cloud-cli'),
          'gcloud --version | head -n 1',
        ].join('\n'),
        env: APT_ENV,
      }],
    }),
  },

  {
    id: 'azure-cli', group: 'Cloud and infrastructure', label: 'Azure CLI', stage: 'commands',
    help: "az from Microsoft's Debian repository — Debian 13's own when Microsoft has it, bookworm's until then.",
    expand: () => ({
      commands: [{
        comment: 'Install the Azure CLI',
        shell: [
          'set -eu',
          apt('gnupg'),
          'curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /usr/share/keyrings/microsoft.gpg',
          'c=$(. /etc/os-release && echo "$VERSION_CODENAME")',
          // Microsoft adds a Debian release to its repository some time after it ships.
          'curl -fsI "https://packages.microsoft.com/repos/azure-cli/dists/$c/Release" >/dev/null 2>&1 || c=bookworm',
          'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $c main" > /etc/apt/sources.list.d/azure-cli.list',
          apt('azure-cli'),
          'az version --output tsv | head -n 1',
        ].join('\n'),
        env: APT_ENV,
      }],
    }),
  },

  /* ---- Settings (command stages) ---- */
  {
    id: 'env', group: 'Settings', label: 'Environment variables', stage: 'commands',
    help: 'Set for every login shell (written to /etc/profile.d). Services take their own env instead.',
    fields: [{ key: 'vars', label: 'Variables', kind: 'textarea', placeholder: 'EDITOR=vim\nNODE_ENV=development', required: true }],
    expand: (v) => {
      const lines = String(v.vars || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const body = lines.map((l) => {
        const at = l.indexOf('=');
        return at > 0 ? `export ${l.slice(0, at).trim()}=${sq(l.slice(at + 1).trim())}` : null;
      }).filter(Boolean);
      return {
        commands: [{
          comment: 'Set environment variables for login shells',
          shell: `cat > /etc/profile.d/serverlife-env.sh <<'EOF'\n${body.join('\n')}\nEOF`,
        }],
        _check: lines.filter((l) => !/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).map((l) => `"${l}" is not NAME=value`),
      };
    },
  },
  {
    id: 'deps-under-home', group: 'Settings', label: 'Rebuild dependencies under /home', stage: 'commands',
    help: 'For an app saved in an interactive Phase: this stage reinstalls its dependencies (npm ci, by default) on every rebuild, and reserves that folder for it.',
    fields: [
      { key: 'dir', label: 'App folder', placeholder: '/home/beams/app', default: '/home/beams/app', required: true },
      { key: 'reserve', label: 'Folder it writes', placeholder: '/home/beams/app/node_modules', default: '/home/beams/app/node_modules', required: true },
      { key: 'command', label: 'Install command', placeholder: 'npm ci', default: 'npm ci', required: true },
    ],
    expand: (v) => ({
      commands: [{ comment: `Reinstall dependencies in ${v.dir}`, shell: String(v.command || 'npm ci'), workdir: String(v.dir || '').trim() }],
      homePaths: [String(v.reserve || '').trim()],
    }),
  },

  /* ---- Services (either stage) ---- */
  {
    id: 'clone-repo', group: 'Services', label: 'Clone a repository on first start', stage: 'any',
    help: 'Runs before anything else when a Beam starts; does nothing if the folder is already there, so saved work is kept.',
    fields: [
      { key: 'url', label: 'Repository URL', placeholder: 'https://github.com/example/app.git', required: true },
      { key: 'dir', label: 'Into', placeholder: '/home/beams/app', default: '/home/beams/app', required: true },
    ],
    expand: (v) => ({
      services: [{
        name: 'clone-' + (path.posix.basename(String(v.dir || 'repo')).replace(/[^A-Za-z0-9._-]/g, '') || 'repo'),
        comment: `Clone ${v.url}`,
        type: 'pre-start', context: 'user',
        shell: `[ -d ${sq(v.dir)}/.git ] || git clone ${sq(v.url)} ${sq(v.dir)}`,
      }],
    }),
  },
  {
    id: 'postgres', group: 'Services', label: 'PostgreSQL server', stage: 'commands',
    help: 'Postgres running for the beams user, on localhost:5432. Its data is under /home/beams/.pgdata, so an interactive snapshot saves your dev database with your work.',
    expand: () => ({
      commands: [{
        comment: 'Install PostgreSQL',
        shell: [
          'set -eu',
          apt('postgresql'),
          'v=$(ls /usr/lib/postgresql | sort -V | tail -n 1)',
          // The packaged cluster is not used; a per-user one is made on first start.
          'pg_dropcluster --stop "$v" main 2>/dev/null || true',
          'for b in initdb postgres pg_ctl; do ln -sf "/usr/lib/postgresql/$v/bin/$b" /usr/local/bin/; done',
          "printf 'export PGHOST=localhost\\n' > /etc/profile.d/serverlife-postgres.sh",
        ].join('\n'),
        env: APT_ENV,
      }],
      services: [
        {
          name: 'postgres-init', comment: 'Create the dev database once', type: 'pre-start', context: 'user',
          shell: [
            'D=/home/beams/.pgdata',
            '[ -d "$D" ] && exit 0',
            'initdb -D "$D" -U beams --auth=trust >/dev/null',
            `printf "listen_addresses = 'localhost'\\nunix_socket_directories = '/tmp'\\n" >> "$D/postgresql.conf"`,
            // A database named after the user, so a plain `psql` connects.
            'pg_ctl -D "$D" -w -o "-c listen_addresses=" start >/dev/null',
            'createdb -h /tmp beams',
            'pg_ctl -D "$D" -w stop >/dev/null',
          ].join('\n'),
        },
        { name: 'postgres', comment: 'PostgreSQL on localhost:5432', type: 'background', context: 'user', shell: 'exec postgres -D /home/beams/.pgdata' },
      ],
    }),
  },
  {
    id: 'redis', group: 'Services', label: 'Redis server', stage: 'commands',
    help: 'Redis on localhost:6379, kept in memory only — every Beam starts with it empty.',
    expand: () => ({
      commands: [{ comment: 'Install Redis', shell: apt('redis-server'), env: APT_ENV }],
      services: [{ name: 'redis', comment: 'Redis on localhost:6379', type: 'background', context: 'user', shell: "exec redis-server --bind 127.0.0.1 --save '' --appendonly no --dir /tmp" }],
    }),
  },
  {
    id: 'app-service', group: 'Services', label: 'Run my app', stage: 'any',
    help: 'A long-running program started in every Beam from this image. Listen on 0.0.0.0, then publish the Beam (tsh beams publish) to reach it.',
    fields: [
      { key: 'name', label: 'Service name', placeholder: 'app', default: 'app', required: true },
      { key: 'shell', label: 'Command', placeholder: 'python3 -m http.server 8080 --directory /home/beams/app', required: true },
      { key: 'workdir', label: 'Working folder', placeholder: '/home/beams' },
      { key: 'context', label: 'Runs in', kind: 'select', default: 'runtime', options: SERVICE_CONTEXTS },
    ],
    expand: (v) => ({
      services: [{
        name: String(v.name || 'app').trim(), comment: `Run ${v.name || 'app'}`, type: 'background',
        context: v.context || 'runtime', shell: String(v.shell || ''), workdir: String(v.workdir || '').trim() || undefined,
      }],
    }),
  },

  /* ---- Files (copy stages) ---- */
  {
    id: 'copy', group: 'Files', label: 'Copy a file or folder', stage: 'files',
    help: 'From this computer into the image, outside /home. A folder merges into the destination.',
    fields: [
      { key: 'from', label: 'From (this computer)', kind: 'path', placeholder: '/Users/me/project/config', required: true },
      { key: 'to', label: 'To (in the Beam)', placeholder: '/opt/app/config', required: true },
    ],
    expand: (v) => ({ files: [{ comment: `Copy ${path.basename(String(v.from || ''))}`, from: String(v.from || '').trim(), to: String(v.to || '').trim() }] }),
  },
  {
    id: 'dotfiles', group: 'Files', label: 'My dotfiles and settings', stage: 'files',
    help: 'Files from your home folder — .gitconfig, .vimrc, .tmux.conf, ~/.claude settings — put in the Beam user\u2019s home on first start. Files already there are left alone unless you say to replace them.',
    fields: [
      { key: 'paths', label: 'Files or folders', kind: 'paths', placeholder: '~/.gitconfig\n~/.vimrc\n~/.tmux.conf', required: true },
      { key: 'replace', label: 'Replace files already in the Beam', kind: 'select', default: 'no', options: ['no', 'yes'] },
    ],
    expand: (v, ctx) => {
      const home = ctx?.home || '';
      const list = String(v.paths || '').split('\n').map((l) => l.trim()).filter(Boolean)
        .map((p) => (p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p));
      const files = list.map((p) => {
        // Kept at the same place relative to home: ~/.claude/x lands in /home/beams/.claude/x.
        const inHome = home && p.startsWith(home + path.sep);
        const rel = inHome ? path.relative(home, p).split(path.sep).join('/') : path.basename(p);
        return { comment: `Bring in ${inHome ? '~/' : ''}${rel}`, from: p, to: `${HOME_STAGING}/${rel}` };
      });
      return {
        files,
        services: [{
          name: 'serverlife-home', comment: 'Put dotfiles in place', type: 'pre-start', context: 'user',
          shell: `cp -R${v.replace === 'yes' ? 'f' : 'n'} ${HOME_STAGING}/. /home/beams/`,
        }],
      };
    },
  },

  /* ---- Your own (either) ---- */
  {
    id: 'command', group: 'Your own', label: 'A command', stage: 'commands',
    help: 'Any shell script, run as root. Keep it repeatable: rebuilds run it again on a fresh copy of the parent.',
    fields: [
      { key: 'comment', label: 'Shown in the log as', placeholder: 'Install my tools' },
      { key: 'shell', label: 'Shell', kind: 'textarea', placeholder: 'apt-get update && apt-get install -y htop', required: true },
      { key: 'workdir', label: 'Working folder', placeholder: '/' },
    ],
    expand: (v) => ({ commands: [{ comment: String(v.comment || '').trim() || undefined, shell: String(v.shell || ''), workdir: String(v.workdir || '').trim() || undefined }] }),
  },
  {
    id: 'service', group: 'Your own', label: 'A service', stage: 'any',
    help: 'A program started with every Beam from this image, as the beams user (sudo for root).',
    fields: [
      { key: 'name', label: 'Name', placeholder: 'my-service', required: true },
      { key: 'type', label: 'Kind', kind: 'select', default: 'background', options: SERVICE_TYPES },
      { key: 'context', label: 'Runs in', kind: 'select', default: 'user', options: SERVICE_CONTEXTS },
      { key: 'shell', label: 'Shell', kind: 'textarea', placeholder: 'exec my-server --port 8080', required: true },
    ],
    expand: (v) => ({ services: [{ name: String(v.name || '').trim(), type: v.type || 'background', context: v.context || 'user', shell: String(v.shell || '') }] }),
  },
  {
    id: 'raw', group: 'Your own', label: 'Written in YAML', stage: 'any',
    help: 'Commands, services, files and rebuild_home_paths exactly as phase.yaml has them — what an opened phase.yaml becomes, and the way to write anything the other setups do not cover.',
    fields: [{ key: 'yaml', label: 'phase.yaml', kind: 'yaml', required: true, placeholder: 'commands:\n  - comment: Install htop\n    shell: apt-get update && apt-get install -y htop' }],
    expand: (v) => {
      let doc;
      try { doc = yaml.load(String(v.yaml || '')) || {}; } catch (e) { return { _check: [`not YAML: ${String(e.message).split('\n')[0]}`] }; }
      if (typeof doc !== 'object' || Array.isArray(doc)) return { _check: ['should be a mapping of commands:, services:, files:'] };
      const allowed = new Set(['commands', 'services', 'files', 'rebuild_home_paths']);
      const unknown = Object.keys(doc).filter((k) => !allowed.has(k));
      const lists = ['commands', 'services', 'files', 'rebuild_home_paths'].filter((k) => doc[k] != null && !Array.isArray(doc[k]));
      return {
        commands: doc.commands || [], services: doc.services || [], files: doc.files || [], homePaths: doc.rebuild_home_paths || [],
        _check: [
          ...(unknown.length ? [`unknown key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (commands, services, files, rebuild_home_paths)`] : []),
          ...lists.map((k) => `${k} should be a list`),
        ],
      };
    },
  },
];

const byId = new Map(SETUPS.map((s) => [s.id, s]));

/* ------------------------------------------------------------------ */
/* Add-ins: setups of your own, one YAML file each                     */
/* ------------------------------------------------------------------ */

/*
 * An add-in is a setup written as data rather than code — the same shape the
 * built-in ones have, so it sits in the same list and is checked the same
 * way. Its strings may use {{field}} for what was typed into a field, or
 * {{field|sh}} for the same quoted as one shell word:
 *
 *   label: Our Node toolchain
 *   group: Team setups              # optional; "My add-ins" otherwise
 *   help: Node from nodesource, and our registry configured.
 *   stage: commands                 # commands | files | any
 *   fields:
 *     - { key: version, label: Node version, default: "22", required: true }
 *   commands:
 *     - comment: Install Node {{version}}
 *       shell: curl -fsSL https://deb.nodesource.com/setup_{{version}}.x | bash - && apt-get install -y nodejs
 *   services: [ ... ]               # as in phase.yaml
 *   files: [ ... ]                  # as in phase.yaml: from (this computer), to
 *   rebuild_home_paths: [ ... ]
 *
 * The files live in a folder (Settings: phaseAddinsDir, or the app's own
 * phase-addins folder), so a team can point everyone at one checked-out repo.
 */
const ADDIN_KEYS = new Set(['id', 'label', 'group', 'help', 'stage', 'fields', 'commands', 'services', 'files', 'rebuild_home_paths']);
const FIELD_KINDS = ['text', 'textarea', 'select', 'path', 'paths'];
const ADDIN_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** {{key}} and {{key|sh}} in every string of `value`, from `values`. */
function fill(value, values) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([A-Za-z_][\w-]*)\s*(?:\|\s*(sh))?\s*\}\}/g, (_m, key, filter) => {
      const v = values[key] == null ? '' : String(values[key]);
      return filter === 'sh' ? sq(v) : v;
    });
  }
  if (Array.isArray(value)) return value.map((x) => fill(x, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, values)]));
  return value;
}

/**
 * Read one add-in's text into a setup, or throw saying what is wrong with
 * it. `name` (the file's name without .yaml) is its id when it gives none.
 */
function parseAddin(text, name = 'addin') {
  let doc;
  try { doc = yaml.load(text); } catch (e) { throw new Error(`not YAML: ${String(e.message).split('\n')[0]}`, { cause: e }); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('should be a mapping, starting with label:');
  const unknown = Object.keys(doc).filter((k) => !ADDIN_KEYS.has(k));
  if (unknown.length) throw new Error(`unknown key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  const id = String(doc.id || name).toLowerCase();
  if (!ADDIN_ID.test(id)) throw new Error(`"${id}" can't be an id — lowercase letters, digits, . _ -`);
  if (!String(doc.label || '').trim()) throw new Error('needs a label');
  const stage = doc.stage || (doc.files ? 'files' : doc.commands ? 'commands' : 'any');
  if (!['commands', 'files', 'any'].includes(stage)) throw new Error('stage is commands, files or any');
  if (stage === 'commands' && doc.files) throw new Error('a commands add-in copies no files — use stage: files');
  if (stage === 'files' && doc.commands) throw new Error('a files add-in runs no commands — use stage: commands');
  if (stage === 'any' && (doc.commands || doc.files)) throw new Error('stage: any fits either kind of stage, so it can only add services');
  for (const k of ['commands', 'services', 'files', 'rebuild_home_paths', 'fields']) {
    if (doc[k] != null && !Array.isArray(doc[k])) throw new Error(`${k} should be a list`);
  }
  if (!doc.commands?.length && !doc.services?.length && !doc.files?.length) throw new Error('adds nothing — give it commands, services or files');
  const fields = (doc.fields || []).map((f, i) => {
    if (!f || typeof f !== 'object' || !/^[A-Za-z_][\w-]*$/.test(String(f.key || ''))) throw new Error(`fields[${i}] needs a key (letters, digits, _ -)`);
    const kind = f.kind || 'text';
    if (!FIELD_KINDS.includes(kind)) throw new Error(`fields[${i}]: kind is one of ${FIELD_KINDS.join(', ')}`);
    if (kind === 'select' && !(Array.isArray(f.options) && f.options.length)) throw new Error(`fields[${i}]: a select needs options`);
    return {
      key: String(f.key), label: String(f.label || f.key), kind, required: !!f.required,
      placeholder: f.placeholder != null ? String(f.placeholder) : '',
      default: f.default != null ? String(f.default) : (kind === 'select' ? String(f.options[0]) : ''),
      options: kind === 'select' ? f.options.map(String) : undefined,
    };
  });
  // Fields the strings name but the add-in never asks for: a typo, almost always.
  const used = new Set([...JSON.stringify([doc.commands, doc.services, doc.files, doc.rebuild_home_paths]).matchAll(/\{\{\s*([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !fields.some((f) => f.key === k));
  if (missing.length) throw new Error(`uses {{${missing.join('}}, {{')}}} but has no such field`);
  const tpl = { commands: doc.commands, services: doc.services, files: doc.files, homePaths: doc.rebuild_home_paths };
  return {
    id: 'addin:' + id, addin: true, group: String(doc.group || 'My add-ins'), label: String(doc.label), help: doc.help ? String(doc.help) : '',
    stage, fields,
    expand: (values) => {
      const out = fill(tpl, values);
      // A path field may start with ~, as the built-in file setups allow.
      const home = require('os').homedir();
      if (out.files) out.files = out.files.map((f) => ({ ...f, from: String(f.from || '').replace(/^~(?=\/|$)/, home) }));
      return out;
    },
  };
}

/** Every add-in in `dir`: the setups, and what is wrong with the files that are not. */
function loadAddins(dir) {
  const fs = require('fs');
  const addins = [];
  const problems = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort(); } catch { return { addins, problems, dir }; }
  const seen = new Set();
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const a = parseAddin(fs.readFileSync(file, 'utf8'), n.replace(/\.ya?ml$/i, ''));
      if (seen.has(a.id)) throw new Error(`another add-in already has the id ${a.id.slice(6)}`);
      seen.add(a.id);
      addins.push({ ...a, file });
    } catch (e) { problems.push({ file, error: e.message }); }
  }
  return { addins, problems, dir };
}

/** What the dialog shows: every setup, without its code — the built-in ones, then any add-ins. */
function catalog(addins = []) {
  return {
    setups: [...SETUPS, ...addins].map(({ expand: _e, ...s }) => ({ fields: [], ...s })),
    contexts: SERVICE_CONTEXTS, types: SERVICE_TYPES,
  };
}

/** Plain-object copy without undefined fields, so the YAML has no `key: null` lines. */
function tidy(o) {
  if (Array.isArray(o)) return o.map(tidy);
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length && k !== 'files')) continue;
    out[k] = tidy(v);
  }
  return out;
}

function checkCommand(c, where, errors) {
  if (c.shell && c.command) errors.push(`${where}: a shell script or a command, not both`);
  if (!String(c.shell || '').trim() && !String(c.command || '').trim()) errors.push(`${where}: nothing to run`);
  if (c.workdir && (!c.workdir.startsWith('/') || path.posix.normalize(c.workdir) !== c.workdir || (c.workdir.length > 1 && c.workdir.endsWith('/')))) {
    errors.push(`${where}: the working folder must be a clean absolute path (${c.workdir})`);
  }
  const seen = new Set();
  for (const e of c.env || []) {
    if (!e.name || e.name.includes('=') || e.name.includes('\0') || seen.has(e.name)) errors.push(`${where}: environment variable "${e.name}" is empty, repeated or has "="`);
    if (RESERVED_ENV.has(e.name)) errors.push(`${where}: ${e.name} is reserved for builds`);
    seen.add(e.name);
  }
  for (const s of [c.shell, c.command, c.workdir, ...(c.args || [])]) {
    if (typeof s === 'string' && s.includes('\0')) errors.push(`${where}: contains a NUL byte`);
  }
}

/**
 * Turn the dialog's stages into phase.yaml documents, and say what tsh would
 * refuse. A stage: { name, from (first stage only), kind: 'commands'|'files',
 * setups: [{ id, values }] }. `ctx.home` resolves ~ in local paths;
 * `ctx.exists` (optional) says whether a local path is there.
 */
function build(stages, ctx = {}) {
  const errors = [];
  const warnings = [];
  const docs = [];
  /*
   * What is only not filled in yet — an empty stage, a required field left
   * blank, a stage with no name — as against something wrong. Both stop a
   * build; the dialog holds the first kind back until a build is asked for,
   * rather than greeting a new, empty stage with an error.
   */
  const incomplete = [];
  const unfinished = (m) => { errors.push(m); incomplete.push(m); };
  const names = new Set();
  (stages || []).forEach((st, i) => {
    const label = st.name ? `Stage "${st.name}"` : `Stage ${i + 1}`;
    const name = String(st.name || '').trim();
    if (!name) unfinished(`${label}: needs a name`);
    else if (!DNS_LABEL.test(name) || name.length > MAX_NAME) {
      errors.push(`${label}: a name is lowercase letters, digits and hyphens, starting and ending with a letter or digit, up to ${MAX_NAME} characters`);
    } else if (names.has(name)) errors.push(`${label}: another stage already has this name`);
    names.add(name);

    // The chain: every stage after the first builds on the one before it.
    let from = i === 0 ? String(st.from || '').trim() : String(stages[i - 1].name || '').trim();
    if (from === DEFAULT_PHASE) from = '';
    if (i === 0 && from && !DNS_LABEL.test(from)) errors.push(`${label}: "${from}" is not a Phase name`);

    const kind = st.kind === 'files' ? 'files' : 'commands';
    const commands = [];
    const services = [];
    const files = [];
    const homePaths = [];
    for (const [j, use] of (st.setups || []).entries()) {
      const setup = byId.get(use.id) || (ctx.addins || []).find((a) => a.id === use.id);
      const where = `${label}, ${setup ? setup.label : use.id}`;
      if (!setup) { errors.push(`${where}: ${String(use.id).startsWith('addin:') ? 'add-in not found — removed, or its file has a problem (My add-ins…)' : 'unknown setup'}`); continue; }
      if (setup.stage !== 'any' && setup.stage !== kind) {
        errors.push(`${where}: goes in a ${setup.stage === 'files' ? 'copy-files' : 'commands'} stage — add it to a stage of that kind`);
        continue;
      }
      const values = { ...Object.fromEntries((setup.fields || []).map((f) => [f.key, f.default ?? ''])), ...(use.values || {}) };
      for (const f of setup.fields || []) {
        if (f.required && !String(values[f.key] ?? '').trim()) unfinished(`${where}: "${f.label}" is needed`);
      }
      const out = setup.expand(values, ctx) || {};
      for (const m of out._check || []) errors.push(`${where}: ${m}`);
      if (kind === 'files' && out.commands?.length) errors.push(`${where}: a copy-files stage runs no commands — make this stage "Install and run commands", or move them to a stage of that kind`);
      if (kind === 'commands' && out.files?.length) errors.push(`${where}: a commands stage copies no files — put them in a "Copy files" stage`);
      if (kind === 'files' && out.homePaths?.length) errors.push(`${where}: rebuild_home_paths needs a commands stage`);
      commands.push(...(out.commands || []).map((c) => ({ ...c, _where: where })));
      services.push(...(out.services || []).map((s) => ({ ...s, _where: where })));
      files.push(...(out.files || []).map((f) => ({ ...f, _where: where, _n: j })));
      homePaths.push(...(out.homePaths || []));
    }

    if (kind === 'commands' && !commands.length) unfinished(`${label}: a commands stage needs at least one command — add a setup that installs or runs something`);
    for (const c of commands) checkCommand(c, c._where, errors);

    const serviceNames = new Set();
    for (const s of services) {
      if (!SERVICE_NAME.test(s.name || '') || s.name.length > 128 || RESERVED_SERVICES.has(s.name)) errors.push(`${s._where}: "${s.name}" can't be a service name`);
      else if (serviceNames.has(s.name)) errors.push(`${s._where}: two services are called "${s.name}" — the later one would replace the first`);
      serviceNames.add(s.name);
      if (s.type && !SERVICE_TYPES.includes(s.type)) errors.push(`${s._where}: kind must be background or pre-start`);
      if (s.context && !SERVICE_CONTEXTS.includes(s.context)) errors.push(`${s._where}: runs in must be one of ${SERVICE_CONTEXTS.join(', ')}`);
      checkCommand(s, s._where, errors);
    }
    if (kind === 'files' && services.some((s) => s.context === 'rebuild')) {
      warnings.push(`${label}: copy stages never run services; a service that runs only in rebuilds belongs on a commands stage`);
    }

    for (const p of homePaths) {
      if (!p.startsWith('/') || path.posix.normalize(p) !== p || (p.includes('\0') || /[*?[\]]/.test(p)) || (p.length > 1 && p.endsWith('/'))) {
        errors.push(`${label}: reserved home folder "${p}" must be a clean absolute path, without wildcards`);
      } else if (p !== '/home' && !p.startsWith('/home/')) {
        warnings.push(`${label}: "${p}" is not under /home — only home folders need reserving`);
      }
    }

    for (const f of files) {
      const to = f.to || '';
      if (!f.from) errors.push(`${f._where}: which file or folder to copy?`);
      if (!to.startsWith('/')) errors.push(`${f._where}: the destination must be an absolute path (${to || 'none'})`);
      const clean = path.posix.normalize(to);
      if (clean === '/home' || clean.startsWith('/home/')) errors.push(`${f._where}: copies go outside /home — use "My dotfiles and settings" for files the Beam user should have`);
      if (f.from && ctx.exists && !ctx.exists(f.from)) errors.push(`${f._where}: ${f.from} is not on this computer`);
    }

    const doc = { version: 'v1', metadata: { name } };
    if (from) doc.metadata.from = from;
    if (homePaths.length) doc.metadata.rebuild_home_paths = homePaths;
    if (kind === 'commands') doc.commands = commands.map(({ _where, ...c }) => c);
    else doc.files = files.map(({ _where, _n, ...f }) => f);
    if (services.length) doc.services = services.map(({ _where, ...s }) => s);
    const clean = tidy(doc);
    if (kind === 'files' && !clean.files) clean.files = [];
    docs.push(clean);

    // What tsh stores as the build configuration has to fit in 32 KiB.
    const raw = JSON.stringify({ protected_paths: homePaths, commands: clean.commands || [], services: clean.services || [] });
    if (raw.length > MAX_BUILD_CONFIG) errors.push(`${label}: its commands and services come to ${raw.length} bytes; a stage can hold ${MAX_BUILD_CONFIG}`);
  });
  if (!docs.length) unfinished('Add a stage');
  return { docs, errors, warnings, incomplete, yaml: toYaml(docs) };
}

/** The documents as phase.yaml text. */
function toYaml(docs, { header = true } = {}) {
  const body = docs.map((d) => yaml.dump(d, { lineWidth: -1, noRefs: true, quotingType: '"' }).trimEnd()).join('\n---\n');
  const head = header ? '# A Phase setup made in ServerLife. Build it with: tsh phase apply -f <this file>\n' : '';
  return head + body + '\n';
}

/**
 * An existing phase.yaml as the builder's stages, to carry on from: each
 * document a stage with its name, parent (the first one's), kind, and what it
 * holds kept exactly as written in a "Written in YAML" setup. Relative file
 * sources are made absolute against `dir`, where the file was, as tsh reads
 * them. A raw --commands-file (one document of commands:, no metadata) is
 * read as a single stage too.
 */
function fromYaml(text, { dir = '' } = {}) {
  let docs;
  try { docs = yaml.loadAll(String(text || '')).filter((d) => d != null); } catch (e) { throw new Error(`not YAML: ${String(e.message).split('\n')[0]}`, { cause: e }); }
  if (!docs.length) throw new Error('the file is empty');
  const warnings = [];
  const stages = docs.map((d, i) => {
    if (typeof d !== 'object' || Array.isArray(d)) throw new Error(`document ${i + 1} is not a mapping`);
    const raw = !d.version && !d.metadata && d.commands;
    if (!raw && d.version !== 'v1') warnings.push(`document ${i + 1}: version is ${d.version ?? 'missing'}, not v1`);
    const name = String(d.metadata?.name || (raw ? 'imported' : `stage-${i + 1}`));
    const from = String(d.metadata?.from || '');
    if (i > 0 && from && from !== String(docs[i - 1].metadata?.name || '')) {
      warnings.push(`${name}: was built on ${from}, not the stage before it — here every stage builds on the one above`);
    }
    const files = Array.isArray(d.files) ? d.files.map((f) => ({
      ...f, from: f?.from && dir && !path.isAbsolute(String(f.from)) ? path.join(dir, String(f.from)) : f?.from,
    })) : d.files;
    const body = {};
    if (d.commands) body.commands = d.commands;
    if (files) body.files = files;
    if (d.services) body.services = d.services;
    const homePaths = d.metadata?.rebuild_home_paths || d.protected_paths;
    if (homePaths) body.rebuild_home_paths = homePaths;
    const extra = Object.keys(d).filter((k) => !['version', 'metadata', 'commands', 'files', 'services', 'protected_paths'].includes(k));
    if (extra.length) warnings.push(`${name}: left out ${extra.join(', ')} — not part of phase.yaml`);
    return {
      name, from: i === 0 ? from : '', kind: d.files ? 'files' : 'commands',
      setups: [{ id: 'raw', values: { yaml: yaml.dump(body, { lineWidth: -1, noRefs: true }).trimEnd() } }],
    };
  });
  return { stages, warnings };
}

/** A starting point for a new add-in. */
const ADDIN_TEMPLATE = `# A setup of your own for "Build a Phase from setups".
# {{field}} is what was typed in a field; {{field|sh}} is the same, shell-quoted.
label: My tool
group: My add-ins
help: What it installs, in a sentence.
stage: commands          # commands | files | any (services only)
fields:
  - key: version
    label: Version
    default: "1.0.0"
    required: true
commands:
  - comment: Install my tool {{version}}
    shell: |
      set -eu
      curl -fsSL "https://example.com/mytool-{{version}}-linux-$(dpkg --print-architecture).tar.gz" | tar -xz -C /usr/local/bin
# services:
#   - name: my-tool
#     type: background     # or pre-start
#     context: user        # user, runtime, snapshot, rebuild, build, all
#     shell: exec mytool serve
`;

module.exports = { SETUPS, catalog, build, toYaml, fromYaml, parseAddin, loadAddins, fill, ADDIN_TEMPLATE, HOME_STAGING, SERVICE_CONTEXTS, SERVICE_TYPES, DEFAULT_PHASE };
