/** These run without a token. The client is a stub. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

import { EMPTY_WINDOW, cleanHandle, scrape, sdk, write } from "../src/scrape.js";
import { main } from "../src/cli.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

let temp;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "igscraper-"));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});

/** A client whose one Instagram call returns canned rows. */
function stub(discovery, { capture } = {}) {
  const discoverPostsByProfileURL = async (input, options) => {
    if (capture) capture.push({ input, options });
    if (discovery instanceof Error) throw discovery;
    return { toResult: async () => ({ success: true, status: "ready", data: discovery }) };
  };
  return { scrape: { instagram: { discoverPostsByProfileURL } } };
}

/** A client whose request comes back as a failed envelope, with no rows. */
function envelope(fields) {
  return {
    scrape: {
      instagram: {
        discoverPostsByProfileURL: async () => ({ toResult: async () => fields }),
      },
    },
  };
}

/** Swap the SDK constructor for the body of one test, then put it back. */
async function withFakeSdk(Fake, body) {
  const real = sdk.bdclient;
  sdk.bdclient = Fake;
  try {
    return await body();
  } finally {
    sdk.bdclient = real;
  }
}

describe("handles", () => {
  test("a handle, an at sign, or a URL all name the same account", () => {
    assert.equal(cleanHandle("nasa"), "nasa");
    assert.equal(cleanHandle("@nasa"), "nasa");
    assert.equal(cleanHandle("https://www.instagram.com/nasa/"), "nasa");
    assert.throws(() => cleanHandle("not a handle"), /is not an Instagram handle/);
  });
});

describe("what the API answers", () => {
  test("an empty window is zero records, not a failure", async () => {
    const row = { error: EMPTY_WINDOW, error_code: "dead_page", input: { url: "x" } };
    const [outcome] = await scrape(["nasa"], { client: stub([row]) });

    assert.ok(outcome.ok);
    assert.deepEqual(outcome.posts, []);
    assert.equal(outcome.note, "the account has no public posts in the period searched");
    assert.equal(outcome.line(), "got     @nasa: 0 posts, the account has no public posts in the period searched");
  });

  test("any other error row fails the handle", async () => {
    const row = { error: "Page not found", error_code: "dead_page" };
    const [outcome] = await scrape(["nasa"], { client: stub([row]) });

    assert.ok(!outcome.ok);
    assert.equal(outcome.line(), "failed  @nasa: Page not found");
  });

  test("a timed out request is a failure, not an empty creator", async () => {
    const client = envelope({ success: false, data: null, error: null, status: "timeout" });
    const [outcome] = await scrape(["nasa"], { client });

    assert.equal(outcome.line(), "failed  @nasa: timeout");
  });

  test("one bad handle does not end the run", async () => {
    const [first, second] = await scrape(["nasa", "not a handle"], {
      client: stub(new RangeError("boom")),
    });

    assert.equal(first.error, "RangeError: boom");
    assert.ok(!second.ok);
    assert.deepEqual([first.handle, second.handle], ["nasa", "not a handle"]);
  });

  test("error rows are asked for, because the SDK does not send include_errors by default", async () => {
    const capture = [];
    await scrape(["nasa"], { limit: 3, client: stub([], { capture }) });

    assert.deepEqual(capture[0].options, { includeErrors: true });
    assert.deepEqual(capture[0].input, [
      { url: "https://www.instagram.com/nasa/", num_of_posts: 3 },
    ]);
  });
});

describe("writing the file", () => {
  test("a run writes what it found", async () => {
    const posts = [{ url: "https://www.instagram.com/p/AAA/", likes: 12, user_posted: "nasa" }];
    const outcomes = await scrape(["@nasa"], { limit: 1, client: stub(posts) });

    assert.equal(outcomes[0].line(), "got     @nasa: 1 posts");

    const path = await write(outcomes, join(temp, "out.json"));
    const document = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(document.handles, [{ handle: "nasa", posts }]);
    assert.ok(document.generated_at);
  });
});

