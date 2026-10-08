# Dashboard links

Dashboard views keep their tab, search, time range and open row in the URL, so a link opens the same view. An agent can build one and hand it to a user ("here is the failed run"), and a teammate can paste the address bar into chat.

```text
https://dashboard.broods.app/<projectId>/dashboard?stage=<stageId>&tab=tracing&trace=4bf92f3577b34da6a3ce929d0e0e4736
https://dashboard.broods.app/<projectId>/dashboard?tab=monitoring&q=level%3Aerror%20timeout&range=1d
https://dashboard.broods.app/<projectId>/scheduler?q=status%3Afailed&sort=next.asc&sel=<cronId>
```

The first opens Tracing on one run. The second opens Monitoring on error lines that mention `timeout` in the last day. The third opens the scheduler filtered to failed schedules, soonest first, with one schedule's panel open.

Lists remember each viewer's last search. A list link without `q` opens with that search, so add `q=` (empty) when the row in `sel` must show.

Copy `<projectId>` and `<stageId>` from any dashboard URL. Without `stage` the project's default Development stage opens. A link to `https://dashboard.broods.app/?project=<projectId>&tab=tracing&trace=...` resolves the project first and keeps the view params (`tab`, `trace`, `q`, `range`, `from`, `to`, `models`, `bin`, `node`); list params need the full project URL.

## Params

| Page                                               | Param        | Takes                                                                       |
| -------------------------------------------------- | ------------ | --------------------------------------------------------------------------- |
| every page                                         | `stage`      | A stage id of the project                                                   |
| every page with tabs                               | `tab`        | One of the page's tab ids, e.g. `monitoring`, `tracing`, `usage`, `members` |
| Monitoring (`/dashboard?tab=monitoring`)           | `q`          | The search box: words and `level:` `source:` `agent:` `trace:` `event:`     |
|                                                    | `range`      | `1h`, `3h`, `1d`, `7d`, `30d` (default `30d`)                               |
|                                                    | `from`, `to` | A window inside the range, epoch ms; `to` absent means up to now            |
| Tracing (`/dashboard?tab=tracing`)                 | `q`          | Words and `status:` `channel:` `agent:` `tool:` `error:` `trace:` `conv:`   |
|                                                    | `range`      | As Monitoring (default `7d`)                                                |
|                                                    | `from`, `to` | As Monitoring                                                               |
|                                                    | `trace`      | The run to select: a 32 character hex trace id                              |
| Usage (`/dashboard?tab=usage`)                     | `range`      | `1h`, `3h`, `1d`, `7d`, `30d`, `1y` (default `1h`)                          |
|                                                    | `models`     | Comma separated `provider::model` keys to show                              |
|                                                    | `bin`        | The chart bar to open, by its start in epoch ms                             |
| Scheduler, Sandbox, project and org settings lists | `q`          | The list's search box, with the `field:value` chips it offers               |
|                                                    | `sort`       | `column.dir`, e.g. `lastUsed.desc`                                          |
|                                                    | `sel`        | The id of the row whose panel is open (a role's name on Roles)              |
| Canvas (`/<projectId>`)                            | `node`       | The node to focus                                                           |

## What a link cannot do

- A link only sets what you see. It never runs an agent, continues a run, creates, edits or deletes anything; those stay behind a click.
- It shows only what the person opening it may already read. An id from another project or org selects nothing.
- A value that fails its check (an unknown range, a malformed id, a search longer than 500 characters, `from` after `to`) is ignored and the default view opens.
- Keep secrets out of links. Search text sits in browser history like any URL.
- Switching tabs keeps only `stage`, so one tab's search never filters another.
