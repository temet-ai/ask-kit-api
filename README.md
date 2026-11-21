# ask-kit-api

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about one HTTP API that has an OpenAPI (Swagger) document. A cheap model finds
the operation, reads what it takes and returns, and calls it, outside your agent's context. The
document stays out of the conversation: it is searched by words and read one operation at a time.
It reads OpenAPI 3.0 and 3.1 and Swagger 2.0, as JSON or YAML, from a URL or a file.

Questions it is built for, shown against the fixture in `bench/`:

- Which endpoint reports a new incident, and what must its body hold?
- How many guards are sergeants, and how does the API page that list?
- Does my token work against this API?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) 0.3.0 or later. Nothing else is
installed: the kit sends its requests with Node's own `http` and `https`, and follows
`HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-api
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-api        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-api --yes  # installs and enables it
```

Restart your agents so `ask` lists `api`. The kit serves one API, set in these settings (in the
environment, or under `domains.api.settings` in ask-kit's config):

| Setting | Holds |
|---|---|
| `API_SPEC` (required) | The OpenAPI document: a URL or a file path. A URL is fetched without the credential, so for a document behind one, save a copy and give the path. |
| `API_BASE_URL` | Where requests go. Default: the first `servers` entry of the document. |
| `API_TOKEN` | The credential: a bearer token, an API key, or `user:password` for basic auth. Empty for an API that needs none. |
| `API_AUTH` | How the token is sent when the document does not say: `bearer`, `basic`, `header:<Name>` or `query:<name>`. |
| `API_READ_POSTS` | POST operations that only read (a search), by operationId or path, for a document that does not mark them `x-readonly: true`. |
| `API_NAME` | What to call the API in answers. |

For a second API, use a second copy of the kit under another name.

## What it carries

The `api` global gives the investigator `info`, `find`, `count`, `tags`, `describe`, `schema`,
`call`, `get`, `pages`, `probes` and `document` (the reading calls over another document).
Its scripts, each returning a `verdict` line first:

- `overview`: title, version, address, how the credential is sent, operation and tag counts, where to start.
- `find`: the operations that fit some words, ranked, with the best one described in full.
- `describe`: one operation (parameters, request body and response as typed shapes, status codes) or one schema.
- `call`: what one operation answers, a long list cut to a limit.
- `list`: every item of a list operation across its pages. It follows a `Link` header, a next link or cursor in the answer, page numbers or an offset, and stops on a repeated page.
- `check`: whether the API answers and the token is accepted, from its cheapest reading operations.

There are no skills or roles. [RECIPE.md](RECIPE.md) says what it reads and runs and how to rebuild it.

## What it can change

A request with a method other than GET, HEAD or OPTIONS (POST, PUT, PATCH, DELETE) is sent only
when the caller asked for a change (`act: true`, or a request that opens with what to do). Other
asks get `not in this ask: ...` from the module. A POST the document marks `x-readonly: true`, or
`API_READ_POSTS` names, is treated as a read. `find` and `describe` mark held operations with
`changes`. Running a script by name with `do` is a deliberate call, and a `call` shot of a
changing operation is sent.

What else it holds to:

- The token is added to requests by the kit. A header such as `Authorization` cannot be set by the
  investigator. Fields of an answer named like a credential (password, secret, token, api key,
  authorization, cookie) are replaced with `<redacted>`, and so is any text equal to the token.
  Errors, URLs and headers are cleaned the same way. A secret in a field with another name is not
  caught.
- Requests, and the token, go only to the API's own address (scheme, host and port). Another
  host in a path or a next-page link is refused, and a redirect to another host is not followed.
  The document is fetched without the token.
- Every request has a timeout (30 seconds, at most 120) and a size cap of 16 MB. Multipart
  uploads are not sent.

## How well it works

`bench/questions.json` holds 12 shots (scripts with params, no model) and 7 questions for a
model, against the fixture in `bench/fixture/`: a small OpenAPI document and a server for it on
127.0.0.1 with in-memory data. `node bench/with-fixture.mjs` starts the server on a free port,
runs `bench/hold-check.mjs` (30 checks of the rules above, no model) with the three settings
pointed at it, and stops the server. `node bench/with-fixture.mjs ask-kit kit test api` runs the
bench instead; its 7 questions call a model.

On 2026-11-21 the 12 shots, each run with `ask-kit run api <script>`, matched their expectations,
and the 30 checks passed. The bench has not been run on a model, so there are no pass rates, times
or costs yet.

MIT licence.
