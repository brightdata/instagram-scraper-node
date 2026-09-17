# For coding agents working in this repository

Read this before changing anything. Every line below was verified against the
live API or the installed SDK on 2026-09-16, and some of it contradicts the
SDK's own JSDoc.

## Auth

- The SDK reads `apiKey`, then `BRIGHTDATA_API_TOKEN` or `BRIGHTDATA_API_KEY`
  from the environment, then the credentials `bdata login` stored. Setting the
  variable, or running the login once, is the one step a human must do; never
  paste a key into code.
- The JavaScript SDK does not read a `.env` file. It has no dotenv dependency
  and reads `process.env` only. Node 20 loads one for it: `node --env-file=.env`.
- Always construct the client as `new bdclient({ autoCreateZones: false })`.
  Left on, the SDK creates Web Unlocker and SERP zones on the first request.
  This repository never uses a zone, and zone creation fails on accounts
  without a payment method.
- The class JSDoc shows `api_token` and `auto_create_zones`. Those are the
  Python names. The schema this SDK validates against is camelCase, and a
  snake_case key is dropped in silence.

## How the API behaves

- Every call is an asynchronous job: trigger, poll, fetch. Expect one to three
  minutes per account. There is no synchronous path worth using here.
- Instagram lives on `client.scrape.instagram`. `client.search` is SERP only,
  with `google`, `bing` and `yandex`. There is no discovery by username: the
  Python SDK's `search.instagram.profiles("nasa")` has no twin here.
- `discoverPostsByProfileURL` always returns a `ScrapeJob`, never records. It
  forces `async: true` internally. Call `job.toResult()` to poll and fetch.
- Pass `{ includeErrors: true }` on every discover and collect call. Unset, the
  SDK omits `include_errors` and the API default is off, so a dead account
  comes back as zero rows and reads like an account with nothing recent.
  The orchestrated helpers (`posts`, `profiles`, `reels`, `comments`) cannot
  carry it: `orchestrate()` forwards only `format` and the poll options.
- Poll options are milliseconds, not seconds. `pollTimeout` defaults to
  600000. A value copied from the Python twin's `timeout=420` would be 420 ms.
- Many URLs in one call is one job. Prefer that over a loop. For large runs
  keep the `snapshotId` and fetch later; snapshots stay downloadable 30 days.
- One credit per record. Comments cost one per comment;
  `discoverAllReelsByProfileURL` costs one per reel the account has ever
  posted. 5,000 credits are free each month.
- `post_type` has no value that works from this SDK. The zod filter is a strict
  enum of `"post"` and `"reel"`, so the Python twin's working `"Post"` and
  `"Reels"` are rejected before the request. Of the two it does accept,
  `"reel"` returned one error row, "Unable to discover older posts", and
  `"post"` never returned at all in two runs, at 482 s and 903 s. Leave
  `post_type` out. Tracked in [sdk-js#34](https://github.com/brightdata/sdk-js/issues/34).
- A dead account comes back as a row with an `error` key. The text varies;
  "Crawler error: Cannot read properties of null (reading 'pk')" is one.
  Match the message, not a code.
- An empty date window came back as zero rows and `success: true`, not as the
  error row the Python twin documents. `EMPTY_WINDOW` in `src/scrape.js` still
  handles that row, because the API can send it and the Python twin sees it.
- The schema changes without notice. Never hardcode a field list. Read it with
  `client.datasets.instagramPosts.getMetadata()`. It returns `{ id, fields }`,
  and `fields` is an object keyed by field name, 44 of them on 2026-09-16. The
  SDK's own types declare `fields: DatasetField[]`, an array, which is wrong:
  iterating it as one yields nothing. Tracked in
  [sdk-js#35](https://github.com/brightdata/sdk-js/issues/35).
- The full documentation index, one `.md` page per entry:
  https://docs.brightdata.com/llms.txt

## Working here

- `npm test` runs offline and needs no token. `npm run lint` must pass.
- CI installs from the README's own commands on an empty machine. A weekly
  workflow executes every fenced block in the README against the real API, and
  a daily one runs a smaller live check.
  A snippet must be complete and paste-able on its own, and its shown output
  must be real.
- The field table in the README sits between `<!-- fields:start -->` and
  `<!-- fields:end -->` and is regenerated daily. Do not edit it by hand.
- The "last verified" badge line at the top of the README is rewritten by the
  daily run. Do not edit it by hand.
- Keep it small: 14 files and about 320 lines of JavaScript in `src/`. Do not
  add retries, deduplication, scheduling, databases or concurrency.

## The API stalls in waves

On 2026-09-16 the API went through stretches of roughly an hour where most
discovery jobs sat until the poll deadline, 605 s, and came back with
`status: "timeout"` and no rows. Between those stretches the same calls
finished in 62 s to 200 s.

Load does not explain it. Four jobs launched together all passed during a good
stretch. Two jobs running on their own, one after the other, both stalled
during a bad one. Whatever causes it is on the API side and is not established
here.

What follows from it:

- A red live check whose only symptom is timeouts is probably a bad wave.
  Rerun it before looking for a code change.
- `live.yml` retries once on a timeout, and caps the README matrix at
  `max-parallel: 3`. The cap is not a fix. It limits how much of the matrix one
  bad wave can take down.
- Do not raise `POLL_TIMEOUT_MS` to chase this. A stalled snapshot did not
  finish at 900 s either.
