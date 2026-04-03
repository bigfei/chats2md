import argparse
import gzip
import json
import urllib.error
import urllib.request
import zlib
from pathlib import Path


DEFAULT_URL = (
    "https://chatgpt.com/backend-api/conversations"
    "?offset=0&limit=28&order=updated&is_archived=false&is_starred=false"
)
DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0 chats2md/0.1.0"


def load_session(session_path: Path) -> dict:
    try:
        return json.loads(session_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Session file not found: {session_path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in session file: {session_path}\n{exc}") from exc


def parse_header(raw: str) -> tuple[str, str]:
    if ":" not in raw:
        raise SystemExit(f"Invalid --header value (missing ':'): {raw}")

    name, value = raw.split(":", 1)
    name = name.strip()
    value = value.strip()

    if not name or not value:
        raise SystemExit(f"Invalid --header value: {raw}")

    return name, value


def build_base_headers(session: dict, extra_headers: list[str]) -> dict[str, str]:
    access_token = session.get("accessToken")
    account_id = (session.get("account") or {}).get("id")

    if not access_token:
        raise SystemExit("Missing 'accessToken' in the session JSON.")
    if not account_id:
        raise SystemExit("Missing 'account.id' in the session JSON.")

    headers = {
        "Authorization": f"Bearer {access_token}",
        "ChatGPT-Account-ID": account_id,
        "Accept": "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
    }

    for raw in extra_headers:
        name, value = parse_header(raw)
        headers[name] = value

    return headers


def find_cookie(session: dict, cookie_override: str | None) -> str | None:
    if cookie_override:
        return cookie_override

    if isinstance(session.get("cookie"), str) and session["cookie"].strip():
        return session["cookie"].strip()

    headers = session.get("headers")
    if isinstance(headers, dict):
        for key in ("Cookie", "cookie"):
            value = headers.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

    return None


def decode_body(data: bytes, content_encoding: str | None) -> str:
    encoding = (content_encoding or "").strip().lower()

    if not encoding:
        return data.decode("utf-8", errors="replace")

    if encoding == "gzip":
        return gzip.decompress(data).decode("utf-8", errors="replace")

    if encoding == "deflate":
        return zlib.decompress(data).decode("utf-8", errors="replace")

    if encoding == "br":
        try:
            import brotli
        except ModuleNotFoundError:
            return f"<brotli-compressed response; install brotli to decode> {data[:120]!r}"

        return brotli.decompress(data).decode("utf-8", errors="replace")

    if encoding == "zstd":
        try:
            import zstandard
        except ModuleNotFoundError:
            return f"<zstd-compressed response; install zstandard to decode> {data[:120]!r}"

        return zstandard.ZstdDecompressor().decompress(data).decode("utf-8", errors="replace")

    return data.decode("utf-8", errors="replace")


def fetch(url: str, headers: dict[str, str]) -> tuple[int, str, str]:
    request = urllib.request.Request(url, headers=headers)

    try:
        with urllib.request.urlopen(request) as response:
            body = decode_body(response.read(), response.headers.get("Content-Encoding"))
            return response.getcode(), response.headers.get_content_type(), body
    except urllib.error.HTTPError as exc:
        body = decode_body(exc.read(), exc.headers.get("Content-Encoding") if exc.headers else None)
        content_type = exc.headers.get_content_type() if exc.headers else "application/octet-stream"
        return exc.code, content_type, body
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error while fetching conversations: {exc}") from exc


def summarize_body(body: str) -> str:
    collapsed = " ".join(body.split())
    return collapsed[:280]


def summarize_json(body: str) -> str | None:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return None

    if isinstance(payload, dict):
        if isinstance(payload.get("items"), list):
            return f"json dict items={len(payload['items'])}"
        if isinstance(payload.get("conversations"), list):
            return f"json dict conversations={len(payload['conversations'])}"
        return "json dict"

    if isinstance(payload, list):
        return f"json list len={len(payload)}"

    return f"json {type(payload).__name__}"


def run_probe(label: str, url: str, headers: dict[str, str]) -> None:
    status, content_type, body = fetch(url, headers)
    json_summary = summarize_json(body)

    print(label)
    print(f"  status: {status}")
    print(f"  content_type: {content_type}")
    print(f"  json: {json_summary or 'no'}")
    print(f"  body_prefix: {summarize_body(body)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Probe the ChatGPT conversations list endpoint with and without the Cookie "
            "header to verify whether cookie presence changes the response."
        )
    )
    parser.add_argument(
        "session_json",
        type=Path,
        help="Path to session.json containing accessToken and account.id",
    )
    parser.add_argument(
        "--url",
        default=DEFAULT_URL,
        help=f"Conversations URL to probe (default: {DEFAULT_URL})",
    )
    parser.add_argument(
        "--header",
        action="append",
        default=[],
        help="Additional request header in the form 'Name: Value'. Repeat as needed.",
    )
    parser.add_argument(
        "--cookie",
        help="Explicit Cookie header value. If omitted, the script tries session.json cookie fields.",
    )
    parser.add_argument(
        "--only-with-cookie",
        action="store_true",
        help="Only run the request variant that includes Cookie.",
    )
    parser.add_argument(
        "--only-without-cookie",
        action="store_true",
        help="Only run the request variant that excludes Cookie.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.only_with_cookie and args.only_without_cookie:
        raise SystemExit("Choose only one of --only-with-cookie or --only-without-cookie.")

    session = load_session(args.session_json)
    base_headers = build_base_headers(session, args.header)
    cookie = find_cookie(session, args.cookie)

    if not args.only_with_cookie:
      headers_without_cookie = dict(base_headers)
      headers_without_cookie.pop("Cookie", None)
      run_probe("without_cookie", args.url, headers_without_cookie)

    if not args.only_without_cookie:
        if not cookie:
            print("with_cookie")
            print("  skipped: no cookie value was provided or found in session.json")
        else:
            headers_with_cookie = dict(base_headers)
            headers_with_cookie["Cookie"] = cookie
            run_probe("with_cookie", args.url, headers_with_cookie)

    return 0
