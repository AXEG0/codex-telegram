# Codex Telegram: operation and recovery

A small, installable Telegram channel for one live Gelios Codex CLI session.
Multiple paired private-chat users and the tmux terminal can steer the same
active Codex turn. Codex chooses whether and when to reply through an MCP tool;
the bridge never mirrors the final response automatically.

## Runtime

```text
Telegram private chats ──> bridge ──> Codex app-server (stdio)
tmux Codex TUI ──WebSocket/Unix socket──^ 
Codex MCP tool ──owner-only control socket──> Telegram
```

The runtime is dependency-free JavaScript for Node.js 18 or newer on Linux or
macOS. Linux reads process and boot identity from `/proc`; macOS asks the system
`ps`, `pgrep`, and `sysctl` binaries. It keeps the
Bot API token outside the repository, listens only on owner-only Unix sockets,
and uses the host's existing Codex login, configuration, `AGENTS.md`, and saved
sessions. The bridge forces YOLO execution (`never` approvals and
`danger-full-access`) for every thread and turn.

## Install

For the self-update flow, configure a reviewed moving branch such as `main`:

```bash
codex plugin marketplace add AXEG0/codex-telegram --ref main --json
codex plugin add telegram@codex-telegram --json
```

An immutable commit or release tag is valid for a pinned installation, but
`gelios-codex-telegram update` can only refresh that configured ref and therefore
cannot advance beyond it.

Use the launch command in the root README after installation. It locates the native installed package, prepares the local launcher, and opens the shared TUI with its MCP tools and instructions.

## Configure and pair

Launch the shared session using the root README. Create a bot with BotFather,
then invoke these skills in the local Codex terminal:

```text
$telegram:configure TOKEN
$telegram:access pair CODE
```

The bot supplies CODE after you message it. The controller authorizes only the
exact action entered through its trusted terminal connection; Telegram text
and stale or interrupted setup requests cannot authorize these commands.
Configuration attaches polling to the same native backend without replacing
the conversation. A token pasted into the CLI enters its conversation/model
context. `$telegram:configure rotate TOKEN` rotates a configured token locally.

The optional direct operator command retains hidden token entry outside Codex:

```bash
gelios-codex-telegram configure
```

The token is stored at
`~/.local/state/gelios-codex-telegram/.env` with mode `0600`; the state
directory is `0700`. The bridge excludes the token from child environments; pasting it into the local configure skill explicitly places it in the Codex conversation and model context.

### Optional speech-to-text

The bridge can transcribe authorized Telegram voice notes and audio files with
OpenAI `gpt-transcribe`. Pass the **name** of the host's scoped audio-key
environment variable, never the key value itself:

```bash
gelios-codex-telegram bridge --detach \
  --transcription-api-key-env AGENT_OPENAI_AUDIO_API_KEY
```

Without this option, transcription is inactive and attachment behavior is
unchanged. If the option names a missing or empty variable, bridge startup
fails instead of silently disabling transcription. The selected credential is
used only by the bridge for the OpenAI request; it is not stored and is removed
from the Codex app-server and MCP child environment.

Audio sent for transcription leaves the host and is processed by OpenAI.
Transcripts are marked as automatic and potentially inaccurate, while the
original opaque attachment handle is retained on success and every runtime
failure. Inputs are limited to 20 MiB and ten minutes. Telegram OGG/Opus voice
notes require `ffmpeg` on `PATH` for a lossless WebM container conversion;
documented OpenAI input formats are uploaded directly.

For a private GitHub marketplace, also pass the name of its credential slot when
starting the detached bridge:

```bash
gelios-codex-telegram bridge --detach \
  --transcription-api-key-env AGENT_OPENAI_AUDIO_API_KEY \
  --marketplace-auth-env AGENT_GITHUB_TOKEN \
  --codex-runtime-env AGENT_CODEX_API_KEY
```

