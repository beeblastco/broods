import Spec.Access.Model
import Spec.Access.Twins.Js
import Spec.Access.Twins.Crypto

/-!
Twins of the scoped-key rules in `apps/core/src/shared/runtime-keys.ts` and the user-token rules in
`packages/convex/model/userToken.ts`.
-/

namespace Spec.Access.Keys

open Lean Js Crypto

/-- `CHANNEL_CONVERSATION_PREFIXES`, in the order `unscopedChannelConversationKey` tries them. -/
def channelPrefixes : List String :=
  ["gchat:", "gh:", "linear:", "slack:", "teams:", "tg:", "twilio:", "discord:", "pancake:", "zalo:",
    "instagram:", "messenger:", "whatsapp:"]

/-- `hashScopedValue`: a 40-hex SHA-256 of the scope and value, split by a NUL. -/
def hashScoped (scope value : String) : String :=
  String.ofList ((hex (sha256 (utf8 scope ++ [0] ++ utf8 value))).toList.take 40)

/-- `normalizeFilesystemNamespace`. -/
def filesystemNamespace (conversationKey : String) : String :=
  "fs-" ++ hashScoped "filesystem-namespace" conversationKey

/-- `unscopedChannelConversationKey`: only each prefix's first occurrence is considered. -/
def unscopedChannelKey (key : String) : String :=
  let chars := key.toList
  let found := channelPrefixes.findSome? fun pre =>
    match indexOf key pre with
    | some start =>
      if start == 0 || chars[start - 1]? == some ':' then some (dropChars key start) else none
    | none => none
  found.getD key

/-- The first `count` pieces joined back, when there are at least `least`. -/
def keepParts (key separator : String) (least count : Nat) : String :=
  let parts := key.splitOn separator
  if parts.length ≥ least then separator.intercalate (parts.take count) else key

/-- `channelScopeKeyFromConversation` for a scope that is not "conversation". -/
def channelScope (unscoped : String) : String :=
  if startsWith unscoped "slack:" then keepParts unscoped ":" 4 3
  else if startsWith unscoped "discord:" then keepParts unscoped ":" 3 3
  else if startsWith unscoped "pancake:" then keepParts unscoped ":" 3 2
  else if startsWith unscoped "gchat:" then keepParts unscoped "/" 3 2
  else if startsWith unscoped "teams:" then
    match indexOf unscoped ";" with
    | some boundary => String.ofList (unscoped.toList.take boundary)
    | none => unscoped
  else if startsWith unscoped "linear:" then keepParts unscoped ":" 4 2
  else if startsWith unscoped "gh:" then keepParts unscoped ":" 2 2
  else unscoped

/-- `normalizeDirectIdentifier`. -/
def directIdentifier (name value : String) : Except String String :=
  let normalized := trim value
  if normalized == "" then .error (name ++ " must not be empty") else .ok normalized

/-- A trimmed public identifier, or the throw for an empty or reserved one. -/
def publicIdentifier (name : String) (reserved : List String) (message value : String) : Json :=
  match directIdentifier name value with
  | .error text => Spec.Twin.threw text
  | .ok normalized =>
    if reserved.any (startsWith normalized) then Spec.Twin.threw message else .str normalized

/-- `publicConversationKeyFromScoped`. -/
def publicConversationKey (key account : String) (agent : Option String) : String :=
  let pre := match agent with
    | some name => if name != "" then "acct:" ++ account ++ ":agent:" ++ name ++ ":"
      else "acct:" ++ account ++ ":"
    | none => "acct:" ++ account ++ ":"
  let unscoped := (afterPrefix key pre).getD key
  (afterPrefix unscoped "api:").getD unscoped

/-- `/^acct:([^:]+):agent:([^:]+):(.+)$/`, where `.` stops at a line terminator. -/
def parseAgentScoped (value : String) : Option (String × String × String) := do
  let afterAccount ← afterPrefix value "acct:"
  let account := afterAccount.toList.takeWhile (· != ':')
  let rest := String.ofList (afterAccount.toList.dropWhile (· != ':'))
  let afterAgent ← afterPrefix rest ":agent:"
  let agent := afterAgent.toList.takeWhile (· != ':')
  let key ← match afterAgent.toList.dropWhile (· != ':') with
    | ':' :: tail => some tail
    | _ => none
  if account.isEmpty || agent.isEmpty || key.isEmpty || key.any isLineTerminator then none
  else some (String.ofList account, String.ofList agent, String.ofList key)

/-- `UUID_EXACT`. -/
def isUuid (value : String) : Bool :=
  let lowerHex (char : Char) : Bool := Char.isDigit char || ('a' ≤ char && char ≤ 'f')
  match value.splitOn "-" with
  | [a, b, c, d, e] =>
    a.length == 8 && b.length == 4 && c.length == 4 && d.length == 4 && e.length == 12 &&
      [a, b, c, d, e].all (fun part => part.toList.all lowerHex) &&
      c.toList.head?.any (fun char => '1' ≤ char && char ≤ '8') &&
      d.toList.head?.any (fun char => "89ab".toList.contains char)
  | _ => false

