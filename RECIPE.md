# Recipe: the api kit

## What it answers

One HTTP API that has an OpenAPI document: which operations it has and which tag or path holds a
job; what an operation takes (path, query, header, body) and returns, as typed shapes, with its
other status codes; whether the API is up and the token accepted; what a call answers; every item
of a list across its pages. It also acts: POST, PUT, PATCH and DELETE, when the ask may change
things.

## What it needs

- ask-kit 0.3.0 or newer (`min_ask_kit = "0.3.0"`). Node.js, which ask-kit needs anyway. No
  package and no program.
- `API_SPEC` (required): a URL or a file path, JSON or YAML, OpenAPI 3.0, 3.1 or Swagger 2.0.
- Optional: `API_BASE_URL`, `API_TOKEN` (a secret setting), `API_AUTH`, `API_READ_POSTS`,
  `API_NAME`, `WORKDIR` (detected: the folder the agent runs in; a relative `API_SPEC` starts there).

## What it reads and runs

It reads the OpenAPI document: a file, or a URL fetched with GET and no credential (kept for an
hour under the state folder, `<ask-kit state>/api/spec`; a YAML document's parsed form is kept
under `.../api/cache`, named by the hash of its text; when the URL stops answering, the last copy
is used and the answer says so). `$ref` is followed inside the document; a reference to another
file or address is reported and not fetched.

It sends HTTP and HTTPS requests with Node's `http` and `https` to the API's own origin and to no
other address, through `HTTPS_PROXY` or `HTTP_PROXY` unless `NO_PROXY` covers the host (this
machine's own addresses never use a proxy). It runs no program and no shell. Every request has a
timeout and a 16 MB cap; a response compressed with gzip, br or deflate is unpacked.

Redacted because answers go to a cloud model: fields of an answer named like a credential
(password, passwd, secret, token, api key, private key, access key, credential, `authorization`,
`cookie`), except next-page and count fields such as `next_page_token` and `token_type`; response
headers named like a credential or a session (`Set-Cookie` included); and every text equal to the
token, its URL-encoded form, its base64 form and the part after a colon of a `user:password`
token. A token sent in the query is not in the URL shown. A password in `API_BASE_URL` is dropped.

Refused: a header the kit sets itself (`Authorization`, `Cookie`, `Host`, `Content-Length` and the
header that carries the credential); a path or URL on another host; a redirect to another host
(returned as the 3xx answer with a note); a multipart body; POST, PUT, PATCH and DELETE without
`act`, except a POST the document marks `x-readonly: true` or `API_READ_POSTS` names.

## Brief to rebuild it from an empty folder

Make a folder with `ask-kit.toml` (id `temet.api`, name `api`, `says`, `keywords`, `route_hint`,
`cite`, `instructions`, `scripts`, `bench`, one prose entry in `acts` because the host cannot tell
a GET from a POST made through the same `api.call`, the settings above with `API_SPEC` required
and `API_TOKEN` secret, one `[[sources]]` of kind `module`, name `api`, module `api.mjs`, api
`api.d.ts`). There are no actions: a pattern such as "is the api up" would claim the question for
whatever API the kit holds, including one that belongs to another kit.

- `yaml.mjs`: a YAML subset parser for OpenAPI documents (block and flow collections, scalars,
  block scalars, anchors, aliases and the merge key; the first document of a file; no complex keys,
  no tags other than `!!str`, no tabs as indentation). A document starting
  with `{` is parsed as JSON.
- `http.mjs`: `request(url, {method, headers, body, timeoutMs, maxBytes, redirects, stay})` with
  proxy tunnelling for HTTPS, one deadline for the whole exchange, a size cap, and redirects
  followed for GET and HEAD, kept inside the first address's origin when `stay` is set.
  It never throws for a network failure: it returns `{ok: false, code, error, meaning}`.
- `spec.mjs`: `loadSpec` (file or URL, caching, `$ref`), the operation list (operationId, or
  `METHOD /path` when it has none), `paramsOf`, `bodyOf`, `responsesOf`, `shape` (a schema written
  like a TypeScript type, with `allOf`, `oneOf`, nullable and cycles handled, depth and line
  caps), `rank` (operations by words, with tag and method filters), `matchPath` (`/guards/7` to
  `/guards/{id}`) and `resolveOp`.
- `api.mjs`: `make({settings, push, act})` returns the `api` global. `send` builds the URL from the
  base address, places the credential (`bearer`, `basic`, a header, a cookie or the query, from
  `API_AUTH`, else the document's security scheme, else bearer), sends, parses, and returns a raw
  answer that only `tidy` turns into what the investigator sees (redaction, a few headers, hints
  for 401, 403, 404 and 429). `pages` detects the paging in use: a `Link` header, a next link in
  the answer, a cursor or page token, a page number, an offset. Every function of the global is
  wrapped so an error message never carries the token.
- `lib.mjs` and `scripts/`: `overview`, `find`, `describe`, `call`, `list`, `check`, each with
  `meta` (`purpose`, `params`, `returns`, `example`) and a `verdict` first.
- `instructions.md`, with the same structure as the git kit's: how to work, the answer format.
- `bench/fixture/`: `watch-api.yaml` (an OpenAPI 3.1 document for the Ankh-Morpork City Watch:
  three kinds of paging, a POST marked `x-readonly`, an operation with no security, a redirect to
  another host, a response that echoes the token) and `server.mjs` (the API on 127.0.0.1,
  in memory). `bench/with-fixture.mjs` starts it on a free port, runs a command with `API_SPEC`,
  `API_BASE_URL` and `API_TOKEN` set, and stops it. `bench/hold-check.mjs` checks the rules against
  it. `bench/questions.json` holds shots with `expect` patterns and questions for a model.

## Results

On 2026-11-21: the 12 shots matched their expectations (each run with `ask-kit run api <script>`),
and `bench/hold-check.mjs` passed 30 of 30. A Swagger 2.0 document served over HTTP was read
(operations, a body shape, an API key header). No model has been run on the bench.
