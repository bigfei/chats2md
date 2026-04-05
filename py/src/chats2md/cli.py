import argparse
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


DEFAULT_BASE_URL = "https://chatgpt.com"
DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0 chats2md/0.1.0"
TOTAL_COUNT_PAGE_LIMIT = 50
MAX_TOTAL_COUNT_PAGES = 1000


def load_session(session_path: Path) -> dict:
    try:
        return json.loads(session_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Session file not found: {session_path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in session file: {session_path}\n{exc}") from exc


def build_conversations_url(base_url: str, offset: int, limit: int) -> str:
    query = urllib.parse.urlencode(
        {
            "offset": offset,
            "limit": limit,
            "order": "updated",
            "is_archived": "false",
            "is_starred": "false",
        }
    )
    return f"{base_url.rstrip('/')}/backend-api/conversations?{query}"


def build_conversation_detail_url(base_url: str, conversation_id: str) -> str:
    return f"{base_url.rstrip('/')}/backend-api/conversation/{urllib.parse.quote(conversation_id)}"


def fetch_conversations(base_url: str, access_token: str, account_id: str, offset: int, limit: int) -> dict:
    request = urllib.request.Request(
        build_conversations_url(base_url, offset, limit),
        headers={
            "Authorization": f"Bearer {access_token}",
            "ChatGPT-Account-ID": account_id,
            "Accept": "application/json",
            "User-Agent": DEFAULT_USER_AGENT,
        },
    )

    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code} while fetching conversations:\n{body}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error while fetching conversations: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON returned by conversations endpoint:\n{exc}") from exc


def fetch_conversation_detail(base_url: str, access_token: str, account_id: str, conversation_id: str) -> dict:
    request = urllib.request.Request(
        build_conversation_detail_url(base_url, conversation_id),
        headers={
            "Authorization": f"Bearer {access_token}",
            "ChatGPT-Account-ID": account_id,
            "Accept": "application/json",
            "User-Agent": DEFAULT_USER_AGENT,
        },
    )

    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(
            f"HTTP {exc.code} while fetching conversation detail {conversation_id}:\n{body}"
        ) from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error while fetching conversation detail {conversation_id}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"Invalid JSON returned by conversation detail endpoint for {conversation_id}:\n{exc}"
        ) from exc


def get_items(payload: dict) -> list[dict]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("items", "conversations"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
    raise SystemExit("Could not find a conversation list in the API response.")


def get_total(payload: dict) -> int | None:
    if not isinstance(payload, dict):
        return None

    value = payload.get("total")
    return value if isinstance(value, int) and value >= 0 else None


def count_total_conversations(
    base_url: str,
    access_token: str,
    account_id: str,
    page_limit: int = TOTAL_COUNT_PAGE_LIMIT,
) -> tuple[int, int]:
    seen_ids: set[str] = set()
    offset = 0
    pages_fetched = 0
    stable_intervals = 0

    for _ in range(MAX_TOTAL_COUNT_PAGES):
        payload = fetch_conversations(base_url, access_token, account_id, offset, page_limit)
        items = get_items(payload)
        pages_fetched += 1

        before = len(seen_ids)
        for index, item in enumerate(items):
            conversation_id = item.get("id")
            if isinstance(conversation_id, str) and conversation_id:
                seen_ids.add(conversation_id)
            else:
                seen_ids.add(f"offset-{offset}-item-{index}")
        after = len(seen_ids)

        if not items:
            break
        if len(items) < page_limit:
            break

        api_total = get_total(payload)
        if api_total is not None and after >= api_total:
            break

        if after == before:
            stable_intervals += 1
        else:
            stable_intervals = 0

        if stable_intervals >= 1:
            break

        offset += page_limit

    return len(seen_ids), pages_fetched


def print_conversations(items: list[dict]) -> None:
    if not items:
        print("No conversations returned.")
        return

    for index, item in enumerate(items, start=1):
        conversation_id = item.get("id", "<no-id>")
        title = item.get("title") or "<untitled>"
        update_time = item.get("update_time") or item.get("updated_time") or "<no-update-time>"
        print(f"{index:>3}. {title}")
        print(f"     id: {conversation_id}")
        print(f"     updated: {update_time}")


def save_conversation_details(
    base_url: str,
    access_token: str,
    account_id: str,
    items: list[dict],
    output_dir: Path,
) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    saved = 0

    for item in items:
        conversation_id = item.get("id")
        if not isinstance(conversation_id, str) or not conversation_id:
            continue

        payload = fetch_conversation_detail(base_url, access_token, account_id, conversation_id)
        output_path = output_dir / f"{conversation_id}.json"
        output_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        saved += 1

    return saved


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read a ChatGPT /api/auth/session JSON file and list conversations."
    )
    parser.add_argument(
        "session_json",
        type=Path,
        help="Path to the saved JSON returned by https://chatgpt.com/api/auth/session",
    )
    parser.add_argument("--limit", type=int, default=28, help="Number of conversations to request")
    parser.add_argument("--offset", type=int, default=0, help="Result offset")
    parser.add_argument(
        "--count-total",
        action="store_true",
        help=(
            "Iterate the conversations list API in 50-item pages and print the total "
            "unique conversation count."
        ),
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Base URL for ChatGPT (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--save-detail-json-dir",
        type=Path,
        help=(
            "Directory to save /backend-api/conversation/{id} JSON for each conversation "
            "returned by the current --limit/--offset page."
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session = load_session(args.session_json)

    access_token = session.get("accessToken")
    account_id = (session.get("account") or {}).get("id")

    if not access_token:
        raise SystemExit("Missing 'accessToken' in the session JSON.")
    if not account_id:
        raise SystemExit("Missing 'account.id' in the session JSON.")
    if args.limit <= 0:
        raise SystemExit("--limit must be greater than 0.")
    if args.offset < 0:
        raise SystemExit("--offset must be 0 or greater.")
    if args.count_total and args.save_detail_json_dir:
        raise SystemExit("--save-detail-json-dir cannot be used with --count-total.")

    if args.count_total:
        total, pages_fetched = count_total_conversations(
            args.base_url,
            access_token,
            account_id,
            TOTAL_COUNT_PAGE_LIMIT,
        )
        print(f"Total conversations: {total}")
        print(f"Pages fetched: {pages_fetched}")
        print(f"Page limit: {TOTAL_COUNT_PAGE_LIMIT}")
        return 0

    payload = fetch_conversations(args.base_url, access_token, account_id, args.offset, args.limit)
    items = get_items(payload)
    print_conversations(items)

    if args.save_detail_json_dir:
        saved_count = save_conversation_details(
            args.base_url,
            access_token,
            account_id,
            items,
            args.save_detail_json_dir,
        )
        print(f"Saved detail JSON files: {saved_count}")
        print(f"Output directory: {args.save_detail_json_dir}")

    return 0
