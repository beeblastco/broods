import Spec.Channels.Twins.Support

/-!
Twins of `apps/core/src/shared/commands.ts`. The command table is the code's own `commands` array, minus
the `execute` bodies, which need the runtime.
-/

namespace Spec.Channels

open Lean

private def commandsSource : String := "apps/core/src/shared/commands.ts"

/-- One entry of `commands`. -/
structure CommandEntry where
  aliases : List String
  queued : Bool := false
  rewriteMode : Option String := none
  discordNames : List String

/-- The `commands` array, in order. -/
def commandTable : List CommandEntry :=
  [ { aliases := ["/new", "/clear"]
      discordNames := ["new", "clear"] },
    { aliases := ["/compact"]
      queued := true
      discordNames := ["compact"] },
    { aliases := ["/steer"]
      rewriteMode := some "steer"
      discordNames := ["steer"] },
    { aliases := ["/stop", "/cancel"]
      discordNames := ["stop"] },
    { aliases := ["/queue"]
      rewriteMode := some "followup"
      discordNames := ["queue"] },
    { aliases := ["/help"]
      discordNames := ["help"] } ]

/-- `INLINE_COMMAND_CHANNELS` in `apps/core/src/shared/channels.ts:33`. -/
def inlineCommandChannels : List String :=
  ["discord", "gchat", "instagram", "messenger", "slack", "teams", "telegram", "twilio", "whatsapp",
    "zalo"]

/-- `extractText`: the string, or the text parts joined. `none` when `content` is neither. -/
def extractText? (content : Json) : Option String :=
  match content with
  | .str s => some s
  | .arr parts =>
    some (String.join (parts.toList.filterMap fun part =>
      if field part "type" == .str "text" then
        match field part "text" with
        | .str text => some text
        | _ => none
      else none))
  | _ => none

/-- `parseCommand`. Lowercasing is ASCII here because every alias is ASCII, and no non-ASCII
character lowercases into a letter any alias uses. -/
def parseCommand (text : String) : Option String :=
  let trimmed := (jsTrim text).toLower
  let token := String.ofList (trimmed.toList.takeWhile (fun c => !jsSpace c))
  if !token.startsWith "/" then none
  else if commandTable.any (·.aliases.contains token) then some token
  else none

/-- `stripCommandToken` for a token with no regular expression metacharacter. -/
def stripCommandToken (content token : String) : String :=
  let trimmed := (jsTrim content).toList
  let (head, tail) := trimmed.splitAt token.length
  if (String.ofList head).toLower != token.toLower then String.ofList trimmed
  else
    match tail with
    | [] => ""
    | c :: _ =>
      if jsSpace c then String.ofList (tail.dropWhile jsSpace)
      else String.ofList trimmed

private def plainToken (token : String) : Bool :=
  token.toList.all fun c => !"\\^$.|?*+()[]{}".toList.contains c

private def stripTwin : Spec.Twin where
  source := commandsSource ++ "#stripCommandToken"
  run := fun args =>
    match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
    | .str content, .str token =>
      if plainToken token then toJson (stripCommandToken content token)
      else Spec.Twin.unsupported "token holds a regular expression metacharacter"
    | _, _ => Spec.Twin.unsupported "content or token is not a string"

private def parseCommandTwin : Spec.Twin where
  source := commandsSource ++ "#parseCommand"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .str text => match parseCommand text with
      | some token => toJson token
      | none => .null
    | _ => Spec.Twin.unsupported "text is not a string"

private def resolveDiscordTwin : Spec.Twin where
  source := commandsSource ++ "#resolveDiscordCommand"
  run := fun args =>
    match Spec.Twin.arg args 0, Spec.Twin.arg args 1 with
    | .str name, .str optionText =>
      match commandTable.find? (·.discordNames.contains name) with
      | none => .null
      | some entry =>
        Json.mkObj
          ([("contentText", toJson (jsTrim optionText))] ++
            optEntry "commandToken" (entry.aliases.head?.map Json.str))
    | _, _ => Spec.Twin.unsupported "name or option text is not a string"

private def resolveChannelTwin : Spec.Twin where
  source := commandsSource ++ "#resolveChannelCommand"
  run := fun args =>
    let input := Spec.Twin.arg args 0
    let content := field input "content"
    let reply := fun (token : String) =>
      Json.mkObj [("kind", toJson "reply"), ("commandToken", toJson token)]
    match field input "commandToken" with
    | .null => Json.mkObj [("kind", toJson "passthrough")]
    | .str "" => Json.mkObj [("kind", toJson "passthrough")]
    | .str token =>
      let handler := commandTable.find? (·.aliases.contains token)
      let needsText := (handler.map (·.queued)).getD false || (handler.bind (·.rewriteMode)).isSome
      if !needsText then reply token
      else
        match extractText? content with
        | none => Spec.Twin.unsupported "content is neither text nor parts"
        | some extracted =>
          if !plainToken token then Spec.Twin.unsupported "token holds a metacharacter"
          else
            let text := stripCommandToken extracted token
            if (handler.map (·.queued)).getD false then
              Json.mkObj
                [("kind", toJson "rewrite"), ("text", toJson (jsTrim s!"{token} {text}")),
                  ("requestedMode", toJson "followup")]
            else if text.isEmpty then reply token
            else
              Json.mkObj
                [("kind", toJson "rewrite"), ("text", toJson text),
                  ("requestedMode", toJson ((handler.bind (·.rewriteMode)).getD ""))]
    | _ => Spec.Twin.unsupported "command token is not a string"

/-- `queuedCommand`: one non-system text-only user event whose first token is a queued command. -/
def queuedCommand (events : List Json) (channelName : Option String) : Option Json :=
  if channelName.isSome && !inlineCommandChannels.contains (channelName.getD "") then none
  else
    match events.filter (fun event => field event "role" != .str "system") with
    | [event] =>
      if field event "role" != .str "user" then none
      else
        let content := field event "content"
        let onlyText := match content with
          | .str _ => true
          | .arr parts => parts.toList.all fun part => field part "type" == .str "text"
          | _ => false
        if !onlyText then none
        else
          let text := jsTrim ((extractText? content).getD "")
          match parseCommand text with
          | some token =>
            if commandTable.any (fun entry => entry.queued && entry.aliases.contains token) then
              some (Json.mkObj [("commandToken", toJson token), ("text", toJson text)])
            else none
          | none => none
    | _ => none

private def queuedCommandTwin : Spec.Twin where
  source := commandsSource ++ "#queuedCommand"
  run := fun args =>
    match Spec.Twin.arg args 0 with
    | .arr events =>
      (queuedCommand events.toList (str? (Spec.Twin.arg args 1))).getD .null
    | _ => Spec.Twin.unsupported "events is not an array"

/-- The twins in this file. -/
def commandTwins : List Spec.Twin :=
  [stripTwin, parseCommandTwin, resolveDiscordTwin, resolveChannelTwin,
    queuedCommandTwin]

end Spec.Channels
