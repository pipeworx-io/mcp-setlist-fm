interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * setlist.fm MCP.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'setlist.fm');
}

const BASE = 'https://api.setlist.fm/rest/1.0';
const UA = 'pipeworx-mcp-setlist-fm/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  { name: 'artist', description: 'Fetch a setlist.fm artist record by band name or MusicBrainz ID. Pass `artist_name` ("Radiohead") and the name is resolved to the MBID for you, preferring an exact match so a tribute act does not answer for the band; pass `mbid` directly when you already have one. Returns artist name, MBID, Ticketmaster ID, sort name, and disambiguation info.', inputSchema: { type: 'object', properties: { artist_name: { type: 'string', description: 'Band or performer name, e.g. "Radiohead". Either this or mbid is required.' }, mbid: { type: 'string', description: 'MusicBrainz ID, e.g. "a74b1b7f-71a5-4011-9441-d0b5e4122711". Either this or artist_name is required.' } } } },
  {
    name: 'artist_search',
    description: 'Search setlist.fm for artists by name, MusicBrainz ID, or Ticketmaster ID. Returns a paginated list of matching artist records with name, MBID, and sort name.',
    inputSchema: { type: 'object', properties: { artistMbid: { type: 'string' }, artistName: { type: 'string' }, artistTmid: { type: 'number' }, sort: { type: 'string' }, p: { type: 'number' } } },
  },
  { name: 'artist_setlists', description: "A band's concert history, newest first — use this for \"what did Radiohead play at their most recent show\". Pass `artist_name` and the band is resolved to its MusicBrainz ID for you, preferring an exact name match so a tribute act does not answer for the band; pass `mbid` directly when you have one. Returns setlists with date, venue, city, and full track lists.", inputSchema: { type: 'object', properties: { artist_name: { type: 'string', description: 'Band or performer name, e.g. "Radiohead". Either this or mbid is required.' }, mbid: { type: 'string', description: 'MusicBrainz ID. Either this or artist_name is required.' }, p: { type: 'number', description: 'Page number, 1-based. Page 1 is the most recent concerts.' } } } },
  { name: 'venue', description: 'Fetch a setlist.fm venue record by venue `id`. Returns venue name, city, country, coordinates, and URL.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  {
    name: 'venue_search',
    description: 'Search setlist.fm for venues by name, city, country, or state. Returns a paginated list of matching venues with name, city, and country.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Venue name, e.g. "Fillmore". At least one criterion is required.' }, cityId: { type: 'string' }, cityName: { type: 'string' }, country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code — "US", not "United States". Call `countries` for the full list.' }, state: { type: 'string' }, stateCode: { type: 'string' }, p: { type: 'number' } } },
  },
  { name: 'venue_setlists', description: 'Fetch paginated setlists performed at a specific venue by venue `id`. Returns setlists with date, artist, and track lists.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, p: { type: 'number' } }, required: ['id'] } },
  { name: 'setlist', description: 'Fetch a single setlist by its setlist.fm `setlist_id`. Returns artist, event date, venue, city, and the full ordered track list with song names.', inputSchema: { type: 'object', properties: { setlist_id: { type: 'string' } }, required: ['setlist_id'] } },
  {
    name: 'setlist_search',
    description: 'Search setlist.fm setlists by artist name/MBID, date, year, city, country, state, tour name, or venue. Returns paginated matching setlists with artist, venue, date, and tracks.',
    inputSchema: {
      type: 'object',
      properties: {
        artistMbid: { type: 'string' },
        artistName: { type: 'string' },
        year: { type: 'number' },
        date: { type: 'string', description: 'Exact concert date in dd-MM-yyyy — "06-06-1983", NOT ISO 8601. setlist.fm rejects "1983-06-06" outright.' },
        cityId: { type: 'string' },
        cityName: { type: 'string' },
        country: { type: 'string' },
        state: { type: 'string' },
        stateCode: { type: 'string' },
        tourName: { type: 'string' },
        venueId: { type: 'string' },
        venueName: { type: 'string' },
        p: { type: 'number' },
      },
    },
  },
  { name: 'user', description: 'Fetch a setlist.fm user profile by `user_id`. Returns username, fullname, about text, website, and statistics on attended concerts.', inputSchema: { type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'] } },
  { name: 'user_attended', description: "Fetch paginated list of concerts a setlist.fm user has marked as attended, by `user_id`. Returns setlists with date, artist, venue, and track list.", inputSchema: { type: 'object', properties: { user_id: { type: 'string' }, p: { type: 'number' } }, required: ['user_id'] } },
  { name: 'cities', description: 'Search setlist.fm for cities by name or country. Returns city name, state, country, and geolocation coordinates. Useful for resolving city identifiers before searching setlists or venues.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'City name, e.g. "Berlin". At least one of name/country is required.' }, country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code — "DE", not "Germany". Call `countries` for the full list.' }, p: { type: 'number' } } } },
  { name: 'countries', description: 'Return the full list of countries recognized by setlist.fm (ISO country codes and names). Use to look up valid country codes before filtering setlist or venue searches.', inputSchema: { type: 'object', properties: {} } },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  /**
   * setlist.fm's artist search is substring-based, so tribute acts outrank the
   * band. "What songs did Radiohead play at their most recent concert?" returned
   * setlists for "An Evening of Radiohead" — a cover band — and the answer
   * correctly reported it had nothing for Radiohead itself. The data was there;
   * the wrong artist was in front of it.
   *
   * When an EXACT name match exists in the page, keep only those and say so.
   * When it doesn't, leave the results untouched — a caller searching a partial
   * name still wants the fuzzy hits, and silently emptying the list would be a
   * worse failure than the one being fixed.
   */
  const preferExactArtist = (
    data: { setlist?: { artist?: { name?: string } }[] },
    wanted: unknown,
  ) => {
    if (typeof wanted !== 'string' || !wanted.trim() || !Array.isArray(data?.setlist)) return data;
    const norm = (s: string) => s.normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const target = norm(wanted);
    const exact = data.setlist.filter((s) => norm(s?.artist?.name ?? '') === target);
    // `exact.length === data.setlist.length` means the page is ALREADY all the
    // real band — nothing to trim, so the payload is returned untouched. It
    // must still be flagged as an exact match: the caller below decides whether
    // to run the artist-resolution fallback off that flag, and without it the
    // BEST case (a clean page) triggered two extra upstream calls to re-resolve
    // an artist we had already found. On a shared 1440/hour key that made the
    // happy path the most expensive one (fleet #29).
    if (exact.length && exact.length === data.setlist.length) {
      return { ...data, matched_artist_exactly: wanted };
    }
    if (!exact.length) return data;
    return {
      ...data,
      setlist: exact,
      matched_artist_exactly: wanted,
      dropped_fuzzy_matches: data.setlist.length - exact.length,
      note: `Kept only setlists whose artist is exactly "${wanted}"; ${data.setlist.length - exact.length} near-name match(es) (tribute/cover acts) were excluded.`,
    };
  };

  /**
   * Attach what a name was resolved to.
   *
   * Returning one band's setlists under another band's name is the failure this
   * pack keeps having, so when a name was resolved the answer has to say which
   * artist actually answered — and say it louder when the match was inexact.
   */
  const withResolution = (data: unknown, a: Record<string, unknown>) => {
    if (!a._resolved_artist || typeof data !== 'object' || data === null || Array.isArray(data)) return data;
    return {
      ...(data as Record<string, unknown>),
      resolved_artist: a._resolved_artist,
      resolved_mbid: a.mbid,
      ...(a._resolution_note ? { resolution_note: a._resolution_note } : {}),
    };
  };

  const apiKey = (args._apiKey as string | undefined)?.trim();
  if (!apiKey) throw new Error('setlist.fm requires an API key: pass your key as the _apiKey argument (free at https://api.setlist.fm/docs/1.0/index.html#registration).');
  // The artist searches key on `artistName`, but callers/ask_pipeworx routing
  // often pass `name`/`query`/`artist` — alias so those resolve instead of
  // 404ing on no valid criteria (the dominant real-traffic error here). Scoped
  // to the artist-search tools so it doesn't clobber `name` on cities/venues.
  if ((name === 'artist_search' || name === 'setlist_search') && !args.artistName) {
    // `artist_name` matters as much as the rest: setlist.fm is camelCase but
    // every other pack in this catalog takes snake_case, so it is the spelling a
    // caller reaches for by habit. Without it the call returns "needs at least
    // one search criterion" — which reads as a malformed question rather than a
    // wrong key name, so the caller rephrases the question instead of the
    // argument.
    const alias = args.name ?? args.query ?? args.artist ?? args.artist_name ?? args.band ?? args.artistname;
    if (typeof alias === 'string' && alias.trim()) args.artistName = alias.trim();
  }
  const reqStr = (k: string, ex: string) => {
    const v = args[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${k}" is missing. Pass a string like ${ex}.`);
    return v;
  };
  // setlist.fm answers a criteria-less search with a bare 404, which reads to a
  // caller exactly like "no results" — so `venue_search` and `cities` passed an
  // argless call straight through and have never recorded a single success in 7d.
  // Name the accepted criteria instead of letting the upstream shrug.
  // The example must come from the CALLER's key set, not a fixed one. This guard
  // was written for venue_search and hardcoded {"name":"Fillmore"}; reusing it for
  // artist_search then told that caller to pass `name`, which artist_search does
  // not accept — so following the error exactly would fail again. A wrong example
  // costs more than no example.
  const reqAnyOf = (keys: string[], example: string) => {
    const ok = keys.some((k) => args[k] != null && String(args[k]).trim() !== '');
    if (!ok) {
      throw new Error(
        `user_error: ${name} needs at least one search criterion — pass any of: ${keys.join(', ')} (e.g. ${example}). A page number on its own is not a search, and setlist.fm answers one with a 404 that looks like an empty result.`,
      );
    }
  };
  // `country` is an ISO 3166-1 alpha-2 code, not a country name: "Germany" 404s
  // where "DE" returns 28 cities. Our own shipped examples used the long form,
  // and our error envelope tells callers to "retry matching one of the example
  // shapes" — so a caller who did exactly as told looped on the wrong answer.
  // Catch it here with a message that says what to send.
  const checkCountry = () => {
    const c = args.country;
    if (typeof c === 'string' && c.trim() && !/^[A-Za-z]{2}$/.test(c.trim())) {
      throw new Error(
        `user_error: country must be an ISO 3166-1 alpha-2 code, not a country name — "${c}" will not match. Use "DE" for Germany, "US" for the United States, "GB" for the United Kingdom. The \`countries\` tool returns the full list.`,
      );
    }
  };
  // setlist.fm takes dates as dd-MM-yyyy and rejects ISO 8601 outright:
  // `date must be in format 03-08-2026, was 1983-06-06`. The schema description
  // already says so in capitals, and a caller sent `1983-06-06` anyway — which is
  // the expected outcome, because ISO is what every other date argument in this
  // catalog takes, and a model reaches for the house style before the footnote.
  // Documenting a format the rest of the world spells differently doesn't hold;
  // accepting both does. Rewrite it rather than teaching it again.
  const normalizeDate = () => {
    const d = args.date;
    if (typeof d !== 'string') return;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
    if (iso) args.date = `${iso[3]}-${iso[2]}-${iso[1]}`;
  };
  const get = async (path: string, params?: Record<string, unknown>) => {
    const p = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) if (k !== '_apiKey' && v != null) p.set(k, String(v));
    // setlist.fm pages are 1-based and it answers p=0 with a hard 400 ("page
    // must be >= 1, was 0") rather than treating it as the first page. Callers
    // reach for 0 constantly — it is the first page in most APIs, and the router
    // sent p:0 on the plainest possible question ("What songs did Radiohead play
    // at their most recent concert?"), which returned that 400 instead of an
    // answer. Normalise here rather than at the seven call sites that pass a
    // page, so no paginated tool in this pack can regress into it again.
    // Deliberately a coercion, not a rejection: 0 has one obvious intent, and a
    // 400 that kills the whole query is a far worse answer than page 1.
    const page = p.get('p');
    if (page != null) {
      const n = Math.trunc(Number(page));
      if (!Number.isFinite(n) || n < 1) p.set('p', '1');
      else p.set('p', String(n));
    }
    const url = `${BASE}${path}${[...p].length ? `?${p}` : ''}`;
    const res = await pwFetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA, 'x-api-key': apiKey, 'Accept-Language': 'en' } });
    if (res.status === 401 || res.status === 403) throw new Error('setlist.fm: invalid API key.');
    // setlist.fm meters per APPLICATION KEY (~2 req/sec, ~1440/hour), and we
    // serve every caller from one platform key, so the hourly budget can be
    // spent by other traffic before this caller arrives. Throwing made that
    // read as our bug; shape it instead, so the caller learns it is upstream
    // and transient. Note the exact-artist fallback below costs TWO extra
    // upstream calls, which is precisely when the budget is tightest.
    if (res.status === 429) {
      throw new Error(
        // `upstream_throttled:` prefix is load-bearing — see the finnhub comment
        // and error-class.ts: the auth regex runs first and matches the `_apiKey`
        // in this message's own workaround hint, so without the prefix these 429s
        // booked as auth_required (16/week) and were read as an expected access
        // wall rather than as the pack being throttled out of service.
        'upstream_throttled: setlist.fm rate limit (429) — the shared application key is metered at roughly 2 requests/second and 1440/hour, and the hourly budget is currently spent. This is upstream throttling rather than a bad request; retry in a few minutes, or pass your own free key via _apiKey (https://api.setlist.fm/docs/1.0/index.html#registration).',
      );
    }
    if (!res.ok) throw await httpError(res, 'setlist.fm');
    return res.json();
  };
  // The two setlist readers key on an MBID, which a caller asking "Radiohead's
  // most recent concert" does not have and cannot guess. Accept a name and
  // resolve it, so the mbid-only tools stop being reachable by ID alone.
  if ((name === 'artist' || name === 'artist_setlists') && !args.mbid) {
    const named = args.artist_name ?? args.artistName ?? args.name ?? args.artist;
    if (typeof named === 'string' && named.trim()) {
      const wanted = named.trim();
      const found = (await get('/search/artists', { artistName: wanted })) as {
        artist?: { mbid?: string; name?: string }[];
      };
      const list = Array.isArray(found?.artist) ? found.artist : [];
      // Exact name first: setlist.fm's artist search is substring-based and
      // ranks tribute acts above the band they cover, so taking the top hit is
      // how "most recent Radiohead concert" answers with a tribute band.
      const exact = list.find((a) => (a?.name ?? '').trim().toLowerCase() === wanted.toLowerCase());
      const chosen = exact ?? list[0];
      if (!chosen?.mbid) {
        return {
          found: false,
          reason: 'artist_not_resolved',
          requested_artist: wanted,
          hint: `setlist.fm has no artist matching "${wanted}". Check the spelling, or pass the MusicBrainz mbid directly.`,
        };
      }
      args.mbid = chosen.mbid;
      args._resolved_artist = chosen.name ?? wanted;
      // Say when the resolution was inexact — a near-miss is how a caller ends
      // up reading one band's setlists under another band's name.
      if (!exact) args._resolution_note = `No exact match for "${wanted}"; used the closest setlist.fm artist "${chosen.name}". Confirm this is the intended act.`;
    }
  }
  switch (name) {
    case 'artist':
      return withResolution(await get(`/artist/${encodeURIComponent(reqStr('mbid', '"a74b1b7f-71a5-4011-9441-d0b5e4122711" (or pass artist_name instead)'))}`), args);
    case 'artist_search':
      // `venue_search` and `cities` got this guard in a00a676b and both went
      // clean; the two artist-facing searches were left passing an argless call
      // through and are now the only tools in the pack still filing setlist.fm's
      // bare "404 — no search criteria specified" as OUR error. The alias rescue
      // above only helps a caller who sent *some* name; one who sent `{}` or a
      // page number still gets the shrug.
      reqAnyOf(['artistName', 'artistMbid', 'artistTmid'], '{"artistName":"Radiohead"}');
      return get('/search/artists', args);
    case 'artist_setlists':
      return withResolution(
        await get(`/artist/${encodeURIComponent(reqStr('mbid', '"<mbid>" (or pass artist_name instead)'))}/setlists`, { p: args.p }),
        args,
      );
    case 'venue':
      return get(`/venue/${encodeURIComponent(reqStr('id', '"<venue_id>"'))}`);
    case 'venue_search':
      reqAnyOf(['name', 'cityId', 'cityName', 'country', 'state', 'stateCode'], '{"name":"Fillmore"}');
      checkCountry();
      return get('/search/venues', args);
    case 'venue_setlists':
      return get(`/venue/${encodeURIComponent(reqStr('id', '"<venue_id>"'))}/setlists`, { p: args.p });
    case 'setlist':
      return get(`/setlist/${encodeURIComponent(reqStr('setlist_id', '"<setlist_id>"'))}`);
    case 'setlist_search': {
      reqAnyOf([
        'artistName', 'artistMbid', 'cityId', 'cityName', 'country',
        'state', 'stateCode', 'tourName', 'venueId', 'venueName', 'date', 'year',
      ], '{"artistName":"U2","year":1987}');
      checkCountry();
      normalizeDate();
      const data = (await get('/search/setlists', args)) as {
        setlist?: { artist?: { name?: string } }[];
      };
      const filtered = preferExactArtist(data, args.artistName) as {
        setlist?: unknown[];
      };
      // RESOLVE THE ARTIST, don't just filter the page.
      //
      // Filtering alone was not enough: setlist.fm's setlist search is
      // substring-based and ranks tribute acts above the band, so page 1 of
      // "Radiohead" is Berklee Radiohead Ensemble, Radiohead Cover Brasil, An
      // Evening of Radiohead… with no exact match anywhere on it. Nothing to
      // prefer, so the filter passed the cover bands straight through and the
      // answer reported a St Albans Cathedral show as Radiohead's latest.
      //
      // The artist SEARCH does return the real band (verified: exactly one
      // "Radiohead" among 33 near-name hits), so when the setlist page has no
      // exact match, resolve the name to an MBID and read that artist's own
      // setlists instead. One extra upstream call, only on the miss path.
      const wanted = typeof args.artistName === 'string' ? args.artistName.trim() : '';
      if (wanted && !Array.isArray(filtered.setlist)) return filtered;
      if (wanted && !(filtered as { matched_artist_exactly?: string }).matched_artist_exactly) {
        const norm = (s: string) => s.normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
        const found = (await get('/search/artists', { artistName: wanted })) as {
          artist?: { name?: string; mbid?: string }[];
        };
        const exact = (found.artist ?? []).find((a) => norm(a?.name ?? '') === norm(wanted));
        if (exact?.mbid) {
          // KEEP THE CALLER'S OTHER FILTERS. `/artist/{mbid}/setlists` takes only
          // a page number, so falling back to it silently discarded date, year,
          // venue, city and tour. Asking "what did U2 play on 02-04-1987" returned
          // all 1,875 U2 setlists newest-first — a 2026 show presented as the
          // answer, under a note explaining the tribute-band rescue, which reads
          // like the tool knew what it was doing. Confidently wrong is the one
          // outcome this pack must not produce.
          //
          // `/search/setlists` accepts `artistMbid`, so the disambiguation and the
          // filters are not actually in tension: re-run the SEARCH scoped to the
          // resolved MBID and keep everything else the caller sent.
          const NARROWING = ['date', 'year', 'cityId', 'cityName', 'country', 'state', 'stateCode', 'tourName', 'venueId', 'venueName'];
          const narrowed = NARROWING.filter((k) => args[k] != null && String(args[k]).trim() !== '');
          if (narrowed.length) {
            const scoped: Record<string, unknown> = { ...args, artistMbid: exact.mbid };
            delete scoped.artistName;
            try {
              const hit = (await get('/search/setlists', scoped)) as Record<string, unknown>;
              return {
                ...hit,
                resolved_artist: exact.name,
                resolved_mbid: exact.mbid,
                note: `Search matched only near-name acts (tribute/cover bands), so this was re-run against ${exact.name}'s MusicBrainz id, keeping your ${narrowed.join('/')} filter.`,
              };
            } catch (e) {
              // setlist.fm answers a search with no matches with a 404, which is
              // "no setlists on that date", not a failure. Say so plainly rather
              // than filing it as our error or, worse, widening the search until
              // something comes back.
              if (!/\b404\b/.test(String((e as Error)?.message ?? ''))) throw e;
              return {
                type: 'setlists',
                total: 0,
                setlist: [],
                resolved_artist: exact.name,
                resolved_mbid: exact.mbid,
                note: `${exact.name} has no setlist on setlist.fm matching your ${narrowed.join('/')} filter. The artist was resolved successfully, so this is an absence of data rather than a failed lookup.`,
              };
            }
          }
          const own = (await get(`/artist/${encodeURIComponent(exact.mbid)}/setlists`, { p: args.p })) as Record<string, unknown>;
          return {
            ...own,
            resolved_artist: exact.name,
            resolved_mbid: exact.mbid,
            note: `Search matched only near-name acts (tribute/cover bands), so this is ${exact.name}'s own setlist history.`,
          };
        }
      }
      return filtered;
    }
    case 'user':
      return get(`/user/${encodeURIComponent(reqStr('user_id', '"<user_id>"'))}`);
    case 'user_attended':
      return get(`/user/${encodeURIComponent(reqStr('user_id', '"<user_id>"'))}/attended`, { p: args.p });
    case 'cities':
      reqAnyOf(['name', 'country', 'state', 'stateCode'], '{"name":"Berlin","country":"DE"}');
      checkCountry();
      return get('/search/cities', args);
    case 'countries':
      return get('/search/countries');
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
