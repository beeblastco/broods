# Snapshots, Images & Sizes

A sandbox boots from a **base image** at a chosen **compute size**. Both are optional:
omit them and the provider uses its default base image and create-time footprint. Pin
them to boot a curated, prebuilt environment with a fixed footprint.

## Pinning an image (`snapshot`)

`config.snapshot` pins a prebuilt image/snapshot to boot from:

```jsonc
{
  "config": {
    "provider": "sandbox",
    "snapshot": "img_curated_python"   // workdir image id/name, or a MicroVM image ARN
  }
}
```

- It is **consumed by the self-hosted backends** (`sandbox`/`lambda`): `sandbox` boots the
  named workdir image, `lambda` selects the MicroVM image by ARN.
- It is **advisory on `daytona`/`e2b`/`vercel`**, which select images through their own
  `options` (Daytona `options.snapshot`, E2B `options.template`, etc.).
- **Omit it** to boot the provider's default base image.
- The launched-from id is **mirrored onto the dashboard instance row** (Snapshots view), so
  you can see exactly which image each running sandbox came from.

A pinned image is the fast path for heavy environments: bake `uv`, system packages, or a
language toolchain into the image once instead of installing them on every cold start.

## Sizes

`config.size` picks a predefined compute footprint. The catalog is canonical for the two
self-hosted backends; `daytona`/`e2b`/`vercel` size natively, so a size is advisory there
(it still sets the specs the dashboard shows). When `size` is omitted, the provider's own
default applies.

| Size | vCPU | Memory | Disk | Tier |
| --- | --- | --- | --- | --- |
| `tiny` | 0.25 | 0.5 GB | 8 GB | free (AWS MicroVM only; workdir clamps vCPU up to 0.5) |
| `xsmall` | 0.5 | 1 GB | 8 GB | free (default) |
| `small` | 1 | 2 GB | 8 GB | paid |
| `medium` | 2 | 4 GB | 16 GB | paid |
| `large` | 4 | 8 GB | 32 GB | paid |

- **workdir (`sandbox`)** applies the size as create-time resources (vCPU clamped to
  workdir's `{0.5, 1, 2, 4}`); explicit `options.cpu`/`memoryMb`/`diskGb` still win.
- **`lambda` (MicroVM)** bakes size into the curated image, so the size is advisory at run
  time and surfaces as the instance's specs.
- Free tier = `tiny` + `xsmall`; usage-limit enforcement is a separate workstream.

## How images are built

Curated images are built and versioned out of band, then referenced by id/ARN:

- **`lambda` (MicroVM):** AWS builds the image from an S3 zip (Dockerfile + sources) via
  `create-microvm-image` / `update-microvm-image`; a build is a Firecracker snapshot of
  memory + disk. CI lives in the
  [`lambda-sandbox`](https://github.com/beeblastco/lambda-sanbdox) sibling repo. See
  [Lambda → Image & build](lambda.md#image--build).
- **`sandbox` (workdir):** images are built/imported through the workdir image API and
  referenced by name.

## Unified status model

The dashboard normalizes each backend's build/lifecycle states into one snapshot status,
so the Snapshots/Images view reads the same regardless of provider:

| Unified status | AWS MicroVM | workdir |
| --- | --- | --- |
| `pending` | Version PENDING | build queued |
| `building` | Version IN_PROGRESS / Image CREATING/UPDATING | image building |
| `pulling` | base/container image pull | base image pull |
| `active` | Version SUCCESSFUL + ACTIVE, Image CREATED/UPDATED | image ready |
| `inactive` | Version SUCCESSFUL + INACTIVE | soft-deleted / idle |
| `error` | Image CREATION_FAILED / `get-microvm` stateReason | runtime / build error |
| `build_failed` | Version FAILED | build failed |

## Capturing a snapshot (provider support)

Capturing a *running* sandbox into a new reusable image is provider-specific:

| Provider | Runtime "Create snapshot" | How a new image is produced |
| --- | --- | --- |
| `sandbox` (workdir) | ✅ yes | dashboard **Create snapshot** captures the running sandbox into a workdir image you can pin via `config.snapshot` |
| `lambda` (MicroVM) | ❌ no | **AWS MicroVM has no runtime image-capture API** — images are built ahead of time as versioned MicroVM image builds (see [Lambda → Image & build](lambda.md#image--build)). A running VM's state is preserved across idle via **suspend/resume**, not by snapshotting it into a new image. |
| `daytona` / `e2b` / `vercel` | ❌ no (in this harness) | use the provider's own snapshot/template tooling and reference it through `options` |

So the dashboard's **Create snapshot** action is shown only for `sandbox` instances; for
the other providers the Snapshots view lists images but does not offer runtime capture. A
captured `sandbox` snapshot can then be pinned via `config.snapshot` on a later sandbox.
