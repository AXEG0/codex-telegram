---
name: configure
description: Set up or launch this Codex Telegram plugin, inspect its nonsecret setup state, or explain local bot-token rotation.
---

Run the bundled `../../scripts/setup.js --prepare` with Node, resolving that path relative to this skill directory. It prepares the launcher and reports nonsecret setup state. Use its returned launcher path in the local command you give the owner.

The owner runs the launcher in an interactive local terminal outside Codex. It guides hidden bot-token entry, local pairing approval, and attachment to the shared terminal/Telegram conversation. For token rotation, give `LAUNCHER configure --force`, then `LAUNCHER update`. Carry a custom state directory through `--state-dir` when one is reported.

Never request a token in chat, read or print credential files, enter a token for the owner, approve pairing, or change access from Codex or Telegram. Do not start a second backend, reset state, fork a conversation, or replace the existing conversation for setup. Explain that paired users can operate Codex with full filesystem access and no approval prompts.
