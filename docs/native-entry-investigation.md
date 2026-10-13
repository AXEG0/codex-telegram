# Native entry investigation

This branch preserves an incomplete prototype. It is not a release candidate.
The requested flow is two native plugin installation commands, `codex --yolo`,
then configuration and pairing through the packaged skills in that terminal.

## Verified behavior

A real Codex 0.162.0 terminal loaded the installed plugin and its lifecycle hooks.
The real agent configured the bot and approved pairing. Its own transcript
records both commands and its completed Telegram reply refusing a remotely
requested access-policy change. The Telegram API was a local fixture.

The plugin connects to the native background server instead of creating another
Codex backend. Authorization checks compare the hook request with the current
recorded native turn and reject remote, completed and consumed requests.
Fourteen focused authorization/WebSocket tests passed. The default suite passed
192 tests and skipped 11 opt-in integrations; those results do not establish
native lifecycle acceptance.

## Failed acceptance

The real native terminal selected conversation A after conversation B had been
selected. A remained loaded in the native server. Without sending another model
prompt, the terminal's `/status` identified A while Telegram still targeted B.
The diagnostic asserts that both IDs match and fails that assertion. Its cleanup
left no owned fixture directories or processes.

Restarting the controller while the native thread remains loaded also needs
recovery work. Legacy migration and native fork behavior are not accepted.
Removing Telegram's `/new` command does not remove the terminal-selection case:
the diagnostic does not issue Telegram `/new`.

## Owning source

The following mechanisms were read in the official Codex source at
`rust-v0.162.0` and `rust-v0.162.1`:

- [Session construction](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/session/session.rs):
  queues a SessionStart hook when constructing a session, rather than on every
  client selection of an already-loaded thread.
- [Thread resume](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/thread_processor.rs):
  resumes an already-running thread through its existing listener.
- [Resume response](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/thread_lifecycle.rs):
  responds to the requesting client and restores its subscriptions; it does not
  publish that client's terminal selection to this plugin.
- [Protocol](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server-protocol/src/protocol/common.rs):
  contains thread lifecycle notifications but no terminal-selection notification
  consumed by this integration.
- [Scoped notifications](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/outgoing_message.rs):
  target the thread's subscribed connections. Thread creation alone cannot
  establish which conversation a terminal currently displays.

The 0.162.1 patch changes daemon startup behavior without changing these thread
protocol and lifecycle files. Its binary was not exercised.

The missing integration is an authoritative notification of the terminal's
selected conversation, including idle resume and selection of loaded threads.
Thread creation times, log polling and the most recently created thread do not
prove that selection.

Preparation and review remain tracked in
https://redirect.github.com/AXEG0/codex-telegram/issues/2 and
https://redirect.github.com/AXEG0/codex-telegram/pull/4. No runtime was updated.
