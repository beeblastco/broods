---------------------------- MODULE DevWatch ----------------------------
(* `broods dev` watch loop (packages/broods/src/cli/index.ts, dev()).
   An editor saves files; each save is a watcher event that (re)arms a
   150 ms debounce timer. The timer calls runSync, which runs syncChanged
   unless one is running, in which case it sets `pending` for one rerun.
   syncChanged reads the source signature, skips when it equals the last
   synced one (unless the last sync failed), else runs a `dev --once`
   child that reads the source and writes the stage, and may fail midway.

   The watcher starts before the first sync, and a sync that saw a source
   save after taking its signature records none (`savedSinceSignature`).
   Without either, a save is lost: one made during the first sync, or one
   undone while a sync ran, which leaves the stage on the saved content.  *)
EXTENDS Naturals

CONSTANTS Contents, MaxEdits, NONE

VARIABLES src, stage, last, failed, syncing, pending, timer,
          pc, sig, read, edits, watching, dirty

vars == <<src, stage, last, failed, syncing, pending, timer,
          pc, sig, read, edits, watching, dirty>>

Init ==
  /\ src \in Contents
  /\ stage \in Contents \cup {NONE}
  /\ last = NONE
  /\ failed = FALSE
  /\ pending = FALSE
  /\ timer = FALSE
  /\ sig = NONE
  /\ read = NONE
  /\ edits = 0
  /\ dirty = FALSE
  \* watch() first, then runSync() for the first sync.
  /\ watching = TRUE
  /\ syncing = TRUE
  /\ pc = "sig"

\* A save, possibly of identical bytes (an editor touch).
Edit ==
  /\ edits < MaxEdits
  /\ edits' = edits + 1
  /\ src' \in Contents
  /\ IF watching
       THEN timer' = TRUE /\ dirty' = TRUE
       ELSE UNCHANGED <<timer, dirty>>
  /\ UNCHANGED <<stage, last, failed, syncing, pending, pc, sig, read, watching>>

\* runSync, from the debounce timer.
TimerFires ==
  /\ timer
  /\ timer' = FALSE
  /\ IF syncing
       THEN pending' = TRUE /\ UNCHANGED <<syncing, pc>>
       ELSE syncing' = TRUE /\ pc' = "sig" /\ UNCHANGED pending
  /\ UNCHANGED <<src, stage, last, failed, sig, read, edits, watching, dirty>>

\* const signature = await sourceSignature(); skip or mark failed.
Signature ==
  /\ pc = "sig"
  /\ sig' = src
  /\ dirty' = FALSE
  /\ IF src = last /\ ~failed
       THEN pc' = "done" /\ UNCHANGED failed
       ELSE pc' = "read" /\ failed' = TRUE
  /\ UNCHANGED <<src, stage, last, syncing, pending, timer, read, edits, watching>>

\* sourceSignature() rejects: a save was replacing a file it read. syncChanged
\* throws before marking failed and printSyncError logs it; that save's own
\* watcher event re-arms the timer, so the next runSync retries.
SignatureFails ==
  /\ pc = "sig"
  /\ edits < MaxEdits
  /\ edits' = edits + 1
  /\ src' \in Contents
  /\ timer' = TRUE
  /\ dirty' = TRUE
  /\ pc' = "done"
  /\ UNCHANGED <<stage, last, failed, syncing, pending, sig, read, watching>>

\* The child reads the project from disk, after the signature was taken.
ChildRead ==
  /\ pc = "read"
  /\ read' = src
  /\ pc' = "write"
  /\ UNCHANGED <<src, stage, last, failed, syncing, pending, timer, sig, edits, watching, dirty>>

ChildSucceeds ==
  /\ pc = "write"
  /\ stage' = read
  /\ failed' = FALSE
  /\ last' = IF dirty THEN NONE ELSE sig
  /\ pc' = "done"
  /\ UNCHANGED <<src, syncing, pending, timer, sig, read, edits, watching, dirty>>

\* A failed child may have written part of the stage.
ChildFails ==
  /\ pc = "write"
  /\ stage' \in {stage, read}
  /\ pc' = "done"
  /\ UNCHANGED <<src, last, failed, syncing, pending, timer, sig, read, edits, watching, dirty>>

\* The .finally of runSync.
Done ==
  /\ pc = "done"
  /\ watching' = TRUE
  /\ IF pending
       THEN pending' = FALSE /\ pc' = "sig" /\ UNCHANGED syncing
       ELSE pending' = FALSE /\ pc' = "idle" /\ syncing' = FALSE
  /\ UNCHANGED <<src, stage, last, failed, timer, sig, read, edits, dirty>>

Next == Edit \/ TimerFires \/ Signature \/ SignatureFails \/ ChildRead \/ ChildSucceeds
        \/ ChildFails \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ pc \in {"idle", "sig", "read", "write", "done"}
  /\ syncing = (pc # "idle")

\* Nothing left to do: no timer armed and no sync running. The stage must
\* then hold the source, unless the last sync failed (its error printed,
\* the next save retries).
Quiescent == ~timer /\ pc = "idle"
StageMatchesSource == Quiescent => (stage = src \/ failed)
=============================================================================
