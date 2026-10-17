// Generate docs/plugins.json: the curated catalog that `tfm plugins search/add
// <id>` reads from the project Pages site (PLUGIN_INDEX_URL in
// src/plugins/plugin-install.ts, consumed by src/app/plugins-cli.ts and the
// Plugins view).
//
// It enumerates public repos in THIS org tagged `tfm-plugin` via the GitHub
// search/repositories API, maps the search shape onto the consumer's entry
// schema, and writes the file. The GitHub API tolerates an unauthenticated call
// but rate-limits fast; set GITHUB_TOKEN for the higher authenticated limit when
// generating from CI.
//
// Run: bun scripts/gen-plugin-index.ts
import { atomicWriteFile } from "../src/fs/fsutil.ts";
import { parseGitUrl } from "../src/plugins/plugin-install.ts";

// Shape of one GitHub search/repositories item this script uses.
export type GitHubRepo = {
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
};

export type PluginIndexEntry = {
  id: string;
  name: string;
  description: string;
  url: string;
  ref?: string;
};

// org/repo -> plugin id (repo name) + a git URL anchored at the default branch.
// parseGitUrl is reused so a hand-written/malformed repo name is rejected the
// same way `tfm plugins add` would reject a bad index entry.
export const reposToPluginIndex = (repos: GitHubRepo[]): PluginIndexEntry[] => {
  const out: PluginIndexEntry[] = [];
  for (const repo of repos) {
    const parts = repo.full_name.split("/");
    if (parts.length !== 2 || !parts[1]) continue;
    const id = parts[1];
    const name = repo.full_name;
    const url = `${repo.html_url}.git`;
    try {
      parseGitUrl(url);
    } catch {
      continue;
    }
    out.push({ id, name, description: repo.description ?? "", url, ref: repo.default_branch || undefined });
  }
  return out;
};

export const pluginIndexJson = (entries: PluginIndexEntry[]): string =>
  JSON.stringify({ plugins: entries }, null, 2).concat("\n");

const GH_API = "https://api.github.com/search/repositories";
export const buildQueryUrl = (perPage = 100, page = 1): string =>
  `${GH_API}?q=${encodeURIComponent("topic:tfm-plugin org:wiggly-sheets")}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;

export const headersFor = (token?: string): Record<string, string> =>
  token
    ? { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github+json" }
    : { Accept: "application/vnd.github+json" };

export const fetchPluginRepos = async (token?: string): Promise<GitHubRepo[]> => {
  const items: GitHubRepo[] = [];
  let page = 1;
  while (page <= 3) {
    const res = await fetch(buildQueryUrl(100, page), { headers: headersFor(token) });
    if (!res.ok) throw new Error(`GitHub search failed: ${res.status}`);
    const body = (await res.json()) as { items?: unknown };
    const list = Array.isArray(body.items) ? body.items : [];
    if (!list.length) break;
    items.push(...(list as GitHubRepo[]));
    page++;
  }
  return items;
};

const main = async (): Promise<void> => {
  const entries = reposToPluginIndex(await fetchPluginRepos(process.env.GITHUB_TOKEN));
  const out = new URL("../docs/plugins.json", import.meta.url).pathname;
  await atomicWriteFile(out, pluginIndexJson(entries));
  console.log(`wrote ${entries.length} plugin entries to docs/plugins.json`);
};

// run only when invoked directly, not when imported by tests (tests must never
// hit the network). regen-example.ts runs inline by design; this one is guarded
// because it performs network IO.
if (import.meta.main) void main();
