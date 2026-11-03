---------------------------- MODULE EscFilter ----------------------------
(* stopTurnOnEscape in packages/broods/src/cli/tui.ts. A lone ESC is held 30 ms: "[" joins it
   into a key, else it stops a streaming turn or reaches the TUI. ESC plus more in one read
   (Alt+key) is a key and passes. `out` is what the TUI saw, "STOP" a stopTurn() call. *)
EXTENDS Naturals, Sequences

CONSTANTS MaxKeys

VARIABLES wire, held, heldMidTurn, streaming, out, expected, keys

vars == <<wire, held, heldMidTurn, streaming, out, expected, keys>>

Init ==
  /\ wire = <<>>
  /\ held = FALSE
  /\ heldMidTurn = FALSE
  /\ streaming \in BOOLEAN
  /\ out = <<>>
  /\ expected = <<>>
  /\ keys = 0

Press(chunks) ==
  /\ keys < MaxKeys
  /\ keys' = keys + 1
  /\ wire' = wire \o chunks
  /\ UNCHANGED <<held, heldMidTurn, streaming, out, expected>>

PressEsc   == Press(<<"ESC_k">>)
PressArrow == Press(<<"ESC[A">>)
PressSplitArrow == Press(<<"ESC_a", "[A">>)
PressKey   == Press(<<"x">>)
PressCtrlC == Press(<<"CTRLC">>)

IsEsc(c) == c \in {"ESC_k", "ESC_a"}

\* What reading chunk c means for its key, once the keys before it took
\* effect (a held Esc that stops the turn makes a second Esc an idle one).
Meaning(c) ==
  CASE c = "ESC_k" -> <<IF streaming /\ ~(held /\ heldMidTurn) THEN "STOP" ELSE "ESC">>
    [] c = "ESC_a" -> <<"ARROW">>
    [] c = "ESC[A" -> <<"ARROW">>
    [] c = "[A"    -> <<>>
    [] OTHER       -> <<c>>

\* settle(): what a held ESC turns into.
SettleOut == IF heldMidTurn THEN <<"STOP">> ELSE <<"ESC">>

\* input.emit("data", chunk) for the chunk at the head of the wire.
Receive ==
  /\ wire # <<>>
  /\ LET c == Head(wire) IN
       IF held /\ c = "[A"
         THEN /\ out' = Append(out, "ARROW")
              /\ held' = FALSE
              /\ UNCHANGED <<heldMidTurn, streaming>>
         ELSE LET settled == IF held THEN SettleOut ELSE <<>>
                  midStop  == held /\ heldMidTurn
                  stillStreaming == streaming /\ ~midStop
              IN /\ IF IsEsc(c)
                      THEN /\ out' = out \o settled
                           /\ held' = TRUE
                           /\ heldMidTurn' = stillStreaming
                      ELSE /\ out' = out \o settled \o
                                     <<IF c = "ESC[A" THEN "ARROW" ELSE c>>
                           /\ held' = FALSE
                           /\ UNCHANGED heldMidTurn
                 /\ streaming' = stillStreaming
  /\ wire' = Tail(wire)
  /\ expected' = expected \o Meaning(Head(wire))
  /\ UNCHANGED keys

\* The hold timer. A split arrow's halves arrive within the wait (30 ms), so
\* it never fires between them; past that, the arrow reaches the TUI as Esc.
TimerFires ==
  /\ held
  /\ IF wire = <<>> THEN TRUE ELSE Head(wire) # "[A"
  /\ out' = out \o SettleOut
  /\ streaming' = (streaming /\ ~heldMidTurn)
  /\ held' = FALSE
  /\ UNCHANGED <<wire, heldMidTurn, expected, keys>>

TurnStarts ==
  /\ ~streaming
  /\ streaming' = TRUE
  /\ UNCHANGED <<wire, held, heldMidTurn, out, expected, keys>>

TurnEnds ==
  /\ streaming
  /\ streaming' = FALSE
  /\ UNCHANGED <<wire, held, heldMidTurn, out, expected, keys>>

Next == PressEsc \/ PressArrow \/ PressSplitArrow \/ PressKey \/ PressCtrlC
        \/ Receive \/ TimerFires \/ TurnStarts \/ TurnEnds

Spec == Init /\ [][Next]_vars /\ WF_vars(Receive) /\ WF_vars(TimerFires)

IsPrefix(s, t) == Len(s) <= Len(t) /\ SubSeq(t, 1, Len(s)) = s

\* The TUI only ever sees what the keys meant: an Esc pressed mid-turn
\* stops the turn and never quits, an arrow stays one key, order is kept.
OutMatchesKeys == IsPrefix(out, expected)

\* Every held Esc settles, and every chunk is handled in the end.
HeldSettles == [](held => <>~held)
Drains == (keys = MaxKeys) ~> (wire = <<>> /\ ~held /\ out = expected)
=============================================================================
