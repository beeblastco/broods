/-!
# Provider tools that run as Broods tools

Model of `registerProviderTools` and `withholdTools` (`apps/core/src/harness/tools/index.ts`).
A provider tool the caller runs gets a stand-in (`tools/sandbox-stand-in.ts`): it runs as Broods
tools (`runsAs`) and takes the place of some (`replaces`). Names are abstract; a tool's own name
counts for `denyTools` like any name it runs as. A withheld stand-in gives back the Broods tools
it replaced that `denyTools` still allows.
-/

namespace Broods.ProviderTools

abbrev Name := Nat

/-- One entry of the finished ToolSet: its key, the Broods tools it runs as and those it replaced.
A Broods tool has neither. -/
structure Tool where
  name : Name
  runsAs : List Name
  replaces : List Name
  deriving DecidableEq, Repr

/-- `SandboxStandIn`'s `replaces` and `runsAs`. -/
structure StandIn where
  replaces : List Name
  runsAs : List Name
  deriving DecidableEq, Repr

/-- `registerProviderTools` for one key: `none` is the throw. A key that is a Broods tool name
(`isHarnessToolName`) or already in the ToolSet is taken, and only a stand-in that replaces it may
use it. A stand-in drops the tools it replaces. -/
def register (harness : List Name) (tools : List Tool) (key : Name) :
    Option StandIn → Option (List Tool)
  | none =>
    if harness.contains key || tools.any (·.name == key) then none
    else some (⟨key, [], []⟩ :: tools)
  | some s =>
    if (harness.contains key || tools.any (·.name == key)) && !s.replaces.contains key then none
    else some (⟨key, s.runsAs, s.replaces⟩ :: tools.filter (fun t => !s.replaces.contains t.name))

/-- A tool `denyTools` names, or one that runs as a name it lists. -/
def denied (deny : List Name) (t : Tool) : Bool :=
  deny.contains t.name || t.runsAs.any deny.contains

/-- `withholdTools`: drop each denied tool, and put back the Broods tools a dropped stand-in
replaced, unless they are denied too. -/
def withhold (deny : List Name) (tools : List Tool) : List Tool :=
  tools.filter (!denied deny ·) ++
    (tools.filter (denied deny ·)).flatMap
      (fun t => (t.replaces.filter (!deny.contains ·)).map (fun r => ⟨r, [], []⟩))

/-! ## Properties -/

/-- No tool left after `withhold` is, or runs as, a denied name: `denyTools: ["bash"]` leaves no
OpenAI `shell` or Anthropic bash behind. -/
theorem withhold_denied {deny : List Name} {tools : List Tool} {t : Tool} {d : Name}
    (ht : t ∈ withhold deny tools) (hd : d ∈ deny) : t.name ≠ d ∧ d ∉ t.runsAs := by
  simp only [withhold, List.mem_append, List.mem_filter, List.mem_flatMap, List.mem_map] at ht
  rcases ht with ⟨_, hk⟩ | ⟨u, _, r, ⟨_, hr⟩, rfl⟩
  · simp [denied] at hk
    refine ⟨?_, ?_⟩ <;> intro h <;> simp_all
  · simp at hr
    refine ⟨fun h => hr ?_, by simp⟩
    simp only at h
    exact h ▸ hd

/-- A stand-in `denyTools` drops gives back each Broods tool it replaced that is not denied, so
`denyTools: ["write"]` on the text editor still leaves `read` and `edit`. -/
theorem withhold_gives_back {deny : List Name} {tools : List Tool} {t : Tool} {r : Name}
    (ht : t ∈ tools) (hden : denied deny t = true) (hr : r ∈ t.replaces) (hok : r ∉ deny) :
    ⟨r, [], []⟩ ∈ withhold deny tools := by
  simp only [withhold, List.mem_append, List.mem_flatMap, List.mem_map, List.mem_filter]
  exact Or.inr ⟨t, ⟨ht, hden⟩, r, ⟨hr, by simpa using hok⟩, rfl⟩

/-- A Broods tool name keys a provider tool only when its stand-in replaces that name. -/
theorem register_harness {harness : List Name} {tools : List Tool} {key : Name}
    {s : Option StandIn} {out : List Tool} (hk : key ∈ harness)
    (h : register harness tools key s = some out) : ∃ st, s = some st ∧ key ∈ st.replaces := by
  cases s with
  | none => simp [register, hk] at h
  | some st =>
    simp [register] at h
    exact ⟨st, rfl, h.1 (Or.inl hk)⟩

