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
