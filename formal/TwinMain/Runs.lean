import Spec.TwinRun
import Spec.Runs.Twins

/-- This subsystem's twins alone, so another author's broken file cannot block a check. -/
def main (args : List String) : IO UInt32 :=
  Spec.twinMain Spec.Runs.twins args
