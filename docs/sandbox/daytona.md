# Daytona

Uses a [Daytona](https://daytona.io/docs) volume or external storage mount at `options.workspaceRoot`.

## Configuration

```json
{
  "workspace": {
    "sandbox": {
      "enabled": true,
      "provider": "daytona",
      "options": {
        "apiKey": "...",
        "apiUrl": "https://app.daytona.io/api",
        "target": "default",
        "image": "sandbox-image",
        "workspaceRoot": "/mnt/workspaces"
      }
    }
  }
}
```

`apiKey`, `apiUrl`, and `target` can be omitted when `DAYTONA_API_KEY`, `DAYTONA_API_URL`, and `DAYTONA_TARGET` are set.

`options.envVars` can pass additional environment variables into the sandbox container. This is Daytona-only; Lambda and E2B ignore `envVars`.

## Requirements

Use an image or target with Node and Python installed, and mount the workspace at `options.workspaceRoot`.

## Execution Notes

See [Daytona runtime documentation](https://daytona.io/docs) for supported runtimes and environment setup.

TypeScript (`.ts`) files are not transpiled — use compiled JavaScript instead.
`python <file>` is rewritten to `python3` at runtime.

## Workspace Mount

Daytona volume or external storage mounted at `options.workspaceRoot`.

## Dependencies

Use an image or image builder with packages installed before runtime.