/-- `SUBAGENT_TASK_ID`: the encoded parent and the nonce. -/
def parseSubagentTask (taskId : String) : Option (String × String) := do
  let rest ← afterPrefix taskId "subagent~"
  match rest.splitOn "~" with
  | [payload, nonce] =>
    let wordChar (char : Char) : Bool :=
      char.toNat < 128 && (char.isAlphanum || char == '_' || char == '-')
    if payload != "" && payload.toList.all wordChar && isUuid nonce then some (payload, nonce)
    else none
  | _ => none

/-- `subagentParentEventId`: only a canonical encoding of a scoped key counts. -/
def subagentParent (taskId : String) : Option String := do
  let (payload, _) ← parseSubagentTask taskId
  let bytes := base64Decode payload
  let decoded ← String.fromUTF8? (ByteArray.mk bytes.toArray)
  if base64UrlEncode bytes != payload then none
  else (parseAgentScoped decoded).map fun _ => decoded

/-- `USER_ID_PATTERN`. -/
def isUserId (value : String) : Bool :=
  let allowed (char : Char) : Bool :=
    char.toNat < 128 && (char.isAlphanum || "._@+=-".toList.contains char)
  value != "" && value.length ≤ 128 && value.toList.all allowed

/-- `CREDENTIAL_PATTERN`. -/
def isCredential (value : String) : Bool :=
  value != "" && value.length ≤ 512 &&
    value.toList.all fun char => 0x21 ≤ char.toNat && char.toNat ≤ 0x7E

/-- One entry of a token's `conversations`. -/
def isConversationKey : Json → Bool
  | .str key => trim key == key && key != "" && utf16Length key ≤ 256
  | _ => false

/-- `parseUserToken`. Limits: `USER_TOKEN_MAX_TTL_MS` plus `CLOCK_SKEW_MS`. -/
def parseUserToken (decoded : Json) (now : JsonNumber) : Json :=
  let userId := strProp decoded "userId"
  let expires := match prop decoded "expiresAt" with
    | some (.num number) => some number
    | _ => none
  let credential := prop decoded "credential"
  let credentialOk := match credential with
    | none => true
    | some (.str text) => isCredential text
    | some _ => false
  match userId, expires with
  | some user, some expiresAt =>
    if !isUserId user || numLe expiresAt now ||
        !numLe expiresAt (numAdd now (natNum (60 * 60 * 1000 + 60 * 1000))) || !credentialOk then
      nullResult
    else
      let checked := [("userId", Json.str user), ("expiresAt", Json.num expiresAt)] ++
        optField "credential" credential
      match prop decoded "conversations" with
      | none => Json.mkObj checked
      | some (.arr keys) =>
        if keys.size ≤ 100 && keys.all isConversationKey then
          Json.mkObj (checked ++ [("conversations", Json.arr keys)])
        else nullResult
      | some _ => nullResult
  | _, _ => nullResult

/-- `userConversationPrefix`. -/
def userPrefix (userId : String) : String :=
  "bsu:" ++ userId ++ ":"

/-- `userOwnsConversation` for a token's user and conversations. -/
def userOwns (token : Json) (key : String) : Bool :=
  let pre := userPrefix ((strProp token "userId").getD "")
  match afterPrefix key pre with
  | none => false
  | some bare =>
    bare != "" &&
      match prop token "conversations" with
      | some (.arr keys) => keys.contains (.str bare)
      | none => true
      | some _ => false

/-- `userConversationKey`. -/
def userKey (token : Json) (requested : String) : Json :=
  let pre := userPrefix ((strProp token "userId").getD "")
  let key := if startsWith requested pre then requested else pre ++ requested
  if userOwns token key then .str key else nullResult

