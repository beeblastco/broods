import Spec.Agent.Model

/-! Caller-facing adapter boundaries; these are data contracts, not proofs of external harnesses. -/
namespace Spec.Agent

structure HarnessRequest where
  account : Nat
  session : String
  instructions : List String
  messages : List String
  environment : List (String × String)
  abortRequested : Bool
  resume : Option String

inductive HarnessEvent where
  | text (value : String)
  | tool (name input : String)
  | checkpoint (entry : String)
  | usage (tokens : Usage)
  | failed (reason : String)
  | completed

/-- ai-sdk-harness adapters/runtime/session APIs are external effects supplied by the environment. -/
structure HarnessAdapter where
  create : HarnessRequest → Nat
  stream : Nat → List HarnessEvent
  stop : Nat → Unit
  destroy : Nat → Unit

/-- Transcription and ChatGPT HTTP authentication exchange are supplied, never called by replay. -/
structure ProviderAdapter where
  transcribe : String → Option String
  authenticate : String → Option String
  executeSandbox : Nat → String → Option String

/-- policyDocument.ts validators: heterogeneous scalar values and homogeneous primitive arrays. -/
inductive PolicyValue where
  | text (value : String)
  | number (numerator : Int) (denominator : Nat)
  | boolean (value : Bool)
  | texts (values : List String)
  | numbers (values : List (Int × Nat))
  | booleans (values : List Bool)

inductive ConditionOperator where
  | equals | notEquals | member | notMember | startsWith | contains

structure PolicyCondition where
  attributeName : String
  operator : ConditionOperator
  value : PolicyValue

structure ResourceSelector where
  toolNames : Option (List String)
  mcpIds : Option (List String)
  workspaceIds : Option (List String)
  workspaceNames : Option (List String)
  filePaths : Option (List String)
  subagentIds : Option (List String)
  skillPaths : Option (List String)
  resourceIds : Option (List String)

structure PolicyRule where
  id : String
  deny : Bool
  actions : List String
  resources : Option ResourceSelector
  conditions : Option (List PolicyCondition)

/-- Version is always 1; absence of mode defaults to audit in the Rego package. -/
structure PolicyDocument where
  enforce : Option Bool
  rules : List PolicyRule

/-- Indexed Convex queries rely on A2/A3, not on a model of the database engine. -/
structure EntryStore where
  find : String → String → String → Option String

end Spec.Agent
