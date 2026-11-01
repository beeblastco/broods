import { Daytona, Image } from "@daytona/sdk";

const snapshotName = process.env.DAYTONA_S3_SNAPSHOT_NAME!;
const baseImage = process.env.DAYTONA_S3_SNAPSHOT_BASE_IMAGE!;
// Bun preloads .env, and @daytona/sdk >= 0.211 refuses an endpoint the caller did not name.
const apiUrl = process.env.DAYTONA_API_URL;
const image = Image.base(baseImage).runCommands(
  "sudo apt-get update " +
    "&& sudo apt-get install -y --no-install-recommends libfuse2 ca-certificates wget",
  'arch="$(dpkg --print-architecture | sed s/amd64/x86_64/)" ' +
    "&& wget -O /tmp/mount-s3.deb " +
    '"https://s3.amazonaws.com/mountpoint-s3-release/latest/${arch}/mount-s3.deb" ' +
    "&& sudo apt-get install -y /tmp/mount-s3.deb " +
    "&& rm /tmp/mount-s3.deb",
);

console.log(`Creating Daytona snapshot ${snapshotName} from ${baseImage}`);

try {
  const snapshot = await new Daytona(
    apiUrl ? { apiUrl: apiUrl } : {},
  ).snapshot.create(
    { name: snapshotName, image: image },
    {
      timeout: 0,
      onLogs: function (chunk) {
        process.stdout.write(chunk);
      },
    },
  );
  console.log(`\nCreated Daytona snapshot: ${snapshot.name}`);
} catch (err) {
  if ((err as { statusCode?: number })?.statusCode === 409) {
    console.log(`Daytona snapshot ${snapshotName} already exists, skipping.`);
  } else {
    throw err;
  }
}
