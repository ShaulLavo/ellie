Plan

The key architectural rule is: do not bolt ElevenLabs directly into the WhatsApp provider.
To match OpenCLAW, we should make this a channel-agnostic reply/media pipeline, then let WhatsApp consume it through the existing sendMedia() path in apps/server/src/channels/providers/whatsapp/provider.ts:492.
Ellie already has the two hardest pieces:
ElevenLabs synthesis in apps/server/src/lib/tts.ts:51
WhatsApp audio/media sending in apps/server/src/channels/providers/whatsapp/provider.ts:492
The main missing piece is that delivery is still text-only in apps/server/src/channels/core/delivery-registry.ts:155.

Phase 1

Add a generic reply payload layer, e.g. apps/server/src/channels/core/reply-payload.ts.
Model it after OpenCLAW’s internal reply payload shape:
text?: string
mediaRefs?: string[]
audioAsVoice?: boolean
Add a directive parser compatible with OpenCLAW semantics:
MEDIA:<path-or-upload-ref>
[[audio_as_voice]]
Keep this parser delivery-only, so we do not need to widen assistant_message schema yet in packages/schemas/src/agent.ts:135.

Phase 2

Refactor apps/server/src/channels/core/delivery-registry.ts:147 so it extracts a ChannelReplyPayload instead of plain text.
Replace #extractFinalAssistantText() with something like #extractFinalReplyPayload().
Delivery behavior should become:
text only → provider.sendMessage(...)
media present → provider.sendMedia(...)
later: poll/reaction support can plug into the same payload contract
Preserve existing fan-out behavior to all contributing targets.

Phase 3

Add a media resolver utility, e.g. apps/server/src/channels/core/media-resolver.ts.
It should turn a MEDIA: reference into:
buffer
mimetype
fileName
Support the two sources we already have or will need:
local temp file paths
upload/blob references from the existing upload/blob stack
Add guardrails:
reject unsupported refs
size-limit media before loading
only allow known local roots / blob sources

Phase 4

Wire the explicit TTS path exactly like OpenCLAW.
Add a helper that wraps apps/server/src/lib/tts.ts and returns a reply-media result instead of just a raw HTTP response shape.
For tool/command-driven TTS, make the result produce a normalized reply payload:
either direct ChannelReplyPayload
or OpenCLAW-style text directives (MEDIA: plus optional [[audio_as_voice]])
Prefer the payload route internally, but keep directive parsing support so the system stays OpenCLAW-compatible.

Phase 5

Add maybeApplyTtsToPayload() in Ellie, likely in a new file like apps/server/src/channels/core/reply-tts.ts.
This should run before final delivery, not inside WhatsApp.
Match OpenCLAW behavior:
off
always
inbound
tagged
Gating rules:
skip if payload already has media
skip if reply text is too short
skip when mode is inbound and inbound message was not speech-derived
support tagged mode for explicit TTS-only replies
Transform rules:
strip markdown before synthesis
enforce max length
if you want full OpenCLAW parity, add summary/truncate behavior before synthesis

Phase 6

Reuse the existing WhatsApp send path instead of inventing new provider code.
apps/server/src/channels/providers/whatsapp/provider.ts:517 already sends audio with ptt: true, which is the exact OpenCLAW-style WhatsApp behavior.
Small WhatsApp-side adjustments only:
ensure typing indicator also happens for media replies
ensure caption rules match OpenCLAW
keep audio replies textless by default unless a fallback caption is explicitly desired

Phase 7

Add config and tests so this is production-safe.
Config surface:
global TTS auto mode
optional per-channel/per-account override later
max text length
tagged/inbound behavior
Tests to add:
reply payload parser for MEDIA: and [[audio_as_voice]]
delivery registry text-vs-media routing
media resolver path/upload handling
maybeApplyTtsToPayload() mode tests
WhatsApp audio send test asserting ptt: true
end-to-end flow: inbound voice note → STT → agent reply → auto-TTS → outgoing WhatsApp audio
Recommended Order

First do Phase 1 + Phase 2 + Phase 3.
Then add Phase 5.
Leave WhatsApp provider changes minimal, because sendMedia() is already basically correct.
That gives you the OpenCLAW architecture without overcomplicating the provider layer.
Important Design Choice

Because Ellie’s assistant_message schema is still text-only in packages/schemas/src/agent.ts:135, the cleanest OpenCLAW-style implementation is:
keep assistant output textual
normalize it into a reply payload at delivery time
attach media there
That is closer to OpenCLAW than expanding assistant messages to carry audio blocks directly.
If you want, I can turn this into a concrete file-by-file patch plan next, with exact functions to add/change in delivery-registry.ts, lib/tts.ts, and the WhatsApp provider.
