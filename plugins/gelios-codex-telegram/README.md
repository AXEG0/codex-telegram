# Codex Telegram

Use the same Codex conversation from your terminal and Telegram. Includes message batching, edits, attachments, explicit reaction tools and an optional idle heartbeat. Automatic receipt reactions are disabled.

Requires Linux or macOS, Node 18+, and Codex CLI 0.162.0+ installed and logged in.

```sh
codex plugin marketplace add AXEG0/codex-telegram --ref main
codex plugin add telegram@codex-telegram
codex
```

In Codex, invoke `$telegram:configure` and select this plugin's configure skill. It prepares the local launcher. Exit Codex, then run:

```sh
~/.local/bin/codex-telegram
```

The guided launcher asks for your @BotFather token with input hidden, starts the shared backend, and lets you approve your bot's pairing code locally. It then opens Codex's terminal interface. Later launches attach to the existing conversation; quitting the terminal leaves Telegram connected.

Paired users can operate Codex with full filesystem access and no approval prompts. Pair only people you trust. Tokens and access approvals stay in your local terminal. `$telegram:access` inspects pairing and explains local access commands.

For a custom workspace, use `~/.local/bin/codex-telegram --workspace /path/to/project` on first launch. A saved launch profile retains the original workspace and credential environment names.

## Updates and existing installations

Install the new public plugin with the two commands above, then refresh the skill list and invoke its `$telegram:configure` skill in your existing conversation. Run the guided launcher outside Codex after the current turn finishes and the attached terminal exits. It migrates an existing Gelios installation through the native updater, preserves state and conversation history, and removes the old plugin selection. Existing state paths, environment names and the legacy launcher remain compatible. The old marketplace can remain configured without supplying the active plugin.

For later updates, exit the attached terminal and run:

```sh
~/.local/bin/codex-telegram update
~/.local/bin/codex-telegram
```

Updates retain a durable recovery copy before changing package caches. See [operation and recovery details](https://github.com/AXEG0/codex-telegram/blob/main/docs/operations.md).

MIT licensed; original copyright and contributor attribution are preserved in [LICENSE](LICENSE) and [AUTHORS.md](AUTHORS.md). Report vulnerabilities privately using [SECURITY.md](https://github.com/AXEG0/codex-telegram/blob/main/SECURITY.md).
