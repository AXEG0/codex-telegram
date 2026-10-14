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

Install and launch:

```sh
codex plugin marketplace add AXEG0/codex-telegram --ref main
codex plugin add telegram@codex-telegram
npm install --global github:AXEG0/codex-telegram
codex-telegram --yolo
```

Create a bot with [@BotFather](https://t.me/BotFather), then configure and pair
inside Codex:

```text
$telegram:configure TOKEN
$telegram:access pair CODE
```

Replace `TOKEN` with your bot token. Send a message to your bot to get `CODE`.
For later launches, run `codex-telegram --yolo` again.

The token enters the Codex conversation and model context. `--yolo` gives Codex
full access without approval prompts; pair only people you trust.

## 🔄 Updates

Exit the Codex terminal and run this in your shell to update Codex, the plugin
and launcher while keeping the same conversation:

```sh
codex-telegram update
```

## 📖 Docs

- [Operation and recovery](docs/operations.md): settings, access, session controls, updates and recovery.
- [Voice transcription](docs/operations.md#optional-speech-to-text): enable audio transcription with your OpenAI key.
- [Idle heartbeat](docs/operations.md#optional-idle-heartbeat): configure scheduled prompts.
- [Security](SECURITY.md): access boundaries and private vulnerability reporting.

## About

MIT licensed. Copyright and contributor attribution are preserved in
[LICENSE](LICENSE) and [AUTHORS.md](AUTHORS.md).
