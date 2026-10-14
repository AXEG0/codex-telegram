<div align="center">

# Telegram for Codex

**Talk to your Codex session from Telegram.**

[![Codex](https://img.shields.io/badge/Codex-Telegram_plugin-412991)](README.md)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/AXEG0/codex-telegram/blob/main/LICENSE)

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

Requires Linux or macOS, Node 18+, curl, and Codex CLI 0.162.0+ installed and logged in.

Install the plugin:

```sh
codex plugin marketplace add AXEG0/codex-telegram --ref main
codex plugin add telegram@codex-telegram
```

Launch the shared Codex session:

```sh
curl -fsSL https://raw.githubusercontent.com/AXEG0/codex-telegram/main/launch.sh | sh
```

Create a bot with [@BotFather](https://t.me/BotFather), then configure and pair
inside that Codex terminal:

```text
$telegram:configure TOKEN
$telegram:access pair CODE
```

Replace `TOKEN` with your bot token. Send a message to your bot to get `CODE`.
The skills save the token and approve pairing without leaving Codex. Access
changes accept only a matching request entered in the local terminal.

The token you paste enters the CLI conversation and model context. Paired users
operate Codex with full filesystem access and no approval prompts; pair only
people you trust.

For later launches, run `~/.local/bin/codex-telegram`. On first launch, a custom
workspace can be selected with `sh -s -- --workspace /path/to/project` in place
of `sh` in the launch command. `$telegram:access` without arguments shows access
status; `$telegram:access policy allowlist` ends pairing once everyone is added.

## 🔄 Updates

After the current turn finishes, exit the attached terminal and run:

```sh
~/.local/bin/codex-telegram update
~/.local/bin/codex-telegram
```

For an existing Gelios installation, install the public plugin with the two
commands above, wait for the current turn to finish and exit its attached terminal,
then run the launch command above. It migrates the installation while
preserving the workspace, credentials, pairing and conversation history.

## 📖 Docs

- [Operation and recovery](https://github.com/AXEG0/codex-telegram/blob/main/docs/operations.md): settings, access, session controls, updates and recovery.
- [Voice transcription](https://github.com/AXEG0/codex-telegram/blob/main/docs/operations.md#optional-speech-to-text): enable audio transcription with your OpenAI key.
- [Idle heartbeat](https://github.com/AXEG0/codex-telegram/blob/main/docs/operations.md#optional-idle-heartbeat): configure scheduled prompts.
- [Security](https://github.com/AXEG0/codex-telegram/blob/main/SECURITY.md): access boundaries and private vulnerability reporting.

## About

MIT licensed. Copyright and contributor attribution are preserved in
[LICENSE](https://github.com/AXEG0/codex-telegram/blob/main/LICENSE) and [AUTHORS.md](https://github.com/AXEG0/codex-telegram/blob/main/AUTHORS.md).

The MCP server declares `"omit_tools_from": ["deferred"]`, so each new
conversation receives the Telegram tools and their guide on its first request.
