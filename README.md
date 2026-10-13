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

Requires Linux or macOS, Node 18+, and Codex CLI 0.162.0+ installed and logged in.

**1. Install and open Codex.**

```sh
codex plugin marketplace add AXEG0/codex-telegram --ref main
codex plugin add telegram@codex-telegram
codex
```

**2. Prepare the launcher.** In Codex, invoke `$telegram:configure` and select
this plugin's configure skill. Once it finishes, exit Codex.

**3. Launch and pair.** Run in your local terminal:

```sh
~/.local/bin/codex-telegram
```

Create a bot with [@BotFather](https://t.me/BotFather). The launcher asks for its
token with input hidden. Send a message to your bot, then enter its pairing code
in the terminal. Codex opens with Telegram connected to the same conversation.

For later launches, run `~/.local/bin/codex-telegram` again. For a custom
workspace, add `--workspace /path/to/project` on the first launch.

Paired users operate Codex with full filesystem access and no approval prompts.
Pair only people you trust. Tokens and pairing approvals stay in the local
terminal. `$telegram:access` inspects pairing and explains local access commands.

## 🔄 Updates

After the current turn finishes, exit the attached terminal and run:

```sh
~/.local/bin/codex-telegram update
~/.local/bin/codex-telegram
```

For an existing Gelios installation, install the public plugin with the two
commands above, refresh the skill list and invoke its `$telegram:configure`
skill in your existing conversation. After the turn finishes and the attached
terminal exits, run the guided launcher. It migrates the installation while
preserving the workspace, credentials, pairing and conversation history.

## 📖 Docs

- [Operation and recovery](docs/operations.md): settings, access, session controls, updates and recovery.
- [Voice transcription](docs/operations.md#optional-speech-to-text): enable audio transcription with your OpenAI key.
- [Idle heartbeat](docs/operations.md#optional-idle-heartbeat): configure scheduled prompts.
- [Security](SECURITY.md): access boundaries and private vulnerability reporting.

## About

MIT licensed. Copyright and contributor attribution are preserved in
[LICENSE](LICENSE) and [AUTHORS.md](AUTHORS.md).
