import Spec.Channels.Model

/-!
ChannelAdapter contract (shared/channels.ts:173): canHandle filters the request method/shape;
authenticate verifies credentials before parse is ever called. Under A1 false means no trusted
message. parse yields response, ignore, cleanup, context, message or ordered batch. Only message
enters run admission. Context persists without starting a run. Cleanup removes only the partition.
Actions close over the authenticated provider application's source; external SDK delivery success
is a contract, not a theorem. rehydrateAttachment restores a provider-authenticated reader.

Provider | Verification | Fields read for decisions and routing
Telegram | secret header constant-time equality | update_id, message (edits never run),
callback_query, chat.id, message_id, message_thread_id, from, text/caption, media; ignore bots,
unsupported updates and allow-list failures; question callbacks carry status/question/option.
Slack | SDK signingSecret, timestamp/body signature | type, event.type/subtype, bot_id,
user/channel/team, ts/thread_ts, text, files, channel_type; handshake response, context vs mention,
cleanup; ts deduplicates app_mention/message. replyIn source preserves incoming thread; thread
uses incoming thread or message ts. Neither changes app/channel. Stored source is reused later.
Discord | Ed25519 body/timestamp, or forwarder token derived from bot token | type, data,
application_id, token, channel_id, guild_id, member/user, message id, thread.parent_id,
content/attachments, mentions and command options; ping is response, bots/unsupported ignored.
Google Chat | transport.handleWebhook validates Authorization audience | type, message,
space.name, thread.name, sender, argumentText, attachment; bot/add/remove/allow-list decisions.
Teams | bearer JWT verified for appId and serviceUrl | type, text, from/recipient,
conversation, serviceUrl, channelData, attachments; only admitted message activities run.
GitHub | SDK x-hub-signature-256 | x-github-event/delivery, action, sender, repository,
issue/comment/pull_request/discussion; ping responds, configured event/action and allow lists gate.
Linear | signature + webhookTimestamp via SDK | type, action, data, actor, webhookTimestamp;
configured events/actions gate, issue/comment source identifies the reply destination.
Twilio | SDK signature over configured public URL and form body | MessageSid, From, To, Body,
NumMedia, MediaUrl/ContentType; missing public URL refuses verification; sender/channel gate.
Zalo | secret header constant-time equality | envelope data, event_name, message.chat.id,
from, message_id, text, photo/voice/document; unsupported/missing content ignored.
Pancake | query secret constant-time equality | page_id, conversation/customer, message ids,
text and attachment URLs; page/sender gates, captionless media uses URLs in dedup key.
WhatsApp | GET verify token or SDK HMAC body | object, entry.changes.value.metadata.phone_number_id,
messages.id/from/type/text/media, contacts; each credential holder keeps its own phone entries.
Meta | GET verify token or SHA256 HMAC body | object, entry.id, messaging sender/recipient,
message.mid/text/attachments/is_echo, postback; each holder keeps its own owner entries.
Instagram | Meta with object instagram | configured accountId is owner; text cap 950 bytes.
Messenger | Meta with object page | owner id fetched from /me with page token, memoised;
text cap 1900 characters. Provider lookup failure is not an unauthenticated fallback.

integrations.ts normalisation: both /v1/webhooks/account/channel and
/v1/webhooks/account/dev/endpoint/channel decode percent escapes or refuse malformed paths.
The old three-segment shape is absent. Stage listing is account+endpoint scoped; an empty stage
list is unknown_webhook_stage 404 even if no configured channel exists. Candidates are sorted
by localeCompare(agentId), filtered by config, adapter and canHandle, capped at 25. The lowest
verifying candidate receives, except routesEachEntry keeps scanning; a non-entry receiver ends
the scan even after earlier entry receivers. Cached receivers are reloaded and reverified;
failure is 503, no stale credential fallback. Cache TTL/capacity is operational, not durable auth.
An unclaimed account GET is 200 liveness. Unconfigured POST is 503, verification failure 401;
lookup failure 503, unknown account/path 404. Timing and logging are outside Private.

Target selection: workspace mismatch only when BOTH refs exist and differ. A missing ref is not
proof of workspace ownership. First default binding, else first binding, selects an execution
agent in the same account; missing bound agent falls back to credential holder. The capability
ceiling is that SELECTED agent, never necessarily the credential holder. Credentials for replies
come from the holder. Records append system instructions, union policies/denyTools, select original
workspace refs by workspaceId (empty selection leaves agent refs unchanged), and overlay partition.
Record sandboxImages are not applied here. tagRoles adds matching roles to actor policy identity.
Policies/role semantics and trusted tenant hooks are separate contracts: these theorems do not
prove that adding an arbitrary policy is a monotone operation in an unrelated policy engine.

