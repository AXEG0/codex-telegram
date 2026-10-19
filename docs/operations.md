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
sessions. The terminal selects native permissions. `--yolo` selects `never` approvals and
`danger-full-access` for that terminal; Telegram inherits the selected conversation policy.

## Install

For the self-update flow, configure a reviewed moving branch such as `main`:

```bash
codex plugin marketplace add AXEG0/codex-telegram --ref main --json
codex plugin add telegram@codex-telegram --json
```

An immutable commit or release tag is valid for a pinned installation, but
the update commands can only refresh that configured ref and therefore
cannot advance beyond it.

Use the launch command in the root README after installation. The npm command installs the launcher; the native commands install the plugin. At launch, the dispatcher resolves the enabled native package, prepares the managed launcher, and opens the shared TUI with its MCP tools and instructions. It does not reinstall or enable plugins.

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

`$telegram:access` without arguments shows access status. After pairing everyone,
`$telegram:access policy allowlist` ends pairing. Paired users share the selected
conversation’s permissions.

### Other bots

Another Telegram bot, such as another agent's, pairs with the bridge the way a
person does. Telegram delivers a private message from one bot to another only
when both bots have Bot-to-Bot Communication Mode on in
[@BotFather](https://t.me/BotFather) (Bot Settings), and the sending bot names
this one by its `@username` the first time
([Telegram's bot-to-bot rules](https://core.telegram.org/bots/features#bot-to-bot-communication)).

1. Turn on Bot-to-Bot Communication Mode for both bots.
2. Pair yourself first, so the bot does not become the first, administrator,
   user. Then open pairing in the local Codex terminal:
   `$telegram:access policy pairing`.
3. Have the other bot message this bot. The bridge answers that chat with a
   pairing code, as it does for a person.
4. Approve the code, then end pairing:

   ```text
   $telegram:access pair CODE
   $telegram:access policy allowlist
   ```

   With someone already paired, the bot gets the contributor role, which keeps
   it out of the administrator session controls; `$telegram:access` shows it.

Codex answers the bot through its reply tool, in the bot's chat. On its own,
the bridge sends that chat only pairing answers, replies to its slash commands
and the notice when a turn fails after its retries, so an exchange goes on only
while Codex chooses to reply. Telegram warns that two bots answering each other
can loop. A paired bot is a remote operator like any paired person, and roles
are not sandbox boundaries (see [Security model](#security-model)): pair only a
bot you control or trust.

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
  --marketplace-auth-env AGENT_GITHUB_TOKEN
```

After startup succeeds, the bridge saves an owner-only launch profile containing
the environment-variable names and normalized restart arguments. It never saves
their values. Codex inherits the launcher's environment except the bridge's
bot token, selected transcription key and marketplace credential, including aliases
containing those private values. Without an explicit marketplace slot, `GH_TOKEN`
and `GITHUB_TOKEN` are withheld. Other settings are neither classified nor redacted
as credentials. The Telegram MCP process retrieves the same filtered environment
through the owner-only bridge socket because native MCP startup uses an allowlist.
Other MCP servers retain their native environment configuration.

`--codex-runtime-env` is accepted for saved-profile compatibility; no flag is needed
for a new setting. The packaged askpass helper releases the marketplace credential
only for `github.com`. Launcher environment values are never saved in profiles.

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

Prepare that launcher with the plugin's installer before starting the unit:

```sh
codex-telegram telegram setup --prepare --state-dir ~/.local/state/gelios-codex-telegram
```

Use the managed launcher path above in `ExecStart`; do not create a link into a
version folder under Codex's plugin cache. The installer and bridge retain the
complete committed build under the bridge state directory's `runtime-builds/`.
The service entry point, update candidates and committed launcher use these
durable copies. Codex can replace its own cache without breaking a service
restart or the launch profile.

The bridge checks the installed build after startup and every 30 seconds. A
changed build moves through the updater's existing journaled cutover only when
no turn is in flight and no TUI is attached. An attached TUI is never closed for
an automatic update. A failed automatic candidate is recorded owner-only by its
content digest and is never retried automatically. A turn or TUI that becomes
busy during preflight defers the update without blocking the candidate. Installing a different digest
or running a manual update clears the block. An active update unit blocks another
automatic launch, including while the replacement bridge starts. Detaching the TUI lets the next idle check apply the pending
build; restarting before that check still runs the durable committed build. A
systemd installation runs the updater in a separate transient user unit, so
stopping the bridge cannot kill the updater. Runtime and transcription
credentials stay with the bridge service.

After a successful commit, the updater removes unreferenced durable builds. The
committed and running builds, active transaction references, and builds leased by
live processes remain. Build creation and collection share a lock; stale
process-identity leases expire during collection.

The conversation, workspace and channel state remain in the existing state
directory. The status response includes `pluginVersion` and `pluginRoot`; MCP's
initialize response reports its own version for comparison.

`bridge --detach --systemd-unit <name>.service`, which `update` runs for a
candidate or its rollback, refuses while the unit is active, writes a one-shot
owner-only handoff naming its own plugin build and instance ID, runs
`systemctl --user start`, and waits for that exact instance on the control
socket. The launcher honours the handoff; a crash restart or a boot runs the
managed launcher. Use `Restart=on-failure`: an update stops the bridge with exit
status 0 and starts its replacement through the unit. The detached caller's
credential values are never forwarded to the service.

## Legacy plugin-only update

For the current installation, use the [combined updater](#combined-installation-update).
The original managed launcher retains this plugin-only operator command. Exit
the Codex TUI and run it from the parent shell:

```bash
gelios-codex-telegram update
```

This command updates only the native plugin and its backend. Every published plugin artifact
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
does not store, log, or place credential values in arguments. An unsupervised
restart preserves the launcher's environment; a supervised restart
receives its environment from the service unit. The bridge applies the same
credential exclusions before starting Codex. If Codex recorded a candidate before
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

The runtime target is at most 6,250 non-test lines and zero direct runtime
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


## Existing installations

Before installing, run `codex plugin marketplace list --json`. If the public
`AXEG0/codex-telegram` source is still registered as `gelios`, migrate that
obsolete catalog registration first:

```sh
codex plugin marketplace remove gelios
codex plugin marketplace add AXEG0/codex-telegram --ref main
```

Native marketplace removal retains installed plugin caches and selections.
Repeating `marketplace add` alone keeps the old name for an already configured
Git source. Keep the old plugin selection until the packaged migration below
has captured and restored the running conversation.

Install the native plugin and npm launcher using the root README. Let the
current turn finish, exit its attached terminal, then run:

```sh
codex-telegram --yolo
```

An existing Gelios installation migrates through its saved launch profile while
preserving the workspace, credentials, pairing and conversation history.

After migration, verify the current conversation and `codex-telegram telegram
status`, then retire any remaining legacy selection through Codex:

```sh
codex plugin remove gelios-codex-telegram@gelios
```

## Native Codex commands

```sh
codex-telegram --yolo
codex-telegram --yolo resume --last
codex-telegram --yolo fork --last
codex-telegram telegram status
```

On first launch, select a custom workspace with
`codex-telegram --yolo -C /path/to/project`.

`codex-telegram` forwards native commands and options to the installed Codex
binary. Plugin controls use the separate `codex-telegram telegram` namespace;
`codex-telegram update` updates Codex CLI, this plugin and its npm launcher together;
`codex-telegram telegram update` is an alias. Plain `codex update` remains the native CLI updater. The combined command accepts `--state-dir PATH`; use native `codex update` for native update flags.

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
rejected by Codex. The launcher carries `--yolo` as a private terminal launch intent through a
single-use Unix connection. The controller applies that requested policy to the
terminal’s selections and turns, including `/new`, without making it a global
bridge override. Later launches without `--yolo` preserve their native policy;
Telegram turns inherit the selected conversation's policy. Native read-only/no-approval profiles can deny the Telegram reply tool; these denials are preserved. A separate `--remote` endpoint cannot be combined with the managed
Telegram connection.

Noninteractive commands, help/version output and parser errors delegate directly
to Codex without requiring an installed Telegram plugin or starting its bridge.
The original `codex` binary and command remain unchanged.

On the native empty-history API gap, unchanged empty conversations retain their
saved context. A settings change on that cached conversation returns the native
pagination error instead of being reported as applied. The cache is removed once
the native API can read its history. Permission and workspace snapshots survive
controller restart.


## Combined installation update

Run `codex-telegram update` in the parent shell after exiting the attached TUI. A running Telegram turn finishes before update preparation. The installation must have its existing bridge launch profile and the npm-installed launcher.

The independent npm launcher first refreshes the configured `codex-telegram`
marketplace with Codex's native command, then resolves the installed plugin.
A broken installed updater can therefore be replaced before it is loaded.
An interrupted installation transaction instead resumes its retained coordinator
before another marketplace refresh. Refresh receives only native command settings
and the selected Git credential; runtime, transcription and bot keys are excluded.

Existing 0.4.6/0.4.7 npm launchers lack that bootstrap. Migrate those installations
once with `codex plugin marketplace upgrade codex-telegram`, followed by
`codex-telegram update`. The second command installs the new npm launcher too.

The updater recognizes an owner-controlled managed launcher left dangling by a
pruned Codex cache. It installs a durable recovery build and reuses the saved
profile, including recovery of a stopped service, before continuing the update.
Do not repair cache links by hand or create a replacement conversation.

The updater uses the same lock and durable journal for the CLI, native plugin and launcher. It retains the complete native CLI package, launcher package, plugin and an independent coordinator before stopping the old backend. Codex's own `update` command updates the CLI. The launcher is packed from the refreshed native marketplace checkout, so its version matches the plugin, and installed into its existing npm prefix with lifecycle scripts disabled.

The replacement backend starts after all components are installed. Activation checks the existing conversation ID, workspace and permission mode, plus credential and pairing fingerprints. No replacement conversation is created. CLI state and authentication are outside the package backups.

Failures restore the retained code packages and entry points before restarting the prior plugin. An interrupted updater is recovered by the same command through the retained coordinator, without depending on a functioning Codex command. Existing in-flight updater subprocesses and unknown bridge owners are checked before recovery. Recovery copies remain available until the transaction commits.

This requires a self-updatable Codex package with its first-party package metadata and writable installation directories. Unsupported package layouts fail during preparation before changing the running backend. macOS functional acceptance remains unverified.
