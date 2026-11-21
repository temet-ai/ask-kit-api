// One HTTP API, described by its OpenAPI (Swagger 2.0, OpenAPI 3.0 or 3.1) document. The document is read from
// the API_SPEC setting (a URL or a file, JSON or YAML) and kept out of your context: you ask for operations by
// words and read one operation at a time. Requests go to API_BASE_URL, else the document's first `servers` entry,
// and to no other address: a path or URL on another host is refused, and a redirect to another host is not followed.
//
// An operation is named by its operationId (`listGuards`), by `METHOD /path` (`GET /guards/{id}`) or by a path
// (`/guards/7` is matched to `/guards/{id}`). A name that matches nothing throws with the nearest operations.
//
// The credential (API_TOKEN) is added to every request that needs one, in the way the document or API_AUTH says.
// You never see it and cannot set it: a header such as Authorization is refused. In an answer, a field named like
// a credential (password, secret, token, api_key, access_key, private_key, authorization, cookie ...) is replaced
// with "<redacted>", and so is any text equal to the token. Counting tokens or a next-page token is not hidden.
// Do not try to read a credential another way; say that the field exists and is not shown.
//
// Reading and changing: GET, HEAD and OPTIONS always run. POST, PUT, PATCH and DELETE run only when the caller asked
// for a change; otherwise the call throws "not in this ask: ...", and you say that the change needs `ask` with
// `act: true`. A POST the document marks `x-readonly: true` (or API_READ_POSTS names) is a search and runs; `find`
// and `describe` show `changes: true` on the operations that are held. `act` below says which this ask is.
//
// A failed request is returned, not thrown: check `ok` and `status`. `hint` says what a 401, 403, 404, 429 or a
// refused connection usually means here. Only a refusal, a name that matches nothing or a missing argument throws.

interface OperationLine {
  id: string;                    // the operationId, or "METHOD /path" when the document has none
  op: string;                    // "GET /guards/{id}"
  does: string;                  // the summary, first words
  changes?: true;                // this call is held unless the ask may change things
  deprecated?: true;
}

interface Param { name: string; in: "path" | "query" | "header" | "cookie"; required: boolean; type: string; default?: any; about?: string; deprecated?: true }

interface Described {
  id: string; op: string; matched?: string; summary?: string; description?: string; tags?: string[];
  changes: boolean;
  runs: string;                  // whether this ask may send it
  auth: string;                  // how the credential is sent for it, or that it takes none
  parameters: Param[]; moreParameters?: string;
  body?: { required: boolean; contentType: string; alsoTakes?: string[]; shape: string };   // shape reads like a TypeScript type; `?` marks an optional field
  response: { status: string; about?: string; contentType?: string; shape: string } | string;
  otherResponses?: string[];     // "404 no guard with that id"
  deprecated?: true;
}

interface Answer {
  status: number | null;         // null: nothing answered (see `error`, `code`, `hint`)
  ok: boolean;                   // a 2xx answer
  op: string;                    // the operation the request belongs to
  matched?: string;              // how the name was matched, when it was not exact
  url: string;                   // the path and query that were sent, credentials removed
  data: any;                     // the parsed JSON, or text; credential fields are "<redacted>"
  headers: Record<string, string>;   // the headers that say something (Link, X-Total-Count, Location, rate limits)
  ms: number;
  redacted?: string;             // names of the fields that were replaced
  note?: string;                 // a cut answer, a non-text answer, a redirect that was not followed
  hint?: string;
  error?: string; code?: string; meaning?: string;
}

interface Pages {
  status: number; ok: boolean; op: string;
  pagination: string;            // how pages were followed: the Link header, a cursor, a page number, an offset, or "none"
  pages: number;                 // requests made
  count: number;                 // items in `items`
  total?: number;                // the API's own total, when the answer or an X-Total-Count header gives one
  more: boolean;                 // true when there are more items than were read (the page or item limit was reached)
  listField?: string;            // the field of the answer that held the list (`data`, `items`, `results` ...)
  items: any[];
  stopped?: string;              // why paging ended early (a page failed, repeated, or led to another host)
  redacted?: string;
}

declare const api: {
  // The API: title, version, the address requests go to, how the credential is sent and whether one is set,
  // operation counts (reads and changes) and the tags with their counts.
  info(): Promise<{ title: string; version: string | null; document: string; about?: string; baseUrl: string | null; baseUrlProblem?: string; auth: { sentAs: string; from: string; credentialSet: boolean }; operations: number; reads: number; changes: number; tags: { tag: string; operations: number; reads: number; changes: number; about?: string }[]; readingPosts?: string[]; remoteReferences?: string; note?: string }>;

  // Operations that fit some words (a path and a method count too), best first, at most `max` (default 15).
  // Words are matched against operationIds, paths, summaries, tags and descriptions; plural and singular match.
  // tag keeps one tag, method one HTTP method. With no words: every operation in the document's order.
  find(words: string, o?: { tag?: string; method?: string; max?: number } | number): Promise<OperationLine[]>;
  count(words: string, o?: { tag?: string; method?: string }): Promise<number>;
  tags(): Promise<{ tag: string; operations: number; reads: number; changes: number; about?: string }[]>;

  // One operation in full: parameters, request body, success response and other status codes, as typed shapes.
  // depth is how many levels of nested objects are written out (default 3).
  describe(op: string, o?: { depth?: number }): Promise<Described>;
  // One named schema of the document (exact, then any case, then a part of the name).
  schema(name: string, o?: { depth?: number }): Promise<{ name: string; shape: string }>;

  // Send one request. `args` puts each value where the operation takes it: {path: {id: 7}, query: {...}, body: {...},
  // headers: {...}}; a bare key that the operation declares (`{id: 7, rank: "sergeant"}`) is placed for you.
  // Missing required parameters throw before anything is sent. Not for multipart uploads.
  call(op: string, args?: { path?: Record<string, any>; query?: Record<string, any>; body?: any; headers?: Record<string, string>; [param: string]: any }, o?: { timeoutMs?: number }): Promise<Answer>;
  // GET a path (or a full address on the API's own host); the path may hold a query string. Matched to its operation
  // when the document has one, and sent either way.
  get(path: string, query?: Record<string, any>, o?: { timeoutMs?: number }): Promise<Answer>;

  // A list operation across its pages. `op` is an operation name or a path. Follows the Link header's rel=next, a next
  // link or cursor in the answer, page numbers (page, per_page) or an offset (offset, limit), whichever the API uses, and
  // stops on a repeated page. max: most pages (default 5, at most 50); maxItems: stop after this many items.
  pages(op: string, args?: { query?: Record<string, any>; path?: Record<string, any> }, o?: { max?: number; maxItems?: number; timeoutMs?: number }): Promise<Pages | (Answer & { pagination: string; pages: number; count: 0; items: [] })>;

  // The cheapest reading operations to try the API with (GET, nothing required), those that take no credential first.
  probes(): Promise<{ open: { id: string; op: string; takesCredential: boolean; sizeParam: string | null }[]; guarded: { id: string; op: string; takesCredential: boolean; sizeParam: string | null }[]; credentialSet: boolean }>;

  // The reading calls (info, find, count, tags, describe, schema) over another OpenAPI document: a URL or a file path.
  // It cannot send requests; only the configured API receives them.
  document(source: string): Pick<typeof api, "info" | "find" | "count" | "tags" | "describe" | "schema">;

  // True when the caller asked for a change in this ask.
  act: boolean;
};
