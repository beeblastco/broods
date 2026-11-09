import Spec.Twin
import Spec.Channels.Twins.Closures
import Spec.Channels.Twins.Commands
import Spec.Channels.Twins.Forwarder
import Spec.Channels.Twins.Integrations
import Spec.Channels.Twins.Record
import Spec.Channels.Twins.Wavechannels1
import Spec.Channels.Twins.Wavechannels2
import Spec.Channels.Twins.Wavechannels3a
import Spec.Channels.Twins.Wavechannels4a
import Spec.Channels.Twins.Wavechannels4b
import Spec.Channels.Twins.Wavechannels5a
import Spec.Channels.Twins.Wavechannels5b
import Spec.Channels.Twins.Wavechannels6a
import Spec.Channels.Twins.Wavechannels8a
import Spec.Channels.Twins.Wave10
import Spec.Channels.Twins.Wave11

/-!
Twins of the channels subsystem's functions. See `AUTHORING.md`.
-/

namespace Spec.Channels

/-- This subsystem's twins. -/
def twins : List Spec.Twin :=
  Closures.twins ++ commandTwins ++ forwarderTwins ++ integrationTwins ++ recordTwins ++ Wavechannels1.twins ++ Wavechannels2.twins ++ Wavechannels3a.twins ++ Wavechannels4a.twins ++ Wavechannels4b.twins ++ Wavechannels5a.twins ++ Wavechannels5b.twins ++ Wavechannels6a.twins ++ Wavechannels8a.twins ++ Wave10.twins ++ Wave11.twins

end Spec.Channels