After startup succeeds, the bridge saves an owner-only launch profile containing
the environment-variable names and normalized restart arguments. It never saves
their values. The marketplace credential is removed from the detached runtime by
default. Repeat `--codex-runtime-env` only for named slots that Codex itself must
receive; the transcription slot cannot be forwarded. The packaged askpass
helper releases the update credential only for `github.com`.
Every non-system environment variable required by Codex itself or one of its
MCP servers must be named with its own `--codex-runtime-env` occurrence.
Adding, removing, or renaming a slot requires one deliberate detached-bridge
restart with the complete revised option list. Updates replay the saved list;
they never scan arbitrary environment variables for credentials.

DM the bot once. It returns a six-character pairing code. Approve that exact
code locally:

```bash
gelios-codex-telegram access pair a1b2c3 --alias Jake --role admin
gelios-codex-telegram access list
gelios-codex-telegram access policy allowlist
```

The first paired user defaults to administrator; later users default to
contributor. Both roles can steer turns. Pairing, revocation, roles, and policy
can only be changed from the local terminal.

### Telegram session controls

Telegram cannot create a fresh conversation. `/new` is removed from the menu
and rejected if sent manually; saved requests cannot create a conversation
after restart.

Paired administrators can control the active Codex chat directly:

- `/model` loads the current app-server model catalog and opens an inline model
  picker, followed by that model's supported reasoning efforts.
- `/reasoning` opens the live reasoning-effort list for the current model.

A final model/effort selection updates the loaded thread and writes both user
defaults in one version-checked Codex config batch. Picker callbacks are bound
to the originating chat, administrator, message, and Codex thread; each picker
expires after ten minutes and can be used only once. Contributors cannot invoke
these controls.

## Direct runtime invocation

Gelios normally supervises this automatically. For development:

Start the bridge in the background when the Codex TUI should use the same
terminal. The command waits until the bridge is ready, then reports its PID,
socket, and log path (`~/.local/state/gelios-codex-telegram/bridge.log`):

```bash
gelios-codex-telegram bridge --detach --workspace "$HOME/work"
gelios-codex-telegram tui
```

Every line in `bridge.log` starts with the UTC time it was written. Telegram
polling failures are numbered as a consecutive streak (`polling error (…);
consecutive failure N, retrying in Ns`), and the first successful poll after a
streak logs one `polling recovered after N consecutive failures over <duration>
(first at <time>)` line. One outage reads as one numbered streak; scattered
transient failures each read as failure 1 followed by its recovery.

A Telegram `429 Too Many Requests` holds every Telegram call the bridge makes
until the `retry_after` it names has passed, logged once as `<method> was rate
limited (429); holding every Telegram call for <duration>, until <time>`.
Polling, replies, edits, callback answers and file fetches wait out the hold;
typing is skipped during the hold. Agent-chosen reactions retain durable
desired state and retry after the hold. The transport adds no automatic receipt
or completion reactions; startup retires previously persisted receipts without
re-adding them or erasing agent-chosen reactions.
The hold is saved in `runtime.json`, so a restarted bridge keeps
it, capped at its own length so a clock step cannot stretch it. A poll that
failed under a hold logs the delay it actually waits, and stopping the bridge
ends a hold wait at once.

For foreground development in separate terminals:

```bash
# Development terminal 1
gelios-codex-telegram bridge \
  --workspace "$HOME/work" \
  --socket "$HOME/.local/state/gelios-codex-telegram/app-server.sock" \
  --control-socket "$HOME/.local/state/gelios-codex-telegram/control.sock" \
  --codex-bin "$HOME/.local/bin/codex" \
  --terminal-name Alex

# Development terminal 2
gelios-codex-telegram tui
```

The bridge remembers the conversation Telegram is bound to and the first
terminal's app-server handshake in the owner-only `binding.json` of its state
directory. After a bridge or host restart it replays that handshake and resumes
the bound conversation itself, so Telegram works before any terminal attaches.
Reattach with `gelios-codex-telegram tui`; it resumes the selected conversation.
The native TUI `/resume` picker moves Telegram to the chosen conversation.
When Telegram changes the selection, the launcher replaces only its frontend,
restoring terminal settings before resuming the new thread. It does not launch
another app-server, inject keyboard commands or overwrite conversation IDs.
The controller rejects stale turn submissions during that boundary. Direct
`codex --remote` clients retain native Codex selection behavior; use the plugin
launcher for automatic following. A live tmux session preserves the TUI
through an SSM disconnect.

