#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/root}"

api_url="${GITHUB_API_URL:-https://api.github.com}"
git_name="${GITHUB_GIT_USER_NAME:-Broods Agent}"
git_email="${GITHUB_GIT_USER_EMAIL:-broods-agent@users.noreply.github.com}"
helper="$HOME/.local/bin/git-credential-broods-github-app"
token_helper="$HOME/.local/bin/broods-github-token"

command -v git >/dev/null
command -v node >/dev/null

: "${GITHUB_APP_ID:?Missing GITHUB_APP_ID}"
: "${GITHUB_PRIVATE_KEY:?Missing GITHUB_PRIVATE_KEY}"

mkdir -p "$HOME/.local/bin"

cat > "$helper" <<'NODE'
#!/usr/bin/env node
const crypto = require("node:crypto");

const action = process.argv[2] || "get";
if (action !== "get") {
  process.exit(0);
}

function clean(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function required(name) {
  const value = clean(process.env[name]);
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return value;
}

function normalizePrivateKey(value) {
  const cleaned = clean(value).replace(/\\n/g, "\n");
  return cleaned.includes("-----BEGIN") ? cleaned : Buffer.from(cleaned, "base64").toString("utf8");
}

function readCredentialRequest() {
  const input = require("node:fs").readFileSync(0, "utf8");
  const fields = {};
  for (const line of input.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) {
      fields[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return fields;
}

function repositoryFromCredential(fields) {
  const path = clean(fields.path).replace(/^\/+/, "").replace(/\.git$/, "");
  const [owner, repo] = path.split("/");
  if (!owner || !repo) {
    throw new Error("Git credential request did not include an owner/repo path");
  }
  return `${owner}/${repo}`;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: required("GITHUB_APP_ID"),
  }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(normalizePrivateKey(required("GITHUB_PRIVATE_KEY")));
  return `${unsigned}.${base64Url(signature)}`;
}

async function installationId(jwt, apiUrl, repository) {
  const explicit = clean(process.env.GITHUB_INSTALLATION_ID);
  if (explicit) return explicit;

  const response = await fetch(`${apiUrl}/repos/${repository}/installation`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub installation lookup failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json();
  if (!body.id) {
    throw new Error("GitHub installation lookup did not return id");
  }
  return String(body.id);
}

async function main() {
  const fields = readCredentialRequest();
  const apiUrl = clean(process.env.GITHUB_API_URL) || "https://api.github.com";
  const repository = repositoryFromCredential(fields);
  const jwt = appJwt();
  const id = await installationId(jwt, apiUrl.replace(/\/+$/, ""), repository);
  const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/app/installations/${encodeURIComponent(id)}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub installation token request failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json();
  if (!body.token) {
    throw new Error("GitHub installation token response did not include token");
  }
  process.stdout.write(`username=x-access-token\npassword=${body.token}\n\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE

chmod 700 "$helper"

cat > "$token_helper" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

repo="${1:?Usage: broods-github-token owner/repo}"
git credential fill <<EOF | sed -n 's/^password=//p'
protocol=https
host=github.com
path=${repo%.git}.git

EOF
SH

chmod 700 "$token_helper"

git config --global user.name "$git_name"
git config --global user.email "$git_email"
git config --global push.default current
git config --global credential.useHttpPath true
git config --global credential.helper "$helper"
git config --global credential.https://github.com.username x-access-token || true

echo "GitHub App git credential helper ready. Clone the repository needed for the current task."
