---
title: Overview
description: Replace OpenCode text compaction with native OpenAI Codex checkpoints.
---

# Native checkpoints for OpenCode

`@josevelaz/opencode-codex-native-compaction` replaces OpenCode's text compaction request with OpenAI Codex `remote_compaction_v2`. Later turns replay the provider's opaque checkpoint instead of relying only on a text summary.

The plugin applies to OpenAI ChatGPT/Codex subscription requests. Other routes keep OpenCode's normal compaction behavior unless the session already contains a native checkpoint.

> **Experimental compatibility:** the recorded tested OpenCode build is `v0.0.0-beta-18286`. Dependencies pin that API. Newer V2 builds are not verified. The plugin uses a Codex subscription backend feature, not the public OpenAI API compaction endpoint.

## Start here

- **[Getting started](getting-started.html):** install from npm or a local checkout, select a supported route, and confirm compaction.
- **[How it works](how-it-works.html):** understand checkpoints, retained history, model switching, and stored data.
- **[Troubleshooting](troubleshooting.html):** enable debug output and resolve common failures.

## Before using a long-running session

Keep the model and variant that created the checkpoint available. Another provider cannot interpret it. Keep the plugin's stored checkpoint data too: the transcript contains only its ID, not a portable summary.

The plugin does not add its own compaction schedule. OpenCode controls the automatic threshold and recent history kept in the conversation.

## For maintainers

- **[Development](development.html):** validate the package, inspect its contents, and update this site.
- **[Releases](releases.html):** publish through the manual release workflow and maintain release lines.

Source code and issue tracking are on [GitHub](https://github.com/josevelaz/opencode-codex-native-compaction). The project uses the MIT license.