### Optional idle heartbeat

Heartbeat is disabled by default. Its owner-only `heartbeat.json` stores the
cadence, prompt, next due time and pending delivery identity. Configure the
running bridge without a host timer or another Codex process:

```bash
gelios-codex-telegram heartbeat enable --every 1h --prompt-file /path/heartbeat.txt
gelios-codex-telegram heartbeat status
gelios-codex-telegram heartbeat disable
```

The prompt file is configuration, not a generated skill. Enabling heartbeat
is disabled by default. A due tick waits while the selected
thread is busy or human input is pending, and missed ticks coalesce into one
delivery. It only uses `turn/start`; it never steers or interrupts human work,
creates a thread or replaces the binding. A persisted client-message identity
lets restart recovery reconcile an accepted turn before retrying it. A changed
conversation cancels an unaccepted pending delivery on the previous thread.
Disabling stops future deliveries; work already accepted by Codex continues.
Heartbeat events and delivery failures are recorded in local state/logs. No
Telegram progress panel or recovery notice is sent automatically.

### Run under a systemd user service

Add `--systemd-unit <name>.service` to the bridge arguments to hand supervision
to a systemd user service. The unit's `ExecStart` runs the managed launcher
(`~/.local/bin/gelios-codex-telegram bridge … --systemd-unit <name>.service`) in
the foreground and supplies the credential slots itself. That bridge ignores
stdin EOF and records the launch profile, so `update` replays the unit.

`bridge --detach --systemd-unit <name>.service`, which `update` runs for a
candidate or its rollback, refuses while the unit is active, writes a one-shot
owner-only handoff naming its own plugin build and instance ID, runs
`systemctl --user start`, and waits for that exact instance on the control
socket. The launcher honours the handoff; a crash restart or a boot runs the
managed launcher. Use `Restart=on-failure`: an update stops the bridge with exit
status 0 and starts its replacement through the unit. The detached caller's
credential values are never forwarded to the service.

## Update

Exit the Codex TUI so the detached bridge has no attached terminal, then run
this from its parent shell:

```bash
gelios-codex-telegram update
```

That remains the complete operator command. Every published plugin artifact
must carry a new manifest version or cachebuster whenever any file changes.
The updater hashes the complete trusted running and candidate plugin trees. An
identical same-version candidate performs the same transactional bridge
replacement as a plugin release, which refreshes the child app-server from the
currently installed Codex binary. Changed content under a reused version is
rejected before bridge shutdown and the durable running launcher is restored.
This prevents a moving marketplace ref from silently treating different bytes
as the same release while also converging Codex CLI/app-server version drift.

An installation from before this command existed has neither the command nor
its saved launch profile. Install the first supporting release through the
normal marketplace flow and start its detached bridge once with the desired
credential-slot options; subsequent releases use the command above.

The command discovers the installed plugin and marketplace from Codex JSON
output, then creates a durable owner-only copy of the running plugin outside
Codex's versioned cache. The managed launcher is atomically pointed at that copy
before any marketplace refresh or install can prune the prior cache entry. All
subprocess supervisors beyond that boundary also run from the durable copy. The
old bridge stays live while the candidate manifest, MCP wiring, files, and
JavaScript syntax are validated.

Activation is refused during an active turn. Otherwise the exact bridge
instance drains ingress and shuts down itself; the updater never signals a PID.
The candidate receives a pre-recorded instance ID, starts from its absolute
cache path, and must pass the control-socket health check before the launcher is
committed. A failed cutover starts the durable snapshot instead. The snapshot is
retained after failure and removed after a successful commit.

