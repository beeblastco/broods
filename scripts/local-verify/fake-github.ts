import {
  createHmac,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import { blake2b } from "@noble/hashes/blake2b";
import nacl from "tweetnacl";

const SECRET_KEY_ID = "fake-key";

/** A repo the fake serves: branches point at commits, commits at file maps. */
export interface FakeRepo {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  /** Negative until the App is given a repo the user just created. */
  installationId: number;
  /** Branch name → commit sha. */
  branches: Map<string, string>;
  /** Branches that refuse a direct commit, like a protected `main`. */
  protectedBranches: Set<string>;
  /** Decrypted Actions secrets, so a case can deploy with what Broods sealed; `env/NAME` for an environment's. */
  secrets: Map<string, string>;
  /** Environment → the branches its deployment policy allows; null on a plan without environments. */
  environments: Map<string, Set<string>> | null;
  /** How many secrets existed at each branch write, to prove they landed before the first push. */
  secretsAtPush: number[];
  pulls: Array<{ head: string; base: string; url: string }>;
  keyPair: nacl.BoxKeyPair;
}

export interface FakeInstallation {
  id: number;
  login: string;
  type: "User" | "Organization";
}

/** The fake's state and helpers a case reads and seeds. */
export interface FakeGitHub {
  url: string;
  repos: Map<number, FakeRepo>;
  /** Adds a repo with one commit holding `files` on `defaultBranch`. */
  addRepo: (repo: NewRepo) => FakeRepo;
  /** The files at a branch's head; null when the branch is missing. */
  filesAt: (repoId: number, branch: string) => Map<string, string> | null;
  /** Posts a webhook delivery to `target`, signed with `secret`. */
  deliver: (
    target: string,
    event: string,
    payload: unknown,
    secret?: string,
  ) => Promise<number>;
  stop: () => void;
}

interface NewRepo {
  id: number;
  fullName: string;
  installationId: number;
  files: Record<string, string>;
  defaultBranch?: string;
  protectedBranches?: string[];
}

interface FakeOptions {
  port: number;
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
  installations: FakeInstallation[];
  /** The GitHub user the code exchange signs in. */
  user: { login: string; code: string };
}

// The request as a route sees it.
interface Call {
  method: string;
  match: RegExpMatchArray;
  body: Record<string, unknown>;
  query: URLSearchParams;
  auth: string;
}

// A route under /repos/{owner}/{name}, once the token is known to reach it.
interface RepoCall extends Call {
  repo: FakeRepo;
}

type Route = [
  method: string,
  pattern: RegExp,
  handle: (call: Call) => Response,
];

type RepoRoute = [
  method: string,
  pattern: RegExp,
  handle: (call: RepoCall) => Response,
];

/**
 * GitHub's REST API, as far as a repo link uses it: the App's JWT and
 * installation tokens, the user's code exchange, repos, trees, contents,
 * refs, pulls, sealed Actions secrets and repo creation. Everything is in
 * memory; a protected branch answers a direct commit with 409, as GitHub does.
 */
export function startFakeGitHub(options: FakeOptions): FakeGitHub {
  const publicKey = createPublicKey(options.privateKey);
  const installationTokens = new Map<string, number>();
  const userTokens = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string }>();
  const repos = new Map<number, FakeRepo>();
  const installations = new Map(
    options.installations.map((entry): [number, FakeInstallation] => [
      entry.id,
      entry,
    ]),
  );

  const commit = (files: Map<string, string>): string => {
    const tree = sha();
    trees.set(tree, files);
    const id = sha();
    commits.set(id, { tree: tree });

    return id;
  };
  const filesAt = (
    repoId: number,
    branch: string,
  ): Map<string, string> | null => {
    const head = repos.get(repoId)?.branches.get(branch);
    const tree = head ? commits.get(head)?.tree : undefined;

    return tree ? (trees.get(tree) ?? null) : null;
  };
  const addRepo = (repo: NewRepo): FakeRepo => {
    const defaultBranch = repo.defaultBranch ?? "main";
    const created: FakeRepo = {
      id: repo.id,
      fullName: repo.fullName,
      private: true,
      defaultBranch: defaultBranch,
      installationId: repo.installationId,
      branches: new Map([
        [defaultBranch, commit(new Map(Object.entries(repo.files)))],
      ]),
      protectedBranches: new Set(repo.protectedBranches ?? []),
      secrets: new Map(),
      environments: new Map(),
      secretsAtPush: [],
      pulls: [],
      keyPair: nacl.box.keyPair(),
    };
    repos.set(repo.id, created);

    return created;
  };
  const userOf = (call: Call): string | undefined => userTokens.get(call.auth);

  const routes: Route[] = [
    [
      "POST",
      /^\/login\/oauth\/access_token$/,
      (call): Response => {
        if (
          call.body.client_id !== options.clientId ||
          call.body.client_secret !== options.clientSecret ||
          call.body.code !== options.user.code
        ) {
          return json(200, { error: "bad_verification_code" });
        }
        const token = `ghu_${randomBytes(8).toString("hex")}`;
        userTokens.set(token, options.user.login);

        return json(200, { access_token: token });
      },
    ],
    [
      "POST",
      /^\/app\/installations\/(\d+)\/access_tokens$/,
      (call): Response => {
        if (!validAppJwt(call.auth, publicKey, options.appId)) {
          return json(401, {
            message: "A JSON web token could not be decoded",
          });
        }
        const id = Number(call.match[1]);
        if (!installations.has(id)) return notFound();
        const token = `ghs_${randomBytes(8).toString("hex")}`;
        installationTokens.set(token, id);

        return json(201, { token: token });
      },
    ],
    [
      "GET",
      /^\/user\/installations$/,
      (call): Response =>
        userOf(call)
          ? json(200, {
              installations: [...installations.values()].map((entry) => ({
                id: entry.id,
                account: { login: entry.login, type: entry.type },
              })),
            })
          : badCredentials(),
    ],
    [
      "POST",
      /^\/(?:user|orgs\/([^/]+))\/repos$/,
      (call): Response => {
        const user = userOf(call);
        if (!user) return badCredentials();
        const owner = call.match[1] ?? user;
        const fullName = `${owner}/${String(call.body.name)}`;
        if ([...repos.values()].some((repo) => repo.fullName === fullName)) {
          return json(422, { message: "name already exists on this account" });
        }
        const installation = [...installations.values()].find(
          (entry) => entry.login === owner,
        );
        const repo = addRepo({
          id: 50_000 + repos.size,
          fullName: fullName,
          installationId: -(installation?.id ?? 0),
          files: call.body.auto_init
            ? { "README.md": `# ${String(call.body.name)}\n` }
            : {},
        });
        repo.private = Boolean(call.body.private);
        // A free plan's private repo: GitHub refuses environments there.
        repo.environments = null;

        return json(201, rawRepo(repo));
      },
    ],
    [
      "PUT",
      /^\/user\/installations\/(\d+)\/repositories\/(\d+)$/,
      (call): Response => {
        if (!userOf(call)) return badCredentials();
        const repo = repos.get(Number(call.match[2]));
        if (!repo) return notFound();
        repo.installationId = Number(call.match[1]);

        return new Response(null, { status: 204 });
      },
    ],
    [
      "GET",
      /^\/installation\/repositories$/,
      (call): Response => {
        const id = installationTokens.get(call.auth);
        if (id === undefined) return badCredentials();
        const list = [...repos.values()]
          .filter((repo) => repo.installationId === id)
          .map(rawRepo);

        return json(200, { total_count: list.length, repositories: list });
      },
    ],
    [
      "GET",
      /^\/repositories\/(\d+)$/,
      (call): Response => {
        const repo = repos.get(Number(call.match[1]));
        const id = installationTokens.get(call.auth);

        return repo && repo.installationId === id
          ? json(200, rawRepo(repo))
          : notFound();
      },
    ],
  ];

  const repoRoutes: RepoRoute[] = [
    [
      "GET",
      /^\/git\/trees\/(.+)$/,
      ({ match, repo }): Response => {
        const files = filesAt(repo.id, match[1] ?? "");

        return files
          ? json(200, {
              tree: [...files.keys()].map((path) => ({
                path: path,
                type: "blob",
              })),
              truncated: false,
            })
          : notFound();
      },
    ],
    [
      "POST",
      /^\/git\/trees$/,
      ({ body }): Response => {
        const files = new Map(trees.get(String(body.base_tree)) ?? []);
        for (const entry of body.tree as Array<{
          path: string;
          content: string;
        }>) {
          files.set(entry.path, entry.content);
        }
        const tree = sha();
        trees.set(tree, files);

        return json(201, { sha: tree });
      },
    ],
    [
      "GET",
      /^\/git\/commits\/(\w+)$/,
      ({ match }): Response => {
        const found = commits.get(match[1] ?? "");

        return found ? json(200, { tree: { sha: found.tree } }) : notFound();
      },
    ],
    [
      "POST",
      /^\/git\/commits$/,
      ({ body }): Response => {
        if (!trees.has(String(body.tree))) {
          return json(422, { message: "Tree not found" });
        }
        const id = sha();
        commits.set(id, { tree: String(body.tree) });

        return json(201, { sha: id });
      },
    ],
    [
      "GET",
      /^\/git\/ref\/heads\/(.+)$/,
      ({ match, repo }): Response => {
        const head = repo.branches.get(match[1] ?? "");

        return head ? json(200, { object: { sha: head } }) : notFound();
      },
    ],
    [
      "POST",
      /^\/git\/refs$/,
      ({ body, repo }): Response => {
        const branch = String(body.ref).replace(/^refs\/heads\//, "");
        if (repo.branches.has(branch)) {
          return json(422, { message: "Reference already exists" });
        }
        repo.branches.set(branch, String(body.sha));
        repo.secretsAtPush.push(repo.secrets.size);

        return json(201, { ref: body.ref });
      },
    ],
    [
      "PATCH",
      /^\/git\/refs\/heads\/(.+)$/,
      ({ body, match, repo }): Response => {
        repo.branches.set(match[1] ?? "", String(body.sha));
        repo.secretsAtPush.push(repo.secrets.size);

        return json(200, { object: { sha: body.sha } });
      },
    ],
    [
      "GET",
      /^\/branches\/(.+)$/,
      ({ match, repo }): Response =>
        repo.branches.has(match[1] ?? "")
          ? json(200, { name: match[1] })
          : json(404, { message: "Branch not found" }),
    ],
    [
      "GET",
      /^\/contents\/(.+)$/,
      ({ match, query, repo }): Response => {
        const files = filesAt(repo.id, query.get("ref") ?? repo.defaultBranch);
        const content = files?.get(match[1] ?? "");

        return content === undefined
          ? notFound()
          : json(200, {
              sha: blobSha(content),
              content: Buffer.from(content).toString("base64"),
            });
      },
    ],
    [
      "PUT",
      /^\/contents\/(.+)$/,
      ({ body, match, repo }): Response => {
        const branch = String(body.branch);
        const path = match[1] ?? "";
        const files = filesAt(repo.id, branch);
        if (!files)
          return json(404, { message: "No commit found for the ref" });
        if (repo.protectedBranches.has(branch)) {
          return json(409, {
            message: "Changes must be made through a pull request.",
          });
        }
        const current = files.get(path);
        if (current !== undefined && body.sha !== blobSha(current)) {
          return json(409, {
            message: `${path} does not match ${String(body.sha)}`,
          });
        }
        const next = new Map(files);
        next.set(path, Buffer.from(String(body.content), "base64").toString());
        repo.branches.set(branch, commit(next));
        repo.secretsAtPush.push(repo.secrets.size);

        return json(current === undefined ? 201 : 200, {
          content: { path: path },
        });
      },
    ],
    [
      "GET",
      /^\/pulls$/,
      ({ query, repo }): Response =>
        json(
          200,
          repo.pulls
            .filter(
              (pull) =>
                pull.base === query.get("base") &&
                pull.head === query.get("head")?.split(":")[1],
            )
            .map((pull) => ({ html_url: pull.url })),
        ),
    ],
    [
      "POST",
      /^\/pulls$/,
      ({ body, repo }): Response => {
        const pull = {
          head: String(body.head),
          base: String(body.base),
          url: `https://github.com/${repo.fullName}/pull/${repo.pulls.length + 1}`,
        };
        repo.pulls.push(pull);

        return json(201, { html_url: pull.url });
      },
    ],
    [
      "PUT",
      /^\/environments\/([\w-]+)$/,
      ({ match, repo }): Response => {
        if (!repo.environments) {
          return json(422, { message: "Environments are not available" });
        }
        const name = match[1] ?? "";
        if (!repo.environments.has(name))
          repo.environments.set(name, new Set());

        return json(200, { name: name });
      },
    ],
    [
      "POST",
      /^\/environments\/([\w-]+)\/deployment-branch-policies$/,
      ({ body, match, repo }): Response => {
        const policies = repo.environments?.get(match[1] ?? "");
        if (!policies) return notFound();
        policies.add(String(body.name));

        return json(200, { name: body.name });
      },
    ],
    [
      "GET",
      /^\/(?:environments\/[\w-]+\/)?(?:actions\/)?secrets\/public-key$/,
      ({ repo }): Response =>
        json(200, {
          key_id: SECRET_KEY_ID,
          key: Buffer.from(repo.keyPair.publicKey).toString("base64"),
        }),
    ],
    [
      "PUT",
      /^\/(?:environments\/([\w-]+)\/secrets|actions\/secrets)\/(\w+)$/,
      ({ body, match, repo }): Response => {
        const environment = match[1];
        if (environment && !repo.environments?.has(environment)) {
          return notFound();
        }
        const opened = openSealed(String(body.encrypted_value), repo.keyPair);
        if (opened === null || body.key_id !== SECRET_KEY_ID) {
          return json(422, { message: "Bad encrypted_value" });
        }
        const name = match[2] ?? "";
        repo.secrets.set(environment ? `${environment}/${name}` : name, opened);

        return new Response(null, { status: 201 });
      },
    ],
  ];

  // /repos/{owner}/{name}/... is served only when the token's installation reaches it.
  routes.push([
    "ANY",
    /^\/repos\/([^/]+\/[^/]+)(\/.*)$/,
    (call): Response => {
      const repo = [...repos.values()].find(
        (entry) => entry.fullName === call.match[1],
      );
      const id = installationTokens.get(call.auth);
      if (!repo || repo.installationId !== id) return notFound();

      return dispatch(
        repoRoutes,
        call.method,
        call.match[2] ?? "",
        (match) => ({
          ...call,
          match: match,
          repo: repo,
        }),
      );
    },
  ]);

  const server = Bun.serve({
    port: options.port,
    hostname: "0.0.0.0",
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const body =
        request.method === "GET"
          ? {}
          : ((await request.json().catch(() => ({}))) as Record<
              string,
              unknown
            >);
      const auth =
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

      return dispatch(
        routes,
        request.method,
        decodeURIComponent(url.pathname),
        (match) => ({
          match: match,
          body: body,
          query: url.searchParams,
          auth: auth,
          method: request.method,
        }),
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    repos: repos,
    addRepo: addRepo,
    filesAt: filesAt,
    deliver: async (
      target: string,
      event: string,
      payload: unknown,
      secret: string = options.webhookSecret,
    ): Promise<number> => {
      const text = JSON.stringify(payload);
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": event,
          "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`,
        },
        body: text,
      });

      return response.status;
    },
    stop: (): void => {
      void server.stop(true);
    },
  };
}