Ingress normalisation: supplied message.events wins, else one user/content event is built. Event
and conversation keys are scoped by account+execution agent. Hooks may drop, rewrite text and
attach metadata to the latest user event; never rewrite routing source here. Question answers
bypass received hooks/inline commands. Typing/reactions are best effort. Admission deduplication
is the serialisable ingress store contract, retained until its records expire, not a permanent
infinite event history. Batch entries admit in order; a full queue may return Retry-After 503,
previously admitted entries deduplicate on redelivery. ACK deadline is 2000ms. Later replies use
rewritten source; explicit sendChannelReply trusts its caller's persisted source, not sender input.

commands.ts: parse trims, lowercases first token, matches /new,/clear,/compact,/steer,/stop,
/cancel,/queue,/help. compact is queued followup even bare; steer/queue rewrite only with text,
otherwise usage reply. queuedCommand requires one non-system user event and text-only parts.
Inline commands are enabled only for the explicit chat-channel set. Discord metadata maps names
onto first alias. Clear acquires a fenced lease (15 minutes), up to 100 batches, finally releases;
stop uses account+agent+conversation scope; compact runs under the drain lease. Storage failures
become generic command errors plus an internal error field. These storage operations are A2.

channel-media.ts: universal images; PDF on listed providers; audio/video on Google/Vertex.
Ingest takes at most 10 attachments, overflow/unreadable becomes text. Fetch deadline 30s,
image/attachment size limits are applied, fetched bytes are charged, sealed attachment-store links
are kept instead of bytes; without storage a broods-media reference rehydrates via the adapter.
Existing stored/tool media bypass initial native-type gating. Replays cap 20 objects/20MiB and
omit older images in batches of 10. Cache is 32MiB LRU. Provider fetch, transcription, S3 and
pinned-fetch address protection are external contracts here, not proved implementations.

media.ts/ticket: ml2 AES-256-GCM with SHA256-derived key, random 12-byte nonce and strict payload;
try all rotated secrets, expiration must be strictly later than now, default TTL 30 days. A1
models authenticated encryption, not its implementation. GET/HEAD only. Invalid/missing ticket,
workspace or object yields bare 404. Valid ticket reveals object existence, 413 above 25MiB,
otherwise extension-derived content type, length, cache expiry; GET reveals bytes. nosniff and
SVG attachment disposition apply. Tickets are transferable bearer credentials; public immutable
caches can serve until expiry. No confidentiality after possession or timing theorem is claimed.

cronRules: input or events exactly one; text input coerces with String, events nonempty. Trim
names/ids/expressions; nullable patch fields retain clear semantics; validate IANA timezone.
rate accepts positive integral minute(s)/hour(s)/day(s); cron translates six AWS fields to five,
year must *, no L/W/#, ? becomes *, numeric weekdays 1..7 become 0..6, names/ranges/steps remain.
at exact-width syntax currently normalises calendar overflow (G500), timezone uses two offset
passes across DST; intended model validates fields first. DST fold/gap bijection is not claimed.

handler.ts cron entry: missing/paused skips, invalid scheduledTime falls back to now; admitRun
refusal records failure then one-shot cleanup. start opens direct event then run record, scopes
keys and resolves channel reentry, admits reject-mode continuation, writes pending async row,
starts worker. Errors mark/fail run and rethrow; outer catch deletes one-shot. Terminal completed
or failed outcomes record settlement before cleanup, intermediate outcomes retain job. Removal
catches storage rejection and logs. Earlier markFailed/failRun/completeRun exceptions can prevent
cleanup (G501). D7 model retains (cron,fireTime) independently of conversation, which current
random publicEventId/idempotencyKey violates (G2). Fix needs durable atomic claim of a stable
account+cron+scheduled-fire key before creating the run, retained across completion and restart.

Forwarder supervisor: one managed socket per bot token across config planes; reconcile removes
absent tokens, updates live targets without reconnect; fatal replaces only if own targets change.
Read targets again after thread lookup. Socket callbacks compare actual WebSocket identity;
stale close/message events do nothing. stop clears timers and closes 1000; reconnect uses 4000,
30s connect deadline, heartbeat interval clamped 1s..300s; missing ACK abandons. Fatal codes
4004/4010..4014 stop; 4007/4009 forget session; invalid-session may forget, waits random 1..5s.
Resume URL must be wss single-label discord.gg, no port/path; revalidated before sending token.
IDENTIFY consumes sliding-window budget (default 500/day) before dial; exhaustion waits; state
is process-local and forgotten on restart. READY/RESUMED resets attempts. A single process is
required for global socket ownership; cross-process uniqueness is not proved.
-/
namespace Spec.Channels
end Spec.Channels