Codex CLI does not expose a complete installed-plugin selection rollback. If a
failure happens after `codex plugin add`, snapshot recovery restores the live
bridge and managed launcher, but Codex may still list the candidate as its
installed selection. A later successful update revalidates and commits that
candidate boundary.

Every phase is recorded in an owner-only transaction journal. Marketplace and
install subprocesses run in independently timed process groups, so they cannot
retain credentials or mutate the cache indefinitely if the updater disappears.
On the next invocation, a lock whose PID/start identity is dead is reclaimed;
the exact recorded transaction is recovered before updating continues. An
owner-controlled refused socket is treated as stale only after a reboot or
after every recorded PID/start identity is gone. An unknown or otherwise
indeterminate control socket fails closed and retains the journal.

Credential values must be available in the parent shell. The updater maps the
recorded marketplace-auth slot to `GH_TOKEN` only for the network marketplace
refresh; local candidate installation receives no marketplace credential. It
does not store, log, or place credential values in arguments. Each recorded
`--codex-runtime-env` slot is replayed into the replacement Codex process
without hardcoding an agent-specific name. If Codex recorded a candidate before
a later phase failed, the next invocation revalidates that installed state and
completes forward from the durable snapshot.

## Message and attachment behavior

- Every terminal and Telegram ingress receives a stable source label, UTC
  timestamp, event ID, and bridge sequence. Sequence—not wall-clock time—is the
  ordering authority.
- Text arriving during reasoning or a tool call uses `turn/steer` and becomes
  visible at the next model boundary.
- Bursts from one sender are batched after 300 ms for text, 500 ms for photos
  or 1500 ms after a Telegram-sized paste fragment. Batches retain all message
  IDs, ordered text, reply context and photos, with a 12-message, 50,000-character
  limit and 7.5-second maximum window. Changing sender/reply target, a command
  or another media kind flushes the prior batch. Raw members are journaled
  before advancing Telegram's update offset, including across restart.
- User text/caption edits keep their message ID and arrive with `edited=true`.
  Unchanged text and duplicate deliveries do not reinject input; an edited
  slash command is an update to the conversation, not a channel control.
- Incoming messages, batches, edits, queued delivery, acceptance and failures
  produce no automatic reactions. Reactions are agent-chosen through the MCP
  tool. Startup clears receipts left by older builds without adding them again
  or erasing agent-chosen reactions.
- `telegram_react` sets a supported ordinary reaction or clears it with an
  empty emoji. `telegram_edit_message` edits text previously sent by this bot,
  renders formatting and retains the message ID. Both check current pairing.
- After a Telegram message is prepared, the bridge renews Telegram's typing
  indicator every four seconds while that Codex turn remains busy. It stops on
  turn completion, permanent ingress failure, or bridge shutdown; an interim
  Telegram reply does not hide that the turn is still busy.
- A Telegram turn that fails on a temporary Codex error (`serverOverloaded`,
  `rateLimitExceeded`, `flexUnavailable`, `internalServerError`, or a failed or
  dropped HTTP or response stream) is continued by a turn the bridge starts
  itself, after waits of 1 s, 2 s, 5 s, 10 s, 30 s, 1 min, 2 min and 5 min. A
  turn that starts in the meantime continues the conversation instead, and its
  end settles the retry. A lasting error, or a failure after the last wait,
  sends each chat one message with
  Codex's error, recorded in `runtime.json` as a `telegram-out-…` event whose
  `source` is `Bridge`. A pending retry is saved in `runtime.json`, so a
  restarted bridge resumes it, and `status` shows it as `turnRetry`.
- Photos become Codex `localImage` input after authorization. Documents,
  voice/audio, video/video notes, stickers, and animations retain an authorized
  opaque attachment handle. With transcription configured, authorized
  voice/audio is also downloaded automatically and its marked transcript is
  added to the same Codex message; every failure falls back to the handle.
- `telegram_reply` renders Markdown as native Telegram formatting, preserving
  styles when long replies are split, and sends photos and arbitrary document
  types to a paired private chat. Outbound paths are restricted to the active
  workspace and the session inbox/outbox.
