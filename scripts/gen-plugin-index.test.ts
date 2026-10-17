import { test, expect } from "bun:test";
import { buildQueryUrl, headersFor, pluginIndexJson, reposToPluginIndex, type GitHubRepo } from "./gen-plugin-index";

test("reposToPluginIndex maps shape and validates urls", () => {
  const repos: GitHubRepo[] = [
    {
      full_name: "wiggly-sheets/tfm-example",
      description: "an example",
      html_url: "https://github.com/wiggly-sheets/tfm-example",
      default_branch: "main",
    },
    {
      full_name: "wiggly-sheets/tfm-empty",
      description: null,
      html_url: "https://github.com/wiggly-sheets/tfm-empty",
      default_branch: "dev",
    },
    // malformed full_name -> skipped
    { full_name: "no-slash", description: "x", html_url: "https://github.com/no-slash", default_branch: "main" },
  ];
  const idx = reposToPluginIndex(repos);
  expect(idx).toHaveLength(2);
  expect(idx[0]).toEqual({
    id: "tfm-example",
    name: "wiggly-sheets/tfm-example",
    description: "an example",
    url: "https://github.com/wiggly-sheets/tfm-example.git",
    ref: "main",
  });
  expect(idx[1]?.description).toBe("");
  expect(idx[1]?.ref).toBe("dev");
});

test("pluginIndexJson is stable JSON with trailing newline", () => {
  const json = pluginIndexJson([
    { id: "a", name: "a", description: "", url: "https://github.com/wiggly-sheets/a.git" },
  ]);
  expect(json).toBe(
    '{\n  "plugins": [\n    {\n      "id": "a",\n      "name": "a",\n      "description": "",\n      "url": "https://github.com/wiggly-sheets/a.git"\n    }\n  ]\n}\n',
  );
});

test("buildQueryUrl encodes the filter", () => {
  const u = new URL(buildQueryUrl(50, 2));
  expect(u.searchParams.get("q")).toBe("topic:tfm-plugin org:wiggly-sheets");
  expect(u.searchParams.get("per_page")).toBe("50");
  expect(u.searchParams.get("page")).toBe("2");
});

test("headersFor omits auth when no token", () => {
  const h = headersFor(undefined);
  expect(h.Authorization).toBeUndefined();
  expect(h.Accept).toBe("application/vnd.github+json");
});

test("headersFor sets bearer token when present", () => {
  const h = headersFor("tok");
  expect(h.Authorization).toBe("Bearer tok");
  expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
});
