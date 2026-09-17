/**
 * Get a creator's recent Instagram posts by handle.
 *
 *     handle -> discoverPostsByProfileURL -> ScrapeJob -> full post records
 *
 * No second collection step. Discovery returns the complete record: 34 fields
 * on 2026-09-16, the same count the Python twin sees. Collecting each post
 * afterwards would cost another credit per post and add minutes.
 *
 * Discovery is always asynchronous in this SDK: the call returns a ScrapeJob
 * and `toResult` polls until the snapshot is ready.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { bdclient } from "@brightdata/sdk";

/**
 * An empty date window comes back as an error row, not an empty list. Match on
 * the message: a dead page carries the same shape.
 */
export const EMPTY_WINDOW =
  "There are no public posts in the profile for the specified period";

/** The SDK polls in milliseconds and gives up at 600000 by default. */
export const POLL_TIMEOUT_MS = 600_000;
export const POLL_INTERVAL_MS = 5_000;

const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

/**
 * The SDK constructor, behind one indirection.
 *
 * ES module exports are read-only bindings, so a test cannot replace an
 * imported class the way Python's monkeypatch replaces a module attribute.
 * Going through this object lets the offline tests pin the options the real
 * call site passes, without a loader hook.
 */
export const sdk = { bdclient };

/** Accept nasa, @nasa, or a profile URL. Reject anything else. */
export function cleanHandle(handle) {
  let cleaned = String(handle ?? "").trim().replace(/\/+$/, "").replace(/^@/, "");
  if (cleaned.includes("instagram.com/")) {
    cleaned = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  }
  if (!HANDLE.test(cleaned)) {
    throw new Error(`${JSON.stringify(String(handle))} is not an Instagram handle`);
  }
  return cleaned;
}

export function profileUrl(handle) {
  return `https://www.instagram.com/${cleanHandle(handle)}/`;
}

/** Flatten a ScrapeResult, or an array of them, into plain objects. */
export function rows(result) {
  if (Array.isArray(result)) return result.flatMap(rows);
  let data = result && typeof result === "object" && "data" in result ? result.data : result;
  if (data && typeof data === "object" && !Array.isArray(data)) data = [data];
  if (!Array.isArray(data)) return [];
  return data.filter((row) => row && typeof row === "object" && !Array.isArray(row));
}

/**
 * A failed or timed out request carries no rows to explain itself.
 *
 * Without this check the run prints "0 posts", which reads like a creator with
 * nothing recent rather than a request that never came back.
 */
export function envelopeError(result) {
  if (!result || result.success !== false) return null;
  return String(result.error ?? result.status ?? "request failed");
}

/** Sort rows into records, empty-window notes, and real errors. */
export function split(result) {
  const records = [];
  const notes = [];
  const errors = [];
  for (const row of rows(result)) {
    const error = row.error;
    if (!error) records.push(row);
    else if (String(error).includes(EMPTY_WINDOW)) {
      notes.push("the account has no public posts in the period searched");
    } else errors.push(String(error));
  }
  return { records, notes, errors };
}

/** What happened to one handle. */
export class Outcome {
  constructor({ handle, posts = [], error = null, note = "" }) {
    this.handle = handle;
    this.posts = posts;
    this.error = error;
    this.note = note;
  }

  get ok() {
    return this.error === null;
  }

  /** One line a reader can understand without having read the source. */
  line() {
    if (!this.ok) return `failed  @${this.handle}: ${this.error}`;
    const tail = this.note ? `, ${this.note}` : "";
    return `got     @${this.handle}: ${this.posts.length} posts${tail}`;
  }
}

/** Fetch one handle. Never throws: a failure becomes an Outcome. */
export async function scrapeHandle(client, handle, limit = 5) {
  let name;
  try {
    name = cleanHandle(handle);
  } catch (error) {
    return new Outcome({ handle: String(handle), error: error.message });
  }

  const outcome = new Outcome({ handle: name });
  try {
    // includeErrors is off unless asked for, and the orchestrated posts() helper
    // cannot pass it at all, so discovery plus toResult is the only path that
    // reports a dead account instead of silently returning nothing.
    const job = await client.scrape.instagram.discoverPostsByProfileURL(
      [{ url: profileUrl(name), num_of_posts: limit }],
      { includeErrors: true },
    );
    const result = await job.toResult({
      pollInterval: POLL_INTERVAL_MS,
      pollTimeout: POLL_TIMEOUT_MS,
    });
    const failed = envelopeError(result);
    if (failed) {
      outcome.error = failed;
      return outcome;
    }
    const { records, notes, errors } = split(result);
    outcome.note = [...new Set(notes)].join("; ");
    if (errors.length) outcome.error = errors.join("; ");
    else outcome.posts = records;
  } catch (error) {
    // one bad handle must not end the run
    outcome.error = `${error?.constructor?.name ?? "Error"}: ${error?.message ?? error}`;
  }
  return outcome;
}

/**
 * Run `fn` with the client passed in, or with one we open and own.
 *
 * A client we opened holds an undici pool, so the process would not exit until
 * it is closed. A client the caller passed is theirs to close.
 */
export async function withClient(client, fn) {
  if (client) return fn(client);
  // autoCreateZones defaults to true: the SDK creates Web Unlocker and SERP
  // zones on the first request, which this scraper never uses. Creating a zone
  // needs a payment method, so leaving it on breaks the first run for free
  // accounts.
  const owned = new sdk.bdclient({ autoCreateZones: false });
  try {
    return await fn(owned);
  } finally {
    await owned.close();
  }
}

/** Run every handle and return one Outcome each, in order. */
export async function scrape(handles, { limit = 5, client = null } = {}) {
  return withClient(client, async (opened) => {
    const outcomes = [];
    for (const handle of handles) {
      outcomes.push(await scrapeHandle(opened, handle, limit));
    }
    return outcomes;
  });
}

/** Write one JSON file: when it ran, and the posts found per handle. */
export async function write(outcomes, path) {
  const document = {
    generated_at: new Date().toISOString(),
    handles: outcomes.map((o) => ({ handle: o.handle, posts: o.posts })),
  };
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return target;
}
