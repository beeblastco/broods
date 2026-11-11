/-!
The properties a Broods runtime may have. Read this file and `Assumptions.lean` to learn what the
theorems claim. Nothing is proved here, and no Broods definition is imported: a property cannot be
bent to fit the model it will be proved of.
-/

namespace Spec

/-- A deterministic transition system. Time, crashes, attackers and scheduling are all inputs, so
quantifying over input lists covers every interleaving. -/
structure System where
  State : Type
  Input : Type
  Effect : Type
  init : State
  step : State → Input → State × List Effect

namespace System

/-- The state after a list of inputs from `s`, and every effect emitted on the way, in order. -/
def runFrom (sys : System) (s : sys.State) : List sys.Input → sys.State × List sys.Effect
  | [] => (s, [])
  | i :: rest =>
    let next := sys.step s i
    let later := sys.runFrom next.1 rest
    (later.1, next.2 ++ later.2)

/-- The state a list of inputs reaches from the initial state. -/
def final (sys : System) (trace : List sys.Input) : sys.State :=
  (sys.runFrom sys.init trace).1

/-- Every effect a list of inputs emits from the initial state. -/
def effects (sys : System) (trace : List sys.Input) : List sys.Effect :=
  (sys.runFrom sys.init trace).2

/-- A state some list of inputs reaches. -/
def Reachable (sys : System) (s : sys.State) : Prop :=
  ∃ trace, sys.final trace = s

end System

/-- A property kept by every step from the initial state. This is how every subsystem theorem is
proved: the proof obligation is one step at a time, for each kind of input. -/
def Inductive (sys : System) (inv : sys.State → Prop) : Prop :=
  inv sys.init ∧ ∀ s i, inv s → inv (sys.step s i).1

/-- A property of every reachable state. -/
def Always (sys : System) (p : sys.State → Prop) : Prop :=
  ∀ s, sys.Reachable s → p s

/-- Soundness. One extractor names, for each effect, what justified it, reading only the inputs up
to and including the step that emitted the effect, never later ones. So an attacker cannot make an
effect justified after the fact. `Legal` is the attacker's limit, and `Assumptions.lean` says what
it rules out. -/
def Sound (sys : System) (Legal : List sys.Input → Prop) (Witness : Type)
    (Justifies : Witness → sys.Effect → Prop) : Prop :=
  ∃ extractor : List sys.Input → sys.Effect → Option Witness,
    ∀ (trace : List sys.Input) (i : sys.Input), Legal (trace ++ [i]) →
      ∀ e ∈ (sys.step (sys.final trace) i).2,
        ∃ w, extractor (trace ++ [i]) e = some w ∧ Justifies w e

/-- Progress. From any state a legal trace reaches, if `pending` holds then every `fair`
continuation from that state ends in a state where `done` holds. A system that refuses everything
satisfies `Sound`, so soundness says nothing without a statement like this one. -/
def Progress (sys : System) (Legal : List sys.Input → Prop)
    (Fair : sys.State → List sys.Input → Prop) (pending done : sys.State → Prop) : Prop :=
  ∀ trace, Legal trace → pending (sys.final trace) →
    ∀ schedule, Fair (sys.final trace) schedule →
      done (sys.runFrom (sys.final trace) schedule).1

/-- Privacy with declared leakage. What a party observes is fixed by its own inputs and the
declared `leak`. Equivalently one simulator, given only those two, can produce the view. The
statement is only as strong as `leak`, so `leak` must be read: a leak that returned the whole trace
would make this trivially true. -/
def Private (sys : System) (Party Leak Observation : Type)
    (Legal : List sys.Input → Prop)
    (own : Party → List sys.Input → List sys.Input)
    (leak : List sys.Input → Leak)
    (view : Party → List sys.Effect → List Observation) : Prop :=
  ∀ (p : Party) (a b : List sys.Input), Legal a → Legal b →
    own p a = own p b → leak a = leak b →
      view p (sys.effects a) = view p (sys.effects b)

/-- The hypotheses of a theorem can be met together, and a run really does emit an effect of the
kind claimed. FlashProve's lesson: a verifier that rejects everything is sound, so each theorem
needs a witness that it is not vacuous. -/
def NonVacuous (sys : System) (Legal : List sys.Input → Prop) (kind : sys.Effect → Prop) : Prop :=
  ∃ trace, Legal trace ∧ ∃ e ∈ sys.effects trace, kind e

end Spec