/-- Twins of `apps/core/src/shared/runtime-keys.ts`. -/
def runtimeKeyTwins : List Spec.Twin :=
  let source (name : String) : String := "apps/core/src/shared/runtime-keys.ts#" ++ name
  [ stringTwin (source "normalizeFilesystemNamespace") fun key => .str (filesystemNamespace key),
    stringTwin (source "agentNamespaceFolder") fun agent =>
      .str ("agent/" ++ filesystemNamespace agent),
    stringTwin2 (source "hashScopedValue") fun scope value => .str (hashScoped scope value),
    stringTwin (source "unscopedChannelConversationKey") fun key => .str (unscopedChannelKey key),
    jsonTwin (source "channelScopeKeyFromConversation") fun args =>
      match Spec.Twin.arg args 0 with
      | .str key =>
        let unscoped := unscopedChannelKey key
        if Spec.Twin.arg args 1 == .str "conversation" then .str unscoped
        else .str (channelScope unscoped)
      | _ => Spec.Twin.unsupported "key is not a string",
    stringTwin2 (source "normalizeDirectIdentifier") fun name value =>
      match directIdentifier name value with
      | .ok normalized => .str normalized
      | .error text => Spec.Twin.threw text,
    stringTwin (source "assertValidPublicEventId") <|
      publicIdentifier "eventId" reservedEvents "eventId uses a reserved internal prefix",
    stringTwin (source "assertValidPublicConversationKey") <|
      publicIdentifier "conversationKey" reservedConversations
        "conversationKey uses a reserved channel or internal prefix",
    stringTwin (source "hasReservedConversationPrefix") fun value =>
      .bool (reservedConversations.any (startsWith value)),
    stringTwin (source "hasReservedEventIdPrefix") fun value =>
      .bool (reservedEvents.any (startsWith value)),
    jsonTwin (source "scopedDirectEventId") fun args =>
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1, Spec.Twin.arg args 2 with
      | .str account, .str agent, .str event =>
        .str (accountAgentScopedKey account agent ("api:" ++ event))
      | _, _, _ => Spec.Twin.unsupported "arguments are not strings",
    jsonTwin (source "scopedDirectConversationKey") fun args =>
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1, Spec.Twin.arg args 2 with
      | .str account, .str agent, .str key =>
        .str (accountAgentScopedKey account agent ("api:" ++ key))
      | _, _, _ => Spec.Twin.unsupported "arguments are not strings",
    jsonTwin (source "publicConversationKeyFromScoped") fun args =>
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1, Spec.Twin.arg args 2 with
      | .str key, .str account, .str agent => .str (publicConversationKey key account (some agent))
      | .str key, .str account, .null => .str (publicConversationKey key account none)
      | _, _, _ => Spec.Twin.unsupported "arguments are not strings",
    stringTwin2 (source "accountScopedKey") fun account key => .str (accountScopedKey account key),
    jsonTwin (source "publicEventIdForScope") fun args =>
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1, Spec.Twin.arg args 2,
          Spec.Twin.arg args 3 with
      | .null, _, _, fallback => fallback
      | .str "", _, _, fallback => fallback
      | .str value, .str account, .str agent, fallback =>
        match afterPrefix value ("acct:" ++ account ++ ":agent:" ++ agent ++ ":api:") with
        | some publicId => .str publicId
        | none => fallback
      | _, _, _, _ => Spec.Twin.unsupported "arguments are not strings",
    jsonTwin (source "accountAgentScopedKey") fun args =>
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1, Spec.Twin.arg args 2 with
      | .str account, .str agent, .str key => .str (accountAgentScopedKey account agent key)
      | _, _, _ => Spec.Twin.unsupported "arguments are not strings",
    stringTwin (source "isRunId") fun value =>
      .bool <| match afterPrefix value "run_" with
        | some rest =>
          rest.length == 32 && rest.toList.all fun char =>
            Char.isDigit char || ('a' ≤ char && char ≤ 'f')
        | none => false,
    jsonTwin (source "createSubagentTaskId") fun args =>
      match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
      | .str parent, nonce =>
        if (parseAgentScoped parent).isNone then
          Spec.Twin.threw "Subagent parent event must be account and agent scoped"
        else
          match nonce with
          | .str given =>
            if isUuid given then
              .str ("subagent~" ++ base64UrlEncode (utf8 parent) ++ "~" ++ given)
            else Spec.Twin.threw "Subagent task nonce must be a UUID"
          | _ => Spec.Twin.unsupported "the nonce defaults to a random UUID"
      | _, _ => Spec.Twin.unsupported "parent is not a string",
    stringTwin (source "parseAccountAgentScopedKey") fun value =>
      match parseAgentScoped value with
      | some (account, agent, key) =>
        Json.mkObj [("accountId", .str account), ("agentId", .str agent), ("key", .str key)]
      | none => nullResult,
    stringTwin (source "isUserConversationKey") fun key =>
      .bool <| match parseAgentScoped key with
        | some (_, _, inner) => startsWith inner "api:bsu:"
        | none => false,
    stringTwin (source "subagentTaskNonce") fun taskId =>
      optStr ((parseSubagentTask taskId).map Prod.snd),
    stringTwin (source "subagentParentEventId") fun taskId => optStr (subagentParent taskId) ]

/-- Twins of `packages/convex/model/userToken.ts` and `secretNames.ts`. -/
def userTokenTwins : List Spec.Twin :=
  let source (name : String) : String := "packages/convex/model/userToken.ts#" ++ name
  let secretName (name : String) : Json :=
    if isAscii name then .bool (isSecretName name)
    else Spec.Twin.unsupported "toLowerCase is modelled on ASCII names"
  [ jsonTwin (source "parseUserToken") fun args =>
      match Spec.Twin.arg args 1 with
      | .num now => parseUserToken (Spec.Twin.arg args 0) now
      | _ => Spec.Twin.unsupported "now is not a number",
    stringTwin (source "userConversationPrefix") fun userId => .str (userPrefix userId),
    jsonTwin (source "userConversationKey") fun args =>
      match Spec.Twin.arg args 1 with
      | .str requested => userKey (Spec.Twin.arg args 0) requested
      | _ => Spec.Twin.unsupported "requested key is not a string",
    jsonTwin (source "userOwnsConversation") fun args =>
      match Spec.Twin.arg args 1 with
      | .str key => .bool (userOwns (Spec.Twin.arg args 0) key)
      | _ => Spec.Twin.unsupported "key is not a string",
    stringTwin "packages/convex/model/secretNames.ts#judgeName" secretName ]

end Spec.Access.Keys
