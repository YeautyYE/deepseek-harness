# Agent Note: Bound history retention by reader lifetime

Status: implemented

English | [中文](2026-09-19-history-reader-retention.zh.md)

## Problem

Browsing historical Sessions creates three independent owners of decoded data: a reusable Host observation cache, the opening read of a live follow stream, and browser sources for individual chat nodes. A small displayed page does not bound the objects these owners retain. Entry counts admit arbitrarily large logs; a suspended generator can retain completed opening locals; a strong per-key source map retains nodes after their window is replaced.

## Decision

The [observation reader](../../../../packages/session-query/session-query/src/observation.ts) applies both the existing five-entry limit and a configurable 32 MiB decoded-log weight budget. It estimates UTF-16 strings, objects, and reference slots without serializing the log, deduplicates shared objects, and stops once an entry exceeds the budget. The default retains small histories for reuse while preventing five large histories from remaining resident. Active leases count toward both bounds but are protected from eviction until disposal. A zero byte budget disables retention after the final lease. Revision replacement and live-source preference remove the old cache weight without invalidating outstanding leases; a failed initial projection publishes no cache entry.

The [history controller](../../../../packages/api/session-controller/src/history.ts) delegates opening to a short-lived generator. That generator owns the observation, complete event array, page construction, snapshot yield, and promotion handoff. The live follower retains only its cursor and assistant-stream cut after the opening generator completes. Promotion owns its independent lease. Listener installation and buffering still precede observation, preserving snapshot-first, gap-free delivery.

The [chat source registry](../../../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts) holds keyed sources through `WeakRef`. A consumer-held source preserves its identity across window replacement and reappearance. Active subscriptions additionally hold sources strongly until the final unsubscribe, including when callers retain neither the source nor the unsubscribe function. Finalization removes only the matching weak entry, so collection of an old source never removes its replacement.

The [observation architecture](../architecture/2026-08-25-session-observations-and-projection-owned-client-state.md) and [history transport decision](../architecture/2026-08-18-session-history-and-event-transport.md) remain active: this decision adds retention ownership without replacing their source, projection, stream, or promotion semantics. [Read-only migration preparation](../architecture/2026-09-05-read-only-session-migration-preparation.md) still owns persistence-level sharing and publication. No active decision is fully superseded.

## Local evidence

Compiled production paths run under plain Node with fixed synthetic inputs and explicit garbage collection. Each diagnostic retains its intended reader or follower endpoint. These measurements cover reachable heap after navigation or opening; they establish neither peak memory, browser rendering cost, nor the final memory of a remote Windows process.

| Diagnostic and reachable endpoint | Original | Fixed |
|---|---:|---:|
| Observation reader after 10 Sessions × 512 messages × 16 KiB text | 41.14 MiB | 8.46 MiB |
| Six waiting followers, each opened from 3,000 events × 6,144 text characters | 111.657 MiB; six full arrays | 0.1517 MiB; zero full arrays |
| Chat store after 20 replaced windows × 2,000 nodes, two sources each | 46,127,088 bytes | 244,912 bytes |

The observation measurement uses macOS arm64 / Node 24.5.0; three-sample retained-heap medians decide the comparison. Removing the byte limit restores 41.17 MiB. The original chat cache exceeds the diagnostic's 4 MiB check; the replacement preserves source identity and all 40 notifications for held and subscription-only readers. Package-local [cache](../../../../packages/session-query/session-query/tests/prepared-cache.perf.ts) and [follow](../../../../packages/api/session-controller/tests/history-retention.perf.ts) diagnostics preserve synthetic reproduction; no private Session material enters fixtures. Functional tests cover byte eviction, lease release, replacement, projection failure, opening cancellation, handoff, source reuse, and notification ownership.

## Alternatives considered

**Reduce the cache to one entry.** A single decoded history may still be arbitrarily large. Count and byte bounds retain useful small histories while limiting released data by volume.

**Dispose the opening observation in a block inside the live generator.** Disposal releases the cache pin but the suspended generator frame still retains its opening array in the measured workload. A completed opening generator removes that owner.

**Delete every browser source when its node leaves the current window.** Consumers may still hold or subscribe to that source. Replacing it breaks identity and notifications when the node returns. Weak lookup plus subscription ownership preserves those obligations.

## Consequences

Revisiting an evicted history reloads and validates it. The byte estimate bounds cache reuse rather than process RSS; active reads, live Sessions, and projection state retain their own memory. Weak-source collection follows the JavaScript collector, while subscriptions require explicit cleanup. Durable history, migration publication, pagination, and message content remain complete. These diagnostics add no uncalibrated CI timing budget.
