# Agent Note: Keep historical Session browsing non-activating

Status: implemented

English | [中文](2026-09-20-nonactivating-history-follow.zh.md)

## Problem

An ordinary cold Session follow opened its snapshot and then resumed an Agent in the background. The Agent lifecycle retained the complete Session after the browser closed the follow. Visiting more historical Sessions therefore accumulated live Agents and logs independently of the prepared-cache budget or opening-reader lifetime.

## Decision

`session.follow` and `session.page` only observe history. Their listeners precede the opening read, so a later explicit activation still delivers its new events without a subscription gap. The opening generator releases the complete observation before waiting for events. Prompt, queue, model, rename, file-reference operations, and Agent-scoped Remote lookups keep their existing explicit activation policies. Browser command-catalog warming uses the recorded preset’s standing scope without a live Agent. Goal activation reads look up only an existing Agent; a cold persisted active goal displays as disarmed.

The Web Host mounts the pure `tool-todo/projection` and `plan-mode/projection` plugins so cold snapshots retain Todo and plan controls before any Agent preset starts. The model-facing tool and plan runtime reuse those definitions; registering the Host folds adds no tool, command, or prompt.

This decision supersedes only the automatic follow promotion in [history transport](../architecture/2026-08-18-session-history-and-event-transport.md) and [Session observations](../architecture/2026-08-25-session-observations-and-projection-owned-client-state.md). Both records retain independent transport and projection rationale. [Bounded reader retention](2026-09-19-history-reader-retention.md) remains necessary for cold reads, long-lived followers, and browser node sources. No record is fully superseded.

Opening or reconnecting a cold historical Session does not restore its Agent plugins or reminder runtime. Its queued input remains durable until an explicit operation handles it. An operation that requires the Agent resumes it under the existing lifecycle rules. Existing live Agents and their background work remain owned by that lifecycle; browser navigation neither disposes them nor cancels their work.

## Alternatives considered

**Keep background promotion after the snapshot.** It makes Agent capabilities ready before the first command and keeps activation off the first-render path, but every viewed history becomes a resident Agent with no browsing-owned retirement point. A bounded read cache does not limit that owner.

**Dispose an idle Agent when its final follower closes.** Idle status does not mean the Agent owns no reminders, pending input, or background work. A browser follower does not own those lifetimes, and closing it must not terminate them.

**Promote only histories whose projections suggest pending work.** A domain-specific test in the history transport would couple it to optional plugins and still miss other activation effects. The operation requiring an Agent owns activation.

## Consequences

Browsing several cold histories retains reusable reads only within the configured cache bounds and active reader lifetimes. The first subsequent command pays Agent restoration cost. Explicitly activated Agents still retain their own Sessions; this change does not introduce a general idle-Agent eviction policy or a process-RSS limit.

The real AgentLoop and JSONL regression opens and closes three histories and checks the live registries, then resumes through an explicit prompt and checks durable output and follow continuity. Its automatic-promotion negative control accumulates one, two, then three live root Agents. The assembled cold-history browser scenario verifies Todo and plan controls across three cold Sessions and activates only the selected Session when its plan control is clicked. The assembled seeded-history browser scenario checks cold registry state before explicit activation and renders the subsequent live event through the existing follow.
