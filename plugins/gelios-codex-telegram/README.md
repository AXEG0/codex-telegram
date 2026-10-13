# Gelios Codex Telegram plugin

This installable Codex plugin contributes `telegram_reply`, `telegram_react`,
`telegram_edit_message` and `telegram_download_attachment` MCP tools. The
Telegram adapter handles the channel; the session
controller owns one Codex app-server and the shared conversation.
MCP initialization automatically supplies the collaboration guide in
`src/telegram-instructions.md`, including Telegram reply routing, edits, media
recovery and access constraints. No collaboration skill is bundled.
The bridge can optionally transcribe authorized voice/audio with OpenAI when
started with `--transcription-api-key-env <ENVIRONMENT_VARIABLE_NAME>`.
For private marketplace updates, detached startup also accepts
`--marketplace-auth-env <ENVIRONMENT_VARIABLE_NAME>` and records only that slot
name in its owner-only launch profile. Repeat
`--codex-runtime-env <ENVIRONMENT_VARIABLE_NAME>` for any explicitly selected
credential slots that the agent's Codex process must retain.

The plugin never sends Codex output automatically. Codex chooses each outbound
Telegram message by calling `telegram_reply`, which renders Markdown as native
Telegram formatting and preserves entities across long-message splits.
Use `gelios-codex-telegram tui` to attach the native Codex TUI. It follows
conversation changes from Telegram automatically by replacing only its UI
process; the controller keeps the backend and all existing conversations.
Bursts preserve source identities, reply context and media. User-message edits
arrive as identifiable updates. Incoming delivery never adds automatic
reactions. Agent-callable reactions remain available, and startup retires
legacy receipts without erasing agent-chosen reactions.

An optional persistent heartbeat is disabled by default. Configure it with
`gelios-codex-telegram heartbeat enable --every 1h --prompt-file /path/prompt`;
inspect it with `heartbeat status` and stop it with `heartbeat disable`.
It starts an idle turn on the selected conversation, defers human work and
coalesces missed ticks. It uses the existing bridge and Codex connection.

Inbound Telegram replies retain their native context. An explicitly selected
quote takes precedence over the full parent; otherwise the bridge supplies the
parent text, caption, and media kind. A bounded owner-only cache recovers parent
content omitted by Telegram after a restart. The bridge gives the app-server
that context as explicitly untrusted JSON in a separate input item from the
current user message.

Inbound photos reach the app-server immediately as private `localImage` input
and also carry an opaque attachment handle. The handle keeps the retained
owner-only inbox file recoverable through `telegram_download_attachment` after
Codex compacts the original image input.

A restarted bridge restores the Telegram-bound conversation without waiting for
a terminal, and `--systemd-unit <name>.service` lets a systemd user service
supervise the bridge, including across updates.

See the repository README for installation, configuration, and operation.
After detached startup has written the profile, run
`gelios-codex-telegram update` from the parent terminal with no TUI attached.
That is the complete operator command. Each changed plugin artifact requires a
new manifest version or cachebuster; the updater rejects different content
published under the running version before stopping the bridge.
An identical same-version candidate still replaces the verified bridge so its
child app-server starts from the currently installed Codex binary.
The updater arms a private cache-independent snapshot, records every cutover
phase, and recovers interrupted or failed updates through exact bridge-instance
control rather than PID signals.