- Bot downloads are limited to 20 MiB. A reply accepts at most ten files;
  outbound photos are limited to 10 MiB and other files to 50 MiB each. The
  inbox is limited to 200 MiB with a default 24-hour retention. Cleanup runs at
  startup and hourly while preserving attachments still queued for delivery.
- Telegram groups and public listeners are not supported.

## Security model

Every paired participant is a remote operator of the active Gelios session.
The bridge enforces YOLO execution: Codex runs without a sandbox or approval
prompts. Pair only trusted operators. The bridge checks immutable numeric
Telegram IDs on inbound messages, MCP sends, and downloads. Authorization state
is atomically written and fails closed if corrupt. Usernames are display-only.

Keep the state directory outside the active Codex workspace and `/tmp`; the
Gelios launcher enforces this placement, but YOLO execution means it is not a
security boundary from Codex. This v1 uses the same host account as Codex:
mode `0600` protects the bot token from other accounts, while the collaboration
skill and operator policy prohibit exposing same-account credentials.

## Development

```bash
npm --prefix plugins/gelios-codex-telegram test
npm --prefix plugins/gelios-codex-telegram run check
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/gelios-codex-telegram
```

The runtime target is at most 6,000 non-test lines and zero direct runtime
dependencies. The budget counts every JavaScript file in `src` and `scripts`
plus both launchers, including the shared session controller, persistent heartbeat,
TUI following, burst journal and reaction recovery.

Opt-in native tests use `GELIOS_REAL_CODEX_BIN`. The TUI test also needs
`GELIOS_REAL_CODEX_AUTH` and util-linux `script`. To test a real model's tool
calls and inspect its own session evidence, set `GELIOS_REAL_MODEL=1` for
`test/agent-features.integration.test.js`; that test uses a local Telegram API
fixture and an isolated Codex home, removing its temporary authentication copy.


## Packaged onboarding acceptance

On Linux with a running systemd user manager, the opt-in terminal test uses a transient fixture service, a real PTY and a real model. It proves configuration and pairing through the local Codex skills against a local Telegram API fixture, repeat attachment, and restart of the same native conversation. `GELIOS_PACKAGE_TEST_SOURCE` and `GELIOS_PACKAGE_TEST_REF` select a Git candidate; `GELIOS_LEGACY_TEST_REF` enables migration from the original public snapshot. Model tests use the agent's own transcript to verify the installed skills and MCP calls. macOS functional execution is not covered by this fixture.

Run the suite through `npm test`. Its owned temporary root must be empty on completion; a leftover is named and fails the run. npm's compiler cache is disabled in CI because it is outside the test fixtures. Tests remove only resources they allocated.


## Native Codex commands

`codex-telegram` forwards native commands and options to the installed Codex
binary. Plugin controls use the separate `codex-telegram telegram` namespace;
`codex-telegram update` updates Codex itself, while
`codex-telegram telegram update` updates this plugin.

Interactive launch, `resume`, `fork` and `agents` connect to the managed bridge.
With no explicit session action or prompt, the launcher reopens the bound
conversation. `resume --last`, session IDs, picker filters, model/configuration
flags, prompts and images are parsed by Codex. Command discovery comes from the
installed binary, including its aliases. A change of conversation moves Telegram
with it. Reattaching after an external selection does not replay an initial
prompt or repeat a fork.

These interactive sessions use native Codex remote mode and retain its limits:
`--worktree`, `--add-dir` and `--no-daemon` are rejected by Codex in remote mode.
Explicit permission overrides while resuming a remote conversation are also
rejected by Codex. The default reattach accepts `--yolo` without resubmitting an
override only when the server confirms that the selected conversation already
uses full access and never asks for approval. The controller preserves explicit
native policies and later Telegram turns inherit the selected conversation's
policy. A separate `--remote` endpoint cannot be combined with the managed
Telegram connection.

Noninteractive commands, help/version output and parser errors delegate directly
to Codex without requiring an installed Telegram plugin or starting its bridge.
The original `codex` binary and command remain unchanged.