describe("the client we own", () => {
  test("a client we opened is always closed", async () => {
    const calls = [];
    class Fake {
      constructor() {
        calls.push("new");
        Object.assign(this, stub([]));
      }
      async close() {
        calls.push("close");
      }
    }
    await withFakeSdk(Fake, async () => {
      const [outcome] = await scrape(["nasa"]);
      assert.ok(outcome.ok);
    });
    assert.deepEqual(calls, ["new", "close"]);
  });

  test("we do not ask the SDK to create zones", async () => {
    let seen;
    class Fake {
      constructor(options) {
        seen = options;
        Object.assign(this, stub([]));
      }
      async close() {}
    }
    await withFakeSdk(Fake, () => scrape(["nasa"]));
    assert.equal(seen.autoCreateZones, false);
  });
});

describe("the command", () => {
  /** Point the CLI at a client that never exists and a handler we control. */
  async function fakeCli(outcomeFor, argv) {
    class Fake {
      constructor() {
        Object.assign(this, {
          scrape: {
            instagram: {
              discoverPostsByProfileURL: async (input) => ({
                toResult: async () => ({
                  success: true,
                  status: "ready",
                  data: outcomeFor(input[0].url),
                }),
              }),
            },
          },
        });
      }
      async close() {}
    }
    return withFakeSdk(Fake, () => main(argv));
  }

  test("the exit code says whether every handle worked", async () => {
    const ok = await fakeCli(() => [{ url: "x" }], ["nasa", "--out", join(temp, "ok.json")]);
    assert.equal(ok, 0);

    const bad = await fakeCli(() => [{ error: "boom" }], ["nasa", "--out", join(temp, "bad.json")]);
    assert.equal(bad, 1);
  });

  test("each result prints before the next handle starts", async () => {
    const written = [];
    const real = process.stdout.write;
    process.stdout.write = (chunk) => (written.push(String(chunk)), true);
    try {
      await fakeCli(() => [{ url: "x" }], ["nasa", "natgeo", "--out", join(temp, "o.json")]);
    } finally {
      process.stdout.write = real;
    }
    // Split each chunk on its own: the test runner writes its own binary
    // protocol to stdout, and joining first would glue it onto a real line.
    const lines = written.flatMap((chunk) => chunk.split("\n")).filter((l) => /^(asking|got)/.test(l));
    assert.deepEqual(lines, [
      "asking  @nasa...",
      "got     @nasa: 1 posts",
      "asking  @natgeo...",
      "got     @natgeo: 1 posts",
    ]);
  });

  test("a limit below one is refused before any request", async () => {
    const written = [];
    const real = process.stderr.write;
    process.stderr.write = (chunk) => (written.push(String(chunk)), true);
    try {
      for (const bad of ["0", "-3", "1.5"]) {
        assert.equal(await main(["nasa", "--limit", bad]), 2);
      }
    } finally {
      process.stderr.write = real;
    }
    assert.match(written.join(""), /1 or more/);
  });

  test("a missing token is a message, not a stack trace", async () => {
    const written = [];
    const real = process.stderr.write;
    process.stderr.write = (chunk) => (written.push(String(chunk)), true);
    const { AuthenticationError } = await import("@brightdata/sdk");
    class Fake {
      constructor() {
        throw new AuthenticationError("No API token found. Run `npx @brightdata/cli login`");
      }
    }
    let code;
    try {
      code = await withFakeSdk(Fake, () => main(["nasa"]));
    } finally {
      process.stderr.write = real;
    }
    const err = written.join("");
    assert.equal(code, 2);
    assert.match(err, /export BRIGHTDATA_API_TOKEN/);
    assert.match(err, /bdata login/);
    assert.doesNotMatch(err, /apiKey option/, "the SDK's JavaScript-only advice leaked into the CLI");
  });

  test("piped output keeps the header before the error", async () => {
    // A log or an agent reads a pipe. The header must not land after the error.
    const env = { ...process.env, HOME: temp, PATH: process.env.PATH };
    delete env.BRIGHTDATA_API_TOKEN;
    delete env.BRIGHTDATA_API_KEY;
    let stdout = "";
    let code = 0;
    try {
      const done = await run(process.execPath, [join(ROOT, "src/cli.js"), "nasa"], {
        cwd: temp,
        env,
        timeout: 60_000,
      });
      stdout = done.stdout + done.stderr;
    } catch (error) {
      code = error.code;
      stdout = `${error.stdout}${error.stderr}`;
    }
    assert.equal(code, 2, stdout);
    assert.ok(
      stdout.indexOf("Fetching up to") < stdout.indexOf("API token required"),
      `header landed after the error:\n${stdout}`,
    );
  });
});