function badCredentials(): Response {
  return json(401, { message: "Bad credentials" });
}

function blobSha(content: string): string {
  return Bun.hash(content).toString(16);
}

// The first route whose method and pattern match answers; 404 otherwise.
function dispatch<T>(
  table: ReadonlyArray<[string, RegExp, (call: T) => Response]>,
  method: string,
  path: string,
  call: (match: RegExpMatchArray) => T,
): Response {
  for (const [routeMethod, pattern, handle] of table) {
    if (routeMethod !== "ANY" && routeMethod !== method) continue;
    const match = path.match(pattern);
    if (match) return handle(call(match));
  }

  return json(404, { message: `fake GitHub has no ${method} ${path}` });
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status: status });
}

function notFound(): Response {
  return json(404, { message: "Not Found" });
}

// libsodium's crypto_box_seal_open: the sender's ephemeral key leads the box.
function openSealed(value: string, keyPair: nacl.BoxKeyPair): string | null {
  const sealed = Buffer.from(value, "base64");
  const ephemeral = sealed.subarray(0, 32);
  const nonce = blake2b(Buffer.concat([ephemeral, keyPair.publicKey]), {
    dkLen: 24,
  });
  const opened = nacl.box.open(
    sealed.subarray(32),
    nonce,
    ephemeral,
    keyPair.secretKey,
  );

  return opened ? Buffer.from(opened).toString("utf8") : null;
}

function rawRepo(repo: FakeRepo): Record<string, unknown> {
  return {
    id: repo.id,
    full_name: repo.fullName,
    private: repo.private,
    default_branch: repo.defaultBranch,
  };
}

function sha(): string {
  return randomBytes(20).toString("hex");
}

function validAppJwt(
  token: string,
  publicKey: KeyObject,
  appId: string,
): boolean {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;
  const signed = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as { iss?: string; exp?: number };

  return (
    signed && claims.iss === appId && (claims.exp ?? 0) * 1000 > Date.now()
  );
}
