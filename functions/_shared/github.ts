/**
 * GitHub transport helpers.
 * Keep GitHub App auth and outbound REST calls here.
 */

import { createSign } from "node:crypto";
import type { ChannelActions } from "./channels.ts";
import type { GitHubSource } from "./github-channel.ts";

export function createGitHubActions(
  appId: string,
  privateKey: string,
  source: GitHubSource,
): ChannelActions {
  let installationTokenPromise: Promise<string> | undefined;

  const getInstallationToken = () => {
    installationTokenPromise ??= createInstallationToken(appId, privateKey, source.installationId);
    return installationTokenPromise;
  };

  return {
    async sendText(text) {
      const token = await getInstallationToken();

      if (source.target === "pull_request_review_comment" && source.pullNumber && source.commentId) {
        await githubApi(
          token,
          `repos/${source.owner}/${source.repo}/pulls/${source.pullNumber}/comments/${source.commentId}/replies`,
          { body: text },
        );
        return;
      }

      if (!source.issueNumber) {
        throw new Error("GitHub sendText requires an issue or pull request number");
      }

      await githubApi(
        token,
        `repos/${source.owner}/${source.repo}/issues/${source.issueNumber}/comments`,
        { body: text },
      );
    },

    async sendTyping() {
      return;
    },

    async reactToMessage() {
      const token = await getInstallationToken();

      if (source.target === "pull_request_review_comment" && source.commentId) {
        await githubApi(
          token,
          `repos/${source.owner}/${source.repo}/pulls/comments/${source.commentId}/reactions`,
          { content: "eyes" },
        );
        return;
      }

      if (source.commentId) {
        await githubApi(
          token,
          `repos/${source.owner}/${source.repo}/issues/comments/${source.commentId}/reactions`,
          { content: "eyes" },
        );
        return;
      }

      if (!source.issueNumber) {
        return;
      }

      await githubApi(
        token,
        `repos/${source.owner}/${source.repo}/issues/${source.issueNumber}/reactions`,
        { content: "eyes" },
      );
    },
  };
}

async function createInstallationToken(
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<string> {
  const jwt = createGitHubJwt(appId, privateKey);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  const json = await response.json() as { token?: string; message?: string };
  if (!response.ok || !json.token) {
    throw new Error(
      `GitHub installation token request failed (${response.status}): ${json.message ?? "unknown_error"}`,
    );
  }

  return json.token;
}

function createGitHubJwt(appId: string, privateKey: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: appId,
  }));
  const unsigned = `${header}.${payload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();

  const signature = signer.sign(normalizePrivateKey(privateKey));
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function githubApi(
  token: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`https://api.github.com/${path}`, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${body}`);
  }
}

function normalizePrivateKey(value: string): string {
  return value.includes("BEGIN") ? value : Buffer.from(value, "base64").toString("utf8");
}

function base64UrlEncode(value: string | Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
