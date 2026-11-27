import Spec.Twins
import Spec.TwinRun
import Spec.Workers.Replay
import Spec.Access.Replay
import Spec.Runs.Replay
import Spec.Agent.Replay
import Spec.Sandbox.Replay
import Spec.Channels.Replay
import Spec.Hosted.Replay
import Spec.Config.Replay

/-- Prints replay vectors for one subsystem: `spec-replay <subsystem> <args...>`. -/
def main (args : List String) : IO UInt32 := do
  match args with
  | ["twins"] => Spec.twinMain Spec.allTwins args
  | ["twin-run"] => Spec.twinMain Spec.allTwins args
  | ["workers", count, length, seed] =>
    Spec.Workers.Replay.run count.toNat! length.toNat! seed.toNat!
    return 0
  | "access" :: rest =>
    Spec.Access.Replay.run rest
    return 0
  | "runs" :: rest =>
    Spec.Runs.Replay.run rest
    return 0
  | "agent" :: rest =>
    Spec.Agent.Replay.run rest
    return 0
  | "sandbox" :: rest =>
    Spec.Sandbox.Replay.run rest
    return 0
  | "channels" :: rest =>
    Spec.Channels.Replay.run rest
    return 0
  | "hosted" :: rest =>
    Spec.Hosted.Replay.run rest
    return 0
  | "config" :: rest =>
    Spec.Config.Replay.run rest
    return 0
  | _ =>
    IO.eprintln "usage: spec-replay <subsystem> <args...>"
    return 2
