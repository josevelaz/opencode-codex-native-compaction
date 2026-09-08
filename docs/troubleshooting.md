---
title: Troubleshooting
description: Diagnose missing native checkpoints, model mismatches, and backend errors.
---

# Troubleshooting

First confirm the OpenCode version, selected provider, model, variant, and subscription route. The recorded tested build is `v0.0.0-beta-18286`; a newer beta can change hooks or request formats.

## Enable debug output

Set the plugin's `debug` option to `true` as shown in [Getting started](getting-started.html#configuration-reference), then restart the OpenCode service. The plugin writes JSON records to service stderr with `plugin: "codex-native-compaction"`.

Useful messages include:

- `native compaction dispatched`: the request was changed to native compaction.
- `native checkpoint stored`: the response produced checkpoint data.
- `compaction committed`: OpenCode committed the marker and the checkpoint became active.
- `native compaction skipped for unsupported durable history`: the first native compaction fell back to the normal path.
- `lifecycle event failed`: a session event could not be processed; inspect the attached error.

Inspect your OpenCode service logs or captured stderr. Log handling depends on how you run the service. Turn debug off after diagnosis. Redact prompts, tool input, file contents, credentials, and private paths before sharing logs.

## No checkpoint marker appears

1. Check that the plugin is in `plugins` and the service restarted successfully.
2. Confirm the model uses your ChatGPT/Codex subscription, not an OpenAI API key.
3. Send a normal prompt on that model before requesting compaction.
4. Enable debug output and try in a disposable session. An unsupported history format can leave the first compaction on OpenCode's normal path.

The plugin does not control the compaction threshold. A normal turn alone does not create a checkpoint.

## Model or context errors

| Error | Action |
| --- | --- |
| `native compaction has no finalized normal request context` | Send a normal prompt on the intended subscription model, then retry compaction. |
| `native compaction context requires ...` | Use the provider, model, and variant named in the error. |
| `native compaction checkpoint requires ...` | Switch back to the model and variant that created the checkpoint. |
| `tail compaction requires switching back ...` | Return to the checkpoint's original OpenAI subscription model before compacting. |
| Compaction stays running after an error | Reload the plugin or restart the OpenCode service, then retry. A failed attempt should clear uncommitted pending state; a reload clears in-memory leftovers from older plugin versions. |

When another provider gets a warning about missing older context, that warning is expected. It can continue with messages after the checkpoint, but cannot read the opaque earlier context.

## Missing or malformed checkpoints

Errors about a missing checkpoint, malformed pointer, duplicate marker, or unexpected marker mean the transcript and stored checkpoint cannot be resolved safely.

- Keep the existing data and logs. Do not edit marker IDs or delete storage to make the error disappear.
- Confirm you are using the same OpenCode data store as the original session.
- If the checkpoint data is lost, start a new session and provide the context it needs. The marker alone cannot recover the old context.

Removing the plugin is not a recovery method for native-checkpoint sessions.

## HTTP or streaming errors

`OpenAI Codex compaction failed with HTTP ...` means the backend rejected the request. Check subscription authentication and whether ordinary requests work. Retry only after resolving authentication or service availability problems.

Errors about malformed events, missing completion, missing encrypted content, or a compaction-item count other than one can indicate a backend protocol change. Preserve a redacted error report. Do not change stored checkpoints to fit a new response format.

## Report an issue

Include:

- Plugin version or Git commit and OpenCode version.
- Provider, model ID, variant, and whether authentication uses a subscription.
- Whether the failure happened before or after the first native checkpoint.
- Reproduction steps and the exact redacted error.
- Relevant debug event names, without raw checkpoint payloads or private conversation data.

Open an issue in the [GitHub repository](https://github.com/josevelaz/opencode-codex-native-compaction/issues).
