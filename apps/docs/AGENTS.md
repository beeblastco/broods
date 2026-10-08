# apps/docs

Docusaurus site at docs.broods.app. two sidebars in `sidebar.ts`, two audiences. keep them apart.

## Layout

- `docs/index.md`, `quickstart.md`, `concepts.md`, `guides/`, `channels/`, `reference/` = user docs. for people building agents on broods. no source paths, no Convex tables, no NATS subjects, no infra env vars. say what it does for them, example first, then a table, then gotchas.
- `docs/internals/` = for people working on broods itself: contributors, self-hosters, operators. source paths, storage layout, design records, deploy and ops live here.
- `docs/api-reference/openapi.yaml` = the HTTP contract, rendered at `/api-reference` by Scalar.
- a feature usually has both: user page in `guides/`, mechanics in `internals/`. link across, do not repeat.

## Gotchas

- new page = add it to `sidebar.ts` too. `onBrokenLinks: "throw"`, so a dead relative link fails the build.
- the isolated linker gives a package one copy per distinct peer set. two versions of `@types/react` or `postcss` in `bun.lock` split `@docusaurus/core` and `@docusaurus/theme-common` into two copies, and every mermaid page dies with `ReactContextError` during SSG. root `overrides` pin both to one version; after a bump, `ls node_modules/.bun | grep theme-common` must show one entry.
- `{param}` inside a mermaid label breaks MDX. write `:param`.
- style: no em dashes, sentence case headings, plain words. check facts against the code, not the old page.
