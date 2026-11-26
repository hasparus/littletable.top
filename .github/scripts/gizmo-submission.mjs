import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const segment = /^[a-zA-Z\d][a-zA-Z\d_.-]{0,79}$/u;

export function submission(value) {
  const url = value?.trim();
  const match = url?.match(
    /^https:\/\/github\.com\/([a-z\d][a-z\d-]{0,38})\/([a-z\d][a-z\d_.-]{0,99})\/blob\/([a-f\d]{40})\/(.+)$/u,
  );
  if (!match || url.length > 450) throw new Error("Supply a pinned GitHub manifest URL.");
  const [, owner, repo, sha, path] = match;
  const parts = path.split("/");
  if (
    path.length > 240 ||
    !parts.every((part) => segment.test(part)) ||
    parts.at(-1) !== "gizmo.json"
  )
    throw new Error("Supply a pinned GitHub manifest URL.");
  const project = owner + "/" + repo;
  const identity = project + "/" + path;
  return {
    url,
    project,
    sha,
    path,
    identity,
    key: digest(url),
    record: "gizmos/registry/" + digest(identity) + ".json",
    directory: url.replace("/blob/", "/tree/").slice(0, -"/gizmo.json".length),
  };
}

async function publicNames(source) {
  const response = await fetch(
    "https://raw.githubusercontent.com/" + source.project + "/" + source.sha + "/" + source.path,
    {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok || !response.body) throw new Error("The public manifest is unavailable.");
  const chunks = [];
  let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > 65536) throw new Error("Manifest exceeds 64 KiB.");
    chunks.push(bytes);
  }
  const { name } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  for (const label of [name?.en, name?.pl]) {
    if (
      typeof label !== "string" ||
      !label.trim() ||
      label.length > 100 ||
      /[\p{Cc}\p{Cf}]/u.test(label)
    )
      throw new Error("Manifest requires English and Polish listing names.");
  }
  return { en: name.en, pl: name.pl };
}

function github(token) {
  return async (path, { method = "GET", body, missing = false } = {}) => {
    const response = await fetch("https://api.github.com/" + path, {
      redirect: "error",
      method,
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "User-Agent": "Little-Table-Gizmo-Review",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok)
      throw new Error("GitHub API returned " + response.status + " for " + method + " " + path);
    return response.json();
  };
}

export async function propose({ repository, base, issue, source, api, names = publicNames }) {
  const branch = "gizmo-submission/" + source.key;
  const root = "repos/" + repository;
  const head = repository.split("/")[0] + ":" + branch;
  const query = new URLSearchParams({ state: "all", base, head, per_page: "1" });
  const [previous] = await api(root + "/pulls?" + query);
  if (previous) return previous.html_url;

  const baseRef = await api(root + "/git/ref/heads/" + base);
  const baseSha = baseRef.object.sha;
  async function read(path) {
    const file = await api(root + "/contents/" + path + "?ref=" + baseSha, { missing: true });
    return file && JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  }
  const officialPath = "gizmos/registry.json";
  const official = await read(officialPath);
  const bundled = official.find((item) => submission(item.url).identity === source.identity);
  const path = bundled ? officialPath : source.record;
  const existing = bundled ?? (await read(path));
  if (existing?.url === source.url)
    return "https://github.com/" + repository + "/blob/" + baseSha + "/" + path;
  const listing = {
    name: await names(source),
    thumbnail: existing?.thumbnail ?? "/icon-192.png",
    url: source.url,
  };
  const json = bundled ? official.map((row) => (row === bundled ? listing : row)) : listing;
  const contents = Buffer.from(JSON.stringify(json, null, 2) + "\n").toString("base64");

  const ref = await api(root + "/git/ref/heads/" + branch, { missing: true });
  if (!ref) {
    await api(root + "/git/refs", {
      method: "POST",
      body: { ref: "refs/heads/" + branch, sha: baseSha },
    });
  }
  if (!ref || ref.object.sha === baseSha) {
    const result = await api("graphql", {
      method: "POST",
      body: {
        query:
          "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
        variables: {
          input: {
            branch: { repositoryNameWithOwner: repository, branchName: branch },
            expectedHeadOid: baseSha,
            message: { headline: "Propose marketplace revision " + source.sha.slice(0, 12) },
            fileChanges: { additions: [{ path, contents }] },
          },
        },
      },
    });
    if (!result.data?.createCommitOnBranch?.commit?.oid)
      throw new Error("Unable to commit the registry proposal.");
  } else {
    // Recover a run interrupted between writing the registry entry and opening its PR.
    const diff = await api(root + "/compare/" + baseSha + "..." + ref.object.sha);
    const file = await api(root + "/contents/" + path + "?ref=" + ref.object.sha, {
      missing: true,
    });
    if (
      diff.ahead_by !== 1 ||
      diff.files?.length !== 1 ||
      diff.files[0].filename !== path ||
      file?.content.replaceAll("\n", "") !== contents
    )
      throw new Error("The existing proposal branch needs maintainer review.");
  }

  const body = [
    "Review [" +
      source.project +
      " at " +
      source.sha.slice(0, 12) +
      "](" +
      source.directory +
      "). [Manifest](" +
      source.url +
      ") · [Commit](https://github.com/" +
      source.project +
      "/commit/" +
      source.sha +
      ").",
    existing
      ? "[Compare the currently listed revision](https://github.com/" +
        source.project +
        "/compare/" +
        submission(existing.url).sha +
        "..." +
        source.sha +
        ")."
      : "",
    "Inspect the package code, dependencies, permissions, network access and artwork license. Verify the listing name and thumbnail. Merge to list this revision, or close to block this revision from the marketplace.",
    issue ? "Closes #" + issue : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const pr = await api(root + "/pulls", {
    method: "POST",
    body: {
      title: "Review Gizmo from " + source.project + " at " + source.sha.slice(0, 12),
      head: branch,
      base,
      body,
    },
  });
  return pr.html_url;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const source = submission(process.env.SOURCE);
  if (process.argv[2] === "identify") {
    await appendFile(process.env.GITHUB_OUTPUT, "key=" + source.key + "\n");
  } else if (process.argv[2] === "propose") {
    const {
      GITHUB_REPOSITORY: repository,
      BASE: base,
      ISSUE: issue,
      GH_TOKEN: token,
    } = process.env;
    if (!repository || !base || !token || (issue && !/^\d+$/u.test(issue)))
      throw new Error("Missing workflow context.");
    const api = github(token);
    const link = await propose({ repository, base, issue, source, api });
    if (issue)
      await api("repos/" + repository + "/issues/" + issue + "/comments", {
        method: "POST",
        body: { body: "Marketplace review for this revision: " + link },
      });
    await appendFile(process.env.GITHUB_STEP_SUMMARY, "Marketplace review: " + link + "\n");
  } else {
    throw new Error("Choose identify or propose.");
  }
}
