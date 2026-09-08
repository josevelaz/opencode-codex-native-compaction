---
title: How it works
description: Checkpoint flow, model restrictions, retention limits, and data handling.
---

# How it works

OpenCode normally asks a model for a text summary when it compacts a conversation. This plugin replaces that request on a supported Codex subscription route. Codex returns an opaque compaction item, which the plugin stores and replays on future requests.

## Checkpoint flow

1. **Capture request context.** On a normal OpenAI subscription turn, the plugin stores the request settings, system instructions, tool definitions, and model identity.
2. **Project durable history.** When OpenCode starts compaction, the plugin uses OpenCode's `toLLMMessages` path to convert durable session records into model-facing history. This includes supported user, assistant, system, synthetic, skill, shell, and location records.
3. **Restore earlier context.** If the session already has a native checkpoint, the plugin includes its replacement history.
4. **Request native compaction.** The plugin adds `remote_compaction_v2` to `x-codex-beta-features` and sends a `compaction_trigger` item. The request uses `store: false` and streaming responses.
5. **Store the result.** The plugin requires one compaction item with non-empty `encrypted_content` and a completed response. It stores replacement history through OpenCode's plugin storage API.
6. **Commit a marker.** The transcript receives this host-compatible summary:

   ```markdown
   ## Additional Context
   OpenAI Codex native checkpoint [oc-codex:v1:<uuid>]
   ```

   The heading is required by current OpenCode summary validation. The checkpoint ID, stored opaque payload, and recognition of older bare markers stay the same. Once OpenCode confirms compaction, the checkpoint becomes active.
7. **Replay.** Later requests on the original OpenAI model and variant replace the marker with the stored history and append the messages after it.

Warm-up requests without tools can use the checkpoint without replacing the last durable tool-bearing request context used for compaction.

## Retained history and images

The plugin uses a **64,000 estimated-token budget** for retained text alongside the native compaction item. It subtracts the estimated size of OpenCode's retained recent text first. This is not a compaction trigger or the model's context-window size.

Token estimates use roughly one token per four characters. The retained text selection includes non-empty user, developer, and system messages. An item that does not fit is skipped rather than truncated. This is separate from the full history sent to Codex for compaction.

When estimated image payload exceeds **25 MiB**, the plugin replaces images with an explicit removal notice until the remaining estimate is at most **15 MiB**. This applies to relevant outgoing subscription requests as well as compaction. The notice tells the model to retrieve or request the image again instead of claiming to remember its contents.

## Provider and model switching

| Request after a checkpoint | Behavior |
| --- | --- |
| Original OpenAI subscription model and variant | Replays the checkpoint and later messages. |
| Different OpenAI subscription model or variant | Rejects checkpoint replay. Switch back to the original model and variant. |
| Another provider or non-subscription route, with a checkpoint marker in the request | Sends only messages after the checkpoint and adds a durable warning. |
| Compaction on that alternate route | Rejects compaction so the native checkpoint boundary is not replaced. |

The warning is not a summary of the older context. Work on another provider proceeds without that context. Return to the original OpenAI model and variant to restore it.

Before a native checkpoint exists, unsupported providers and routes keep their normal compaction path. If durable history cannot be encoded, the plugin also leaves the normal compaction request unchanged when there is no active native checkpoint. With an active checkpoint, encoding errors stop the request.

## Storage and privacy

The plugin stores these records through OpenCode's `ctx.storage` API:

- Opaque Codex compaction data and retained message history.
- System instructions, tool schemas, request settings, and model identity.
- Active checkpoint pointers and model-switch warning flags.

The transcript marker contains a random checkpoint ID, not the opaque provider payload. **This does not mean all stored context is encrypted.** The plugin does not implement storage encryption, and retained text and request context can contain sensitive data.

Projected conversation history and checkpoint data are sent to the OpenAI Codex subscription endpoint. `store: false` is a request setting, not a guarantee about every part of provider-side retention. This project does not define OpenAI's data policy.

Session forks copy checkpoint and request-context records to the child session. On session deletion, the plugin explicitly removes request context and the active pointer, but does **not** remove all `checkpoint/` or warning records. Do not assume that deleting a session erases all plugin data.

Do not remove checkpoint storage while you still need sessions that reference it. A missing checkpoint cannot be reconstructed from its UUID marker. The storage backend and location are managed by OpenCode; this plugin does not define a separate storage directory or cleanup command.

## Failure handling

The plugin rejects missing, malformed, duplicate, or incompatible checkpoints. It also rejects HTTP errors, malformed server-sent events (SSE), incomplete streams, and responses without exactly one valid compaction item. It does not intentionally convert an unreadable checkpoint into an incomplete text summary.

If OpenCode retries the same compaction after the plugin has stored a checkpoint, the plugin replays that marker instead of starting a second native compaction. A failed attempt removes only uncommitted checkpoint data and leaves a previously active checkpoint in place. A delayed terminal event cannot clear a newer attempt.

See [Troubleshooting](troubleshooting.html) for error messages and recovery steps.
