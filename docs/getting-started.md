---
title: Getting started
description: Install the plugin and confirm that OpenCode uses native Codex compaction.
---

# Getting started

This guide is for OpenCode users with an OpenAI ChatGPT/Codex subscription. It takes you from plugin installation to a native checkpoint.

## 1. Check compatibility

| Requirement | Supported target |
| --- | --- |
| OpenCode | V2; recorded tested build `v0.0.0-beta-18286` |
| Provider | `openai`, authenticated through a ChatGPT/Codex subscription |
| Request route | HTTPS on `chatgpt.com`, path starting `/backend-api/codex/` and ending `/responses` |
| Package runtime | TypeScript ESM loaded by OpenCode; package declares Node.js `>=24` |

V1 is not supported. API-key requests to the public OpenAI API do not activate native compaction. Newer OpenCode V2 builds can change the beta plugin API or history format; test them in a disposable session before using existing checkpoints.

## 2. Load the plugin

### From npm

Once the package has a published release, add it to `plugins` in your OpenCode config. Use `~/.config/opencode/opencode.jsonc` for all projects, or a project `opencode.jsonc` for that project. Add the entry without replacing your existing plugins or settings.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@josevelaz/opencode-codex-native-compaction"]
}
```

For a fixed version, use `@josevelaz/opencode-codex-native-compaction@<version>`, replacing `<version>` with an actual published version. Check the [releases](https://github.com/josevelaz/opencode-codex-native-compaction/releases) before choosing one.

### From a local checkout

Use this method before the first npm release or when testing a change. Install Bun with lockfile v2 support (1.4 or later) and Node.js 24 or later, then run:

```sh
git clone https://github.com/josevelaz/opencode-codex-native-compaction.git
cd opencode-codex-native-compaction
bun install --frozen-lockfile
```

Add the checkout's absolute directory path to your OpenCode config. Replace the example path with the directory you cloned:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/opencode-codex-native-compaction"]
}
```

Use one installation method at a time. Do not load the same plugin from both npm and a local path.

## 3. Restart and use the subscription model

```sh
opencode2 service restart
opencode2 service status
```

In OpenCode, select an OpenAI model connected through your subscription. Send a normal prompt before compacting: the plugin needs the finalized normal request context, including system instructions and tool definitions.

Let OpenCode trigger compaction, or use its compaction control. The plugin has no separate command or threshold setting.

## 4. Confirm a checkpoint

After a successful native compaction, the transcript contains:

```text
OpenAI Codex native checkpoint [oc-codex:v1:<uuid>]
```

The UUID identifies checkpoint data in OpenCode plugin storage. Continue on the same OpenAI model and variant to replay it. A normal text summary instead of this marker can mean the route is unsupported or the plugin fell back before creating its first native checkpoint.

See [Troubleshooting](troubleshooting.html) if the marker does not appear.

## Configuration reference

The only supported plugin option is `debug`. It defaults to `false` and must be a boolean:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@josevelaz/opencode-codex-native-compaction",
      "options": { "debug": true }
    }
  ]
}
```

Debug mode writes JSON records to the OpenCode service's stderr. Use the same object form with a local directory path if you installed from a checkout.

## Disable or upgrade safely

Start a new session when changing to an unverified OpenCode build or removing the plugin. Removing the config entry does not turn native checkpoints into text summaries. A copied transcript alone cannot restore the stored checkpoint.

Keep your existing OpenCode data until you have verified that the sessions you need still work. Read [storage and privacy](how-it-works.html#storage-and-privacy) before sharing logs or moving session data.
