# chats2md

Small utilities for working with ChatGPT conversation exports.

## List conversations

Run the CLI with uv from inside `py/`:

```bash
uv run list-conversations session.json
```

Or from the repo root:

```bash
uv --directory py run list-conversations ../session.json
```

Or run the compatibility wrapper directly:

```bash
python3 list_conversations.py session.json
```

## Count total conversations (paginated)

To count all conversations, iterate `/backend-api/conversations` in fixed
`limit=50` pages:

```bash
uv run list-conversations session.json --count-total
```

Or from the repo root:

```bash
uv --directory py run list-conversations ../session.json --count-total
```

This mode increments `offset` by 50 for each page and stops when the unique
conversation total no longer increases over the next 50-item interval.

## Save conversation detail JSON files

To fetch `/backend-api/conversation/{id}` for each conversation returned by the
current `--limit/--offset` page and save raw JSON files:

```bash
uv run list-conversations session.json --save-detail-json-dir ./conversation-json
```

Or from the repo root:

```bash
uv --directory py run list-conversations ../session.json --save-detail-json-dir ./conversation-json
```

Each detail payload is written as `<conversation-id>.json` in the specified
directory.

`--save-detail-json-dir` cannot be combined with `--count-total`.

## Verify cookie necessity

Probe the conversations list endpoint with and without the `Cookie` header:

```bash
uv run verify-cookie-necessity session.json
```

Or from the repo root:

```bash
uv --directory py run verify-cookie-necessity ../session.json
```

The default probe now sends a working built-in `User-Agent`, so the plain
command should be enough for most checks. Add extra headers only when you want
to reproduce a specific browser request.

To reproduce a browser-style request, repeat `--header` and optionally pass an
explicit cookie:

```bash
uv run verify-cookie-necessity session.json \
  --header 'User-Agent: Mozilla/5.0 ...' \
  --header 'OAI-Device-Id: ...' \
  --header 'OAI-Client-Version: ...' \
  --cookie 'oai-did=...; cf_clearance=...'
```
