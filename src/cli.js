#!/usr/bin/env node
/** instagram-scraper nasa natgeo */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { BRDError } from "@brightdata/sdk";

import { scrapeHandle, withClient, write } from "./scrape.js";

/** The SDK's own advice names a JavaScript option. A command has no such thing. */
const NO_TOKEN = [
  "API token required but not found.",
  "  export BRIGHTDATA_API_TOKEN=YOUR_API_KEY   token: https://brightdata.com/cp/setting/users",
  "  or run once: npx -p @brightdata/cli bdata login",
].join("\n");

const USAGE = `usage: instagram-scraper HANDLE [HANDLE ...] [--limit N] [--out PATH]

  --limit N    posts per account, default 5, minimum 1
  --out PATH   output file, default instagram.json`;

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const CLEAR_LINE = "\r[2K";

/** Seconds as h:mm:ss, the shape a reader can read at a glance. */
function clock(seconds) {
  const mm = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${Math.floor(seconds / 3600)}:${mm}:${ss}`;
}

/**
 * A spinner and a running clock, so a minute of waiting looks alive.
 * Outside a terminal it prints one plain line instead, because a log wants a
 * line, not an animation.
 */
function waiting(label) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`asking  ${label}...\n`);
    return () => {};
  }
  const started = Date.now();
  let frame = 0;
  const tick = () => {
    const spin = FRAMES[frame++ % FRAMES.length];
    process.stdout.write(`${CLEAR_LINE}${spin} ${label} ${clock(Math.floor((Date.now() - started) / 1000))}`);
  };
  tick();
  const timer = setInterval(tick, 100);
  timer.unref();
  return () => {
    clearInterval(timer);
    process.stdout.write(CLEAR_LINE); // leave the line clean for the result
  };
}

/** Reject a limit the API would charge for and not honour. */
function positive(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${value} is not 1 or more`);
  }
  return number;
}

export async function main(argv = process.argv.slice(2)) {
  let handles;
  let limit;
  let out;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { limit: { type: "string" }, out: { type: "string" } },
      allowPositionals: true,
    });
    handles = positionals;
    limit = values.limit === undefined ? 5 : positive(values.limit);
    out = values.out ?? "instagram.json";
    if (!handles.length) throw new Error("give at least one handle");
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  process.stdout.write(
    `Fetching up to ${limit} recent posts per account, for: ${handles.join(", ")}\n` +
      "Usually one to three minutes each. One credit per post, 5,000 free per month.\n",
  );

  const outcomes = [];
  try {
    await withClient(null, async (client) => {
      for (const handle of handles) {
        const done = waiting(`@${handle}`);
        const outcome = await scrapeHandle(client, handle, limit);
        done();
        process.stdout.write(`${outcome.line()}\n`);
        outcomes.push(outcome);
      }
    });
  } catch (error) {
    // Almost always a missing token, which reads as a crash under a stack trace.
    if (!(error instanceof BRDError)) throw error;
    const message = String(error?.message ?? error);
    process.stderr.write(`${/token/i.test(message) ? NO_TOKEN : message}\n`);
    return 2;
  }

  const path = await write(outcomes, out);
  const posts = outcomes.flatMap((outcome) => outcome.posts);
  const fields = posts.length ? ` (${Object.keys(posts[0]).length} fields per post)` : "";
  process.stdout.write(`\nSaved ${posts.length} posts as JSON to ${path}${fields}\n`);
  return outcomes.every((outcome) => outcome.ok) ? 0 : 1;
}

/**
 * Is this file the program being run?
 *
 * Comparing `import.meta.url` to `file://${argv[1]}` is wrong twice over. A
 * path with a space encodes to %20 on one side only, and `npm install -g`
 * puts a symlink on PATH, so argv[1] is the link while import.meta.url is the
 * file it points at. Either mismatch makes the installed command exit 0 and
 * do nothing at all.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
