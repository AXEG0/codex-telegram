<div align="center">

# Telegram for Codex

**Talk to your Codex session from Telegram.**

[![Codex](https://img.shields.io/badge/Codex-Telegram_plugin-412991)](plugins/gelios-codex-telegram/README.md)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

One Codex conversation, shared between your terminal and Telegram. Send a message
to your bot; Codex can answer, send files, edit its replies and choose reactions.
Closing the terminal leaves Telegram connected.

## ✨ Features

| Feature | What you get |
| --- | --- |
| 💬 **Shared conversation** | Terminal and Telegram use the same context. Selecting or forking a conversation in the managed terminal moves Telegram with it. |
| 📦 **Message batching** | Quick texts and photos arrive together, including a photo and its question. |
| ✏️ **Message edits** | Correct a message you sent, and Codex receives the updated text. Codex can also edit its own replies. |
| ↩️ **Reply context** | Your reply includes the original message or the passage you quoted. |
| 📎 **Photos and files** | Send images and attachments to Codex, and receive images and documents back. |
| 🎙️ **Voice messages** | Optional OpenAI transcription turns voice notes and audio into text, retaining the original attachment. |
| 👍 **Chosen reactions** | Codex chooses each reaction through a tool. Automatic receipt reactions are disabled. |
| ⏰ **Idle heartbeat** | An optional scheduled prompt wakes the same conversation when idle and waits while it is busy. |
| 🎛️ **Session controls** | Paired administrators can choose the model and reasoning effort from Telegram. |

## 🚀 Quick start

Requires Linux or macOS, Node 18+ with npm, and Codex CLI 0.162.0+ installed and logged in.

Install the native plugin and its launcher:

```sh
codex plugin marketplace add AXEG0/codex-telegram --ref main
codex plugin add telegram@codex-telegram
npm install --global github:AXEG0/codex-telegram
```

Launch the shared Codex session:

```sh
codex-telegram --yolo
```

The launcher starts the bridge and opens Codex attached to it. The terminal and
Telegram use one conversation, including when you select or create another
conversation in the terminal. The launcher uses your native installed plugin;
it does not reinstall or enable plugins.

Create a bot with [@BotFather](https://t.me/BotFather), then configure and pair
inside that Codex terminal:

```text
$telegram:configure TOKEN
$telegram:access pair CODE
```

Replace `TOKEN` with your bot token. Send a message to your bot to get `CODE`.
The skills save the token and approve pairing without leaving Codex. Access
changes accept only a matching request entered in the local terminal.

The token you paste enters the CLI conversation and model context. Paired users share the conversation’s permissions. `--yolo` selects full
filesystem access without approval prompts; pair only people you trust.

Native commands retain their names: `codex-telegram resume --last`,
`codex-telegram fork --last`, and `codex-telegram plugin list --json`.
Codex handles their arguments. Noninteractive commands run without starting the
Telegram bridge. Telegram controls use `codex-telegram telegram`, including
`codex-telegram telegram status`. The wrapper owns `codex-telegram update`: it updates Codex CLI, the plugin and the npm launcher together. Plain `codex update` keeps its native behavior.

For later launches, run `codex-telegram --yolo`. On first launch, a custom
workspace can be selected with `codex-telegram --yolo -C /path/to/project`.
`$telegram:access` without arguments shows access
status; `$telegram:access policy allowlist` ends pairing once everyone is added.

## 🔄 Updates

Exit the attached Codex terminal and run the following from your shell. The updater waits for a running Telegram turn to finish:

```sh
codex-telegram update
codex-telegram --yolo
```

For an existing Gelios installation, install the native plugin and launcher,
wait for the current
turn to finish and exit its attached terminal, then run `codex-telegram --yolo`.
It migrates the installation while
preserving the workspace, credentials, pairing and conversation history.

The updater retains recovery copies before changing components, restarts the existing conversation and verifies its workspace, permissions, credentials and pairing. If interrupted, run the same update command to recover and continue, including when the Codex command is temporarily unusable. `codex-telegram telegram update` is an alias for the combined updater.

## 📖 Docs

- [Operation and recovery](docs/operations.md): settings, access, session controls, updates and recovery.
- [Voice transcription](docs/operations.md#optional-speech-to-text): enable audio transcription with your OpenAI key.
- [Idle heartbeat](docs/operations.md#optional-idle-heartbeat): configure scheduled prompts.
- [Security](SECURITY.md): access boundaries and private vulnerability reporting.

## About

MIT licensed. Copyright and contributor attribution are preserved in
[LICENSE](LICENSE) and [AUTHORS.md](AUTHORS.md).