/-- After a stand-in registers, a tool it replaces is gone unless it is the stand-in itself. -/
theorem register_replaced_gone {harness : List Name} {tools : List Tool} {key : Name}
    {st : StandIn} {out : List Tool} {t : Tool}
    (h : register harness tools key (some st) = some out) (ht : t ∈ out)
    (hr : t.name ∈ st.replaces) : t.name = key := by
  simp [register] at h
  obtain ⟨_, rfl⟩ := h
  simp at ht
  rcases ht with rfl | ⟨_, hnot⟩
  · rfl
  · exact absurd hr hnot

/-- Registering keeps one tool per key, so the model never sees two tools under one name. -/
theorem register_nodup {harness : List Name} {tools : List Tool} {key : Name}
    {s : Option StandIn} {out : List Tool} (hn : (tools.map (·.name)).Nodup)
    (h : register harness tools key s = some out) : (out.map (·.name)).Nodup := by
  cases s with
  | none =>
    simp [register] at h
    obtain ⟨⟨_, hfree⟩, rfl⟩ := h
    refine List.nodup_cons.mpr ⟨?_, hn⟩
    simp only [List.mem_map, not_exists, not_and]
    exact fun t ht he => hfree t ht he
  | some st =>
    simp [register] at h
    obtain ⟨hok, rfl⟩ := h
    refine List.nodup_cons.mpr ⟨?_, hn.sublist ((List.filter_sublist).map _)⟩
    simp only [List.mem_map, List.mem_filter, not_exists, not_and]
    intro t ⟨ht, hnot⟩ he
    subst he
    simp at hnot
    exact hnot (hok (Or.inr ⟨t, ht, rfl⟩))

/-! ## Examples -/

section
-- 0 is `bash`, 1 is `shell`, 2 `read`, 3 `write`, 4 `edit`, 5 a provider key such as `search`,
-- 7 the Anthropic text editor.

/-- OpenAI `shell` replaces bash and runs as it. -/
def shellStandIn : StandIn := ⟨[0], [0]⟩

/-- The hypotheses hold: `shell` replaces Broods bash and is the one tool left running bash. -/
example : register [0, 2] [⟨0, [], []⟩, ⟨2, [], []⟩] 1 (some shellStandIn)
    = some [⟨1, [0], [0]⟩, ⟨2, [], []⟩] := by decide

/-- Anthropic bash under the key `bash` takes bash's place. -/
example : register [0] [⟨0, [], []⟩] 0 (some shellStandIn) = some [⟨0, [0], [0]⟩] := by decide

/-- `bash: { enabled: true }` and a hosted tool keyed `bash` are refused. -/
example : register [0] [] 0 none = none := by decide

/-- A key already in the ToolSet, such as a machine's `computer`, is refused. -/
example : register [] [⟨5, [], []⟩] 5 none = none := by decide

/-- `denyTools: ["bash"]` withholds `shell` too, and gives no bash back. -/
example : withhold [0] [⟨1, [0], [0]⟩, ⟨2, [], []⟩] = [⟨2, [], []⟩] := by decide

/-- `denyTools: ["write"]` on the text editor gives back `read` and `edit`. -/
example : withhold [3] [⟨7, [2, 3, 4], [2, 3, 4]⟩] = [⟨2, [], []⟩, ⟨4, [], []⟩] := by decide

/-- The broken variant judges a tool by its own name only, and lets `shell` run bash. -/
def withholdByName (deny : List Name) (tools : List Tool) : List Tool :=
  tools.filter (fun t => !deny.contains t.name)

example : withholdByName [0] [⟨1, [0], [0]⟩] = [⟨1, [0], [0]⟩] := by decide

/-- The broken variant that gives nothing back leaves the text editor's agent with no file tool. -/
def withholdOnly (deny : List Name) (tools : List Tool) : List Tool :=
  tools.filter (!denied deny ·)

example : withholdOnly [3] [⟨7, [2, 3, 4], [2, 3, 4]⟩] = [] := by decide

end

end Broods.ProviderTools
