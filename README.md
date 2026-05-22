# cronforclaude-runner

The runner daemon for [Cron for Claude](https://cronforclaude.com).
A small Node process you install on your own machine — it polls our API,
claims due jobs, and runs them locally with `claude -p` using your existing
Claude CLI login. Outbound HTTPS only; nothing inbound.

> **Open source** so you can audit what's running on your machine. The
> orchestration server is closed-source SaaS.

> **Not affiliated with or endorsed by Anthropic PBC.** &ldquo;Claude&rdquo;
> and &ldquo;Claude Code&rdquo; are trademarks of Anthropic, used here
> descriptively to identify the CLI this runner invokes. We never see or
> proxy your Anthropic credentials.

## Install

```sh
# easiest: one-line installer (installs Node + the runner if missing)
curl -fsSL https://cronforclaude.com/install.sh | sh

# or via npm directly
npm install -g cronforclaude-runner
```

You need Node 20+ and a logged-in `claude` CLI on `PATH`. Verify with
`claude --version`.

## Set up a runner

Get a runner token from
[cronforclaude.com/app/runners](https://cronforclaude.com/app/runners)
→ *Create runner*. The dashboard shows the token once.

```sh
# interactive wizard
cronforclaude add my-mac

# one-liner (CI / cloud-init / Dockerfile)
cronforclaude add my-mac \
  --token=csr_live_… \
  --tags=mac,gpu \
  --non-interactive

# or just write apps/runner/.env yourself, see below
```

## Run it

```sh
cronforclaude run my-mac                    # foreground
cronforclaude daemon start my-mac           # detached
cronforclaude daemon status                 # which profiles are alive
cronforclaude daemon logs my-mac -f         # tail
cronforclaude daemon stop my-mac
```

## Multiple runners on one machine

A *profile* is a named runner identity. One install hosts as many as you
want — no per-runner directory needed.

```sh
cronforclaude add work     --token=csr_live_… --tags=work
cronforclaude add personal --token=csr_live_… --tags=personal

cronforclaude daemon start work
cronforclaude daemon start personal

cronforclaude ls
# personal
# work

cronforclaude daemon status
```

Each profile gets its own pid + log under `~/.cronforclaude/state/`.

## Run as a systemd service

Template-unit so one file serves every profile:

```ini
# /etc/systemd/system/cronforclaude@.service
[Unit]
Description=cronforclaude runner (%i)
After=network-online.target

[Service]
Type=simple
User=youruser
ExecStart=/usr/bin/cronforclaude run %i
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cronforclaude@my-mac
sudo systemctl enable --now cronforclaude@work
sudo journalctl -u 'cronforclaude@*' -f
```

## Environment / config layout

Profiles live as plain `.env` files. Hand-edit them, or use `cronforclaude
add` to write them for you.

```sh
~/.cronforclaude/
├── runners/
│   ├── default.env
│   └── work.env
└── state/
    ├── default.pid
    ├── default.log
    ├── work.pid
    └── work.log
```

A profile file:

```env
SCHEDULER_URL=https://cronforclaude.com
RUNNER_TOKEN=csr_live_…
RUNNER_NAME=my-mac
RUNNER_TAGS=mac,gpu
CLAUDE_BIN=claude
POLL_INTERVAL_MS=5000
HEARTBEAT_INTERVAL_MS=15000
MAX_CONCURRENT_JOBS=1
```

## Build from source

```sh
git clone https://github.com/HK2-AI/cronforclaude-runner.git
cd cronforclaude-runner
npm install
npm run build
node dist/index.js help
```

## License

MIT. See [LICENSE](./LICENSE).

The orchestration server (cronforclaude.com) is a hosted SaaS and
is **not** part of this repository.

## Trademark

cronforclaude-runner is an independent third-party utility.
&ldquo;Claude&rdquo; and &ldquo;Claude Code&rdquo; are trademarks of
Anthropic PBC. This project is not affiliated with, endorsed by, or
sponsored by Anthropic. We use the Claude name descriptively, to identify
the CLI we invoke on your machine. See
[Anthropic's trademark policy](https://www.anthropic.com/trademark-policy)
for their position.
