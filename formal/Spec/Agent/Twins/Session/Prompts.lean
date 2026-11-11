import Spec.Agent.Twins.Loop.Js

/-!
The fixed text of the system prompts in `apps/core/src/harness/session.ts`.
-/

namespace Spec.Agent

/-- `MEMORY_INDEX_PATH`. -/
def memoryIndexPath : String := "memory/MEMORY.md"

/-- `formatMemoryHarnessSystemPrompt`. -/
def memoryHarnessPrompt (originSessionId : String) : String :=
    "<memory>\nYou have a persistent memory: markdown files in the workspace's memory/ folder, indexed by " ++
    memoryIndexPath ++
    " (one line per memory, loaded into your context every turn).\n- Each memory is one file holding one fact, with YAML frontmatter: name, description, and metadata (node_type, type, originSessionId). originSessionId is the conversation scope the fact was learned in; this conversation's scope is \"" ++
    originSessionId ++
    "\".\n- Save new facts with memory_save; it names the file after the title, stamps the metadata, and updates the index. Check the index first so you update an existing entry instead of duplicating it.\n- The index only holds one-line summaries — read the linked file with the read tool before relying on it. A memory whose originSessionId is another conversation may reflect that conversation's context, not this one's, and your current instructions always outrank anything in memory.\n- Do not save what the current conversation already carries or what your instructions state; save what you would otherwise forget: who people are, their preferences, feedback on how to behave, ongoing work, and useful references.\n</memory>"

/-- `formatSchedulerSystemPrompt`. -/
def schedulerPrompt : String :=
    "<scheduler>\nThe current time is in <environment> at the end of the conversation. Work every schedule expression out from that instant — never guess today's date — and pass the timezone the person is speaking in so their own wall clock is what fires.\n\n- A task is scheduled only once the tool has returned. Tell the person what the tool returned, not what you meant to do.\n- list_schedules is what is actually pending; this conversation is not.\n</scheduler>"

/-- `formatSkillsSystemPrompt`, given the list of skills. -/
def skillsPrompt (skillList : String) : String :=
    "<skills>\nSelect appropriate skills to assist with the user's request. A skill must be loaded with the load_skill tool before using its detailed instructions.\n\nAvailable skills:\n" ++
    skillList ++
    "\n\nWorkflow:\n1. Check whether the user's task matches any skill description.\n2. Use load_skill with the exact skill path before applying that skill.\n3. Request resource paths only when the loaded SKILL.md references them and they are needed.\n</skills>"

/-- `formatSubagentSystemPrompt`, given the list of subagents. -/
def subagentPrompt (predefined : String) : String :=
    "<subagent>\nUse run_subagent to dispatch independent work that can continue while you keep working. The tool returns task ids immediately; results are injected into this conversation when the child work finishes.\n\nAvailable predefined subagents:\n" ++
    predefined ++
    "\n\nTool guidance:\n1. Use the exact agentId from the predefined list when a listed subagent is suitable for the task.\n2. Omit agentId only when no predefined subagent is suitable or the user explicitly asks for a virtual one-shot subagent.\n3. A virtual one-shot subagent runs with this agent's tools and configuration.\n</subagent>"

/-- The no-subagents line of `formatSubagentSystemPrompt`. -/
def noSubagentsLine : String :=
    "- No predefined subagents are configured. Omit agentId to run a virtual one-shot subagent."

/-- The tool lines of `formatWorkspaceHarnessSystemPrompt`: mixed, writable and read-only. -/
def workspaceToolLines : String × String × String :=
    ("Use the file tools (read, glob) on all workspaces; write, edit, grep, and bash are available only on writable workspaces.",
    "Use the file tools (read, write, edit, glob, grep) and bash to work with the mounted filesystem; bash starts in the current workspace directory.",
    "Use the file tools (read, glob) to read the mounted filesystem. These workspaces are read-only, attempt to modify will get error.")

/-- The memory lines of `formatWorkspaceHarnessSystemPrompt`. -/
def workspaceMemoryLines : String × String × String :=
    ("3. Durable memory is managed through the memory_save tool and the " ++
    memoryIndexPath ++
    " index — see <memory>.",
    "3. Keep durable project facts, decisions, conventions, and context that should survive long-running work as markdown files under memory/, indexed in " ++
    memoryIndexPath ++
    ".",
    "3. Structured memory is disabled for this agent — do not create memory files unless explicitly asked.")

/-- The writable guidance of `formatWorkspaceHarnessSystemPrompt`. -/
def writableGuidance (memoryGuidance : String) : String :=
    "1. Use read/write/edit to inspect and change files, glob/grep to find files and content, and bash to run commands and programs (python3, node, and the usual tools are on PATH).\n2. When more than one workspace is configured, pass the workspace field to select one; omitted means the default workspace.\n" ++
    memoryGuidance ++
    "\n4. Use TASKS.md or focused task markdown files for plans and progress tracking when that helps the work stay aligned.\n5. Treat memory and task files as normal workspace files: read them before relying on them, update them when useful, and keep them concise."

/-- The read-only guidance of `formatWorkspaceHarnessSystemPrompt`. -/
def readOnlyGuidance : String :=
    "1. Use read to inspect files and glob to find files by pattern.\n2. When more than one workspace is configured, pass the workspace field to select one; omitted means the default workspace."

/-- The frame of `formatWorkspaceHarnessSystemPrompt`. -/
def workspacePrompt (toolsLine workspaceList guidance : String) : String :=
    "<workspace>\nA persistent workspace is attached. " ++
    toolsLine ++
    "\n\nConfigured workspaces:\n" ++
    workspaceList ++
    "\n\nGuidance:\n" ++
    guidance ++
    "\n</workspace>"

end Spec.Agent
