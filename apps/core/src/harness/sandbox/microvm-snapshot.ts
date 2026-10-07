/**
 * The in-VM half of a lambda snapshot. AWS cannot capture a running MicroVM, so
 * a snapshot is an image build: the VM tars every file changed since it started,
 * appends `ADD <tar> /` to the Dockerfile of the image it booted from, and
 * uploads the result for core to hand to CreateMicrovmImage.
 */

import { shellQuote } from "./utils.ts";

// Paths a snapshot never carries: kernel and runtime trees, scratch space, the
// workspace mount (S3 keeps it), and the snapshot's own work directory.
const SKIPPED_ROOTS = [
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/tmp",
  "/var/tmp",
  "/var/run",
  "/mnt",
  "/lost+found",
];
// A larger capture is refused: an image that big would boot slowly anyway. The
// rebuilt zip, which also carries the source image, must fit one presigned PUT.
export const MAX_SNAPSHOT_BYTES = 4 * 1024 ** 3;
const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
// Files changed slightly before the reported start still count, and a VM clock
// further off than this is refused, since it could hide changed files.
const START_SLACK_SECONDS = 60;
const MAX_CLOCK_SKEW_SECONDS = 300;

const CAPTURE_PY = String.raw`
import json, os, shutil, sys, tarfile, tempfile, time, urllib.request, zipfile

started = float(os.environ["BROODS_STARTED_AT"]) - float(os.environ["BROODS_START_SLACK"])
skew = abs(time.time() - float(os.environ["BROODS_NOW"]))
if skew > ${MAX_CLOCK_SKEW_SECONDS}:
    sys.exit("the VM clock is %ds off, so a snapshot could miss changed files" % skew)
skipped = json.loads(os.environ["BROODS_SKIPPED"])
top = os.environ["BROODS_ROOT"]
limit = int(os.environ["BROODS_MAX_BYTES"])
name = os.environ["BROODS_TAR_NAME"]


def inside(path):
    """Return the path as the VM sees it, from the capture root."""
    rel = os.path.relpath(path, top)
    return "/" if rel == "." else "/" + rel


def is_skipped(path):
    """Return whether the path sits under a root a snapshot never carries."""
    rel = inside(path)
    return any(rel == root or rel.startswith(root + "/") for root in skipped)


def capture(work):
    """Tar the changes, rebuild the image zip around them and upload it."""
    tar_path = os.path.join(work, name)
    root_dev = os.lstat(top).st_dev
    files = 0
    size = 0
    with tarfile.open(tar_path, "w") as tar:
        for here, dirs, names in os.walk(top, topdown=True):
            dirs[:] = [d for d in dirs if not is_skipped(os.path.join(here, d))]
            for entry in dirs + names:
                path = os.path.join(here, entry)
                try:
                    st = os.lstat(path)
                except FileNotFoundError:
                    continue
                if st.st_dev != root_dev:
                    continue
                if max(st.st_mtime, st.st_ctime) <= started:
                    continue
                tar.add(path, arcname=inside(path).lstrip("/"), recursive=False)
                files += 1
                size += st.st_size
                if size > limit:
                    sys.exit("the changes pass %d bytes, too large to snapshot" % limit)
    source = os.path.join(work, "source.zip")
    urllib.request.urlretrieve(os.environ["BROODS_SOURCE_URL"], source)
    out = os.path.join(work, "out.zip")
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "Dockerfile":
                data += ("\nADD %s /\n" % name).encode()
            zout.writestr(item, data)
        zout.write(tar_path, name, compress_type=zipfile.ZIP_STORED)
    length = os.path.getsize(out)
    if length > ${MAX_UPLOAD_BYTES}:
        sys.exit("the image zip is %d bytes, past the 5 GiB upload limit" % length)
    with open(out, "rb") as body:
        request = urllib.request.Request(
            os.environ["BROODS_UPLOAD_URL"],
            data=body,
            method="PUT",
            headers={"Content-Length": str(length)},
        )
        urllib.request.urlopen(request).close()
    return {"files": files, "bytes": length}


# Each capture works in its own directory, removed however the capture ends.
work = tempfile.mkdtemp(prefix="broods-snapshot-")
try:
    print(json.dumps(capture(work)))
finally:
    shutil.rmtree(work, ignore_errors=True)
`;

/**
 * The shell command and environment that capture a running VM for one snapshot.
 * `startedAt` is when GetMicrovm says the VM first started; `sourceUrl` reads the
 * zip of the image it booted from and `uploadUrl` takes the rebuilt zip.
 */
export function snapshotCapture(input: {
  snapshotId: string;
  startedAt: Date;
  sourceUrl: string;
  uploadUrl: string;
  workspaceRoot: string;
}): { script: string; env: Record<string, string> } {
  return {
    script: `python3 -c ${shellQuote(CAPTURE_PY)}`,
    env: {
      BROODS_ROOT: "/",
      BROODS_STARTED_AT: String(input.startedAt.getTime() / 1000),
      BROODS_START_SLACK: String(START_SLACK_SECONDS),
      BROODS_NOW: String(Date.now() / 1000),
      BROODS_SKIPPED: JSON.stringify([...SKIPPED_ROOTS, input.workspaceRoot]),
      BROODS_MAX_BYTES: String(MAX_SNAPSHOT_BYTES),
      BROODS_TAR_NAME: `broods-snapshot-${input.snapshotId}.tar`,
      BROODS_SOURCE_URL: input.sourceUrl,
      BROODS_UPLOAD_URL: input.uploadUrl,
    },
  };
}