describe("the SDK contract the README relies on", () => {
  test("every method the README names exists, and takes what it says", async () => {
    const { bdclient } = await import("@brightdata/sdk");
    const { InstagramAPI } = await import(
      "@brightdata/sdk/dist/esm/api/scrape/instagram.mjs"
    ).catch(async () => ({
      InstagramAPI: (await import(join(ROOT, "node_modules/@brightdata/sdk/dist/esm/api/scrape/instagram.mjs"))).InstagramAPI,
    }));

    for (const name of [
      "collectProfiles",
      "collectPosts",
      "collectReels",
      "collectComments",
      "discoverPostsByProfileURL",
      "discoverReelsByProfileURL",
      "discoverAllReelsByProfileURL",
      "profiles",
      "posts",
      "reels",
      "comments",
    ]) {
      assert.equal(typeof InstagramAPI.prototype[name], "function", name);
    }

    // Instagram lives under scrape, never under search: client.search is SERP only.
    assert.equal(typeof bdclient.prototype.scrapeUrl, "function");
    const { SearchRouter } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/api/search/router.mjs")
    );
    assert.equal(SearchRouter.prototype.instagram, undefined);
    for (const engine of ["google", "bing", "yandex"]) {
      assert.equal(typeof SearchRouter.prototype[engine], "function", engine);
    }
  });

  test("post_type accepts only the two values the README documents", async () => {
    const { InstagramDiscoverPostsByProfileURLFilterSchema: schema } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/schemas/filters/instagram.mjs")
    );
    const url = "https://www.instagram.com/nasa/";
    // The Python SDK's working values are rejected here, before any request.
    for (const rejected of ["Post", "Reels", "Reel"]) {
      assert.equal(schema.safeParse({ url, post_type: rejected }).success, false, rejected);
    }
    for (const accepted of ["post", "reel"]) {
      assert.equal(schema.safeParse({ url, post_type: accepted }).success, true, accepted);
    }
  });

  test("polling is measured in milliseconds, so a timeout is not off by a thousand", async () => {
    const { pollUntilReady } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/utils/polling.mjs")
    );
    const started = Date.now();
    await assert.rejects(
      () => pollUntilReady("sd_x", async () => ({ status: "running" }), {
        pollInterval: 10,
        pollTimeout: 60,
      }),
      /timeout|timed out/i,
    );
    assert.ok(Date.now() - started < 5_000, "a 60 ms timeout waited for seconds");
  });
});

describe("the README", () => {
  test("the excerpt is the start of the example file", async () => {
    const sample = await readFile(join(ROOT, "examples/sample_output.json"), "utf8");
    const readme = await readFile(join(ROOT, "README.md"), "utf8");

    assert.ok(
      readme.includes(sample.split("\n").slice(0, 19).join("\n")),
      "README excerpt drifted from the file",
    );
    assert.ok(readme.includes("](examples/sample_output.json)"));
  });

  test("every in-page link has its heading", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const anchors = new Set(
      [...readme.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
        heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"),
      ),
    );
    for (const [, anchor] of readme.matchAll(/\]\(#([^)]+)\)/g)) {
      assert.ok(anchors.has(anchor), `#${anchor} points at no heading`);
    }
  });
});
