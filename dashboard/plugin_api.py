"""Authenticated Hermes gateway bridge to the co-located logseqd instance.

The gateway owns authentication and plugin enablement. No upstream URL, token,
filesystem path, Datalog query, or arbitrary HTTP method comes from the renderer.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import hashlib
import json
import os
import re
from datetime import datetime
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

router = APIRouter()
_write_lock = asyncio.Lock()
JOURNAL = re.compile(r"^\d{4}_\d{2}_\d{2}$")


def _base_url() -> str:
    url = os.environ.get("LOGSEQD_URL", "http://127.0.0.1:8471").rstrip("/")
    parsed = urlsplit(url)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise HTTPException(503, "LOGSEQD_URL must be an HTTP(S) URL without credentials or query parameters.")
    return url


def _today() -> str:
    # Max is US Eastern; the server clock may or may not match (it was UTC
    # until 2026-10-28, which made the desktop "Today" journal a day ahead
    # after 8pm ET). Pin explicitly so this stays correct anywhere.
    return datetime.now(ZoneInfo("America/New_York")).strftime("%Y_%m_%d")


def _title(value: str) -> str:
    value = value.strip()
    if not value or len(value) > 512 or any(ord(c) < 32 for c in value):
        raise HTTPException(422, "Enter a page title without control characters.")
    return value


def _edn(value) -> str:
    # JSON string escapes are also EDN string escapes. Keep Unicode literal.
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    raise TypeError("Unsupported EDN value")


async def _upstream(method: str, path: str, values: dict | None = None):
    body = None if values is None else "{" + " ".join(
        f":{key} {_edn(value)}" for key, value in values.items()) + "}"
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            response = await client.request(method, _base_url() + path, content=body,
                                            headers={"Content-Type": "application/edn"})
    except httpx.RequestError:
        message = ("The write could not be confirmed. Refresh the note before retrying."
                   if method == "POST" else "Cannot reach logseqd on this gateway. Check that it is running.")
        raise HTTPException(503, message) from None
    if response.status_code == 404:
        raise HTTPException(404, "Page or block not found.")
    if not response.is_success:
        raise HTTPException(502, "logseqd could not complete this operation. Refresh before retrying a write.")
    try:
        data = response.json()
    except ValueError:
        raise HTTPException(502, "logseqd returned an unreadable response.") from None
    if not isinstance(data, dict) or data.get("error"):
        raise HTTPException(502, "logseqd could not complete this operation.")
    return data


def _ordered(blocks: list) -> list:
    """Canonical document order; upstream order values are sibling-local."""
    by_id = {block.get("block/id"): block for block in blocks}
    children = {}
    roots = []
    for block in blocks:
        parent = (block.get("block/parent") or {}).get("block/id")
        if parent and parent != block.get("block/id") and parent in by_id:
            children.setdefault(parent, []).append(block)
        else:
            roots.append(block)
    result, visited = [], set()
    def walk(siblings, prefix=""):
        for index, block in enumerate(sorted(siblings, key=lambda item: (item.get("block/order", 0), item.get("block/content", "")))):
            identity = block.get("block/id")
            if identity in visited:
                continue
            visited.add(identity)
            path = f"{prefix}/{index}" if prefix else str(index)
            result.append({**block, "block/path": path})
            walk(children.get(identity, []), path)
    walk(roots)
    # Fail closed for mutations on malformed cycles, but keep content readable.
    for block in blocks:
        if block.get("block/id") not in visited:
            walk([block], "orphan")
    return result


def _revision(blocks: list) -> str:
    stable = [{key: block.get(key) for key in
               ("block/content", "block/level", "block/path", "block/todo", "properties")}
              for block in _ordered(blocks)]
    return hashlib.sha256(json.dumps(stable, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


async def _page(title: str) -> dict:
    title = _title(title)
    try:
        data = await _upstream("GET", "/page/" + quote(title, safe=""))
    except HTTPException as error:
        if error.status_code != 404:
            raise
        data = {"title": title, "blocks": []}
    data["blocks"] = _ordered(data.get("blocks", []))
    data["revision"] = _revision(data["blocks"])
    return data


class Entry(BaseModel):
    page: str = Field(min_length=1, max_length=512)
    content: str = Field(min_length=1, max_length=64000)


class BlockEdit(Entry):
    revision: str = Field(min_length=64, max_length=64)
    block_path: str = Field(min_length=1, max_length=512, pattern=r"^\d+(?:/\d+)*$")
    expected_content: str = Field(max_length=64000)


class BlockInsert(BlockEdit):
    sub_block: bool = False


async def _target(edit: BlockEdit) -> dict:
    page = await _page(edit.page)
    if page["revision"] != edit.revision:
        raise HTTPException(409, "This note changed elsewhere. Your draft is safe. Refresh the note before saving.")
    matches = [block for block in page["blocks"]
               if block.get("block/path") == edit.block_path
               and block.get("block/content", "") == edit.expected_content]
    if len(matches) != 1:
        raise HTTPException(409, "The original block changed. Refresh the note before saving.")
    target = matches[0]
    if not isinstance(target.get("block/line"), int):
        raise HTTPException(409, "Update logseqd to this package’s bundled revision before editing blocks.")
    return target


async def _saved(title: str) -> dict:
    try:
        page = await _page(title)
    except HTTPException:
        # A successful write must not look like a failed save if the subsequent
        # read fails: otherwise a retry could insert the same text twice.
        return {"saved": True, "page": None, "refresh_required": True}
    return {"saved": True, "page": page, "refresh_required": False}


def _content(value: str) -> str:
    if not value.strip():
        raise HTTPException(422, "Write something before saving.")
    return value.strip()


@router.get("/status")
async def status():
    await _upstream("GET", "/health")
    return {"connected": True, "today": _today(), "name": "Logseq graph",
            "graph_id": hashlib.sha256(_base_url().encode()).hexdigest()[:20]}


@router.get("/pages")
async def pages():
    return await _upstream("GET", "/pages")


@router.get("/page")
async def page(title: str = Query(min_length=1, max_length=512)):
    return await _page(title)


@router.get("/search")
async def search(q: str = Query(min_length=1, max_length=300)):
    return await _upstream("GET", "/search?q=" + quote(q, safe=""))


@router.post("/append")
async def append(entry: Entry):
    title = _title(entry.page)
    if JOURNAL.fullmatch(title) and title != _today():
        raise HTTPException(422, "Use New block on an existing entry to add to an older journal.")
    async with _write_lock:
        await _upstream("POST", "/append", {"title": title, "content": _content(entry.content),
                                             "journal": title == _today()})
        return await _saved(title)


@router.post("/blocks/update")
async def update(edit: BlockEdit):
    async with _write_lock:
        target = await _target(edit)
        await _upstream("POST", "/update-block", {"id": target["block/id"], "content": _content(edit.content)})
        return await _saved(edit.page)


@router.post("/blocks/insert")
async def insert(edit: BlockInsert):
    async with _write_lock:
        target = await _target(edit)
        level = target.get("block/level", 0) + (1 if edit.sub_block else 0)
        if level > 5:
            raise HTTPException(422, "This block is already at the maximum supported depth.")
        await _upstream("POST", "/insert-block", {"page": _title(edit.page), "content": _content(edit.content),
                                                   "level": level, "after-block-id": target["block/id"]})
        return await _saved(edit.page)

# Snapshots and proposals live on the gateway, beside the active Hermes profile.
# SQLite state transitions prevent a second process/request applying twice.
def _data_dir():
    from pathlib import Path
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / 'plugin-data' / 'hermes-logseq'


@contextmanager
def _store():
    import sqlite3
    directory = _data_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(directory / 'notes.sqlite3', timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, graph TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL)')
    try:
        with db:
            yield db
    finally:
        db.close()


def _graph():
    return hashlib.sha256(_base_url().encode()).hexdigest()


def _record(identity, kind):
    if not re.fullmatch(r'[0-9a-f]{32}', identity):
        raise HTTPException(404, 'Note reference or proposal not found on this graph.')
    with _store() as db:
        row = db.execute('SELECT * FROM records WHERE id=? AND graph=? AND kind=?', (identity, _graph(), kind)).fetchone()
    if row is None:
        raise HTTPException(404, 'Note reference or proposal not found on this graph.')
    return {**json.loads(row['data']), 'id': row['id'], 'state': row['state']}


def _put(kind, data):
    import time
    import uuid
    identity = uuid.uuid4().hex
    with _store() as db:
        db.execute('INSERT INTO records VALUES (?,?,?,?,?,?)', (identity, _graph(), kind, 'pending', json.dumps(data, ensure_ascii=False), time.time_ns()))
    return _record(identity, kind)


def _transition(identity, before, after):
    with _store() as db:
        changed = db.execute('UPDATE records SET state=? WHERE id=? AND graph=? AND kind=? AND state=?', (after, identity, _graph(), 'proposal', before)).rowcount
    if not changed:
        raise HTTPException(409, 'This suggestion has already been reviewed or is being applied. Refresh to see its status.')


class ReferenceRequest(BaseModel):
    page: str = Field(min_length=1, max_length=512)
    revision: str = Field(min_length=64, max_length=64)
    block_path: str = Field(min_length=1, max_length=512, pattern=r'^\d+(?:/\d+)*$')
    expected_content: str = Field(max_length=64000)


class ProposalRequest(BaseModel):
    reference: str = Field(pattern=r'^[0-9a-f]{32}$')
    content: str = Field(min_length=1, max_length=64000)
    reason: str = Field(default='', max_length=2000)


@router.post('/references')
async def create_reference(request: ReferenceRequest):
    # Validate against the displayed revision rather than silently attaching a
    # newer block at the same position after somebody edits the graph.
    await _target(BlockEdit(**request.model_dump(), content=request.expected_content or ' '))
    return _put('reference', request.model_dump())


@router.get('/references/{identity}')
async def reference(identity: str):
    return _record(identity, 'reference')


@router.get('/proposals')
async def proposals(page: str = Query(min_length=1, max_length=512)):
    with _store() as db:
        rows = db.execute("SELECT id FROM records WHERE graph=? AND kind='proposal' AND json_extract(data, '$.page')=? ORDER BY created DESC LIMIT 50", (_graph(), page)).fetchall()
    items = [_record(row['id'], 'proposal') for row in rows]
    return {'proposals': [item for item in items if item['page'] == page][:50]}


@router.get('/proposals/{identity}')
async def proposal(identity: str):
    return _record(identity, 'proposal')


async def propose(request: ProposalRequest):
    source = _record(request.reference, 'reference')
    edit = BlockEdit(page=source['page'], revision=source['revision'], block_path=source['block_path'], expected_content=source['expected_content'], content=_content(request.content))
    await _target(edit)
    return _put('proposal', {**edit.model_dump(), 'reference': request.reference, 'reason': request.reason})


@router.post('/proposals/{identity}/reject')
async def reject_proposal(identity: str):
    _record(identity, 'proposal')
    _transition(identity, 'pending', 'rejected')
    return _record(identity, 'proposal')


@router.post('/proposals/{identity}/apply')
async def apply_proposal(identity: str):
    async with _write_lock:
        item = _record(identity, 'proposal')
        if item['state'] == 'applied':
            return await _saved(item['page'])
        if item['state'] != 'pending':
            raise HTTPException(409, 'This suggestion has already been reviewed or its write is unconfirmed. Refresh Notes.')
        edit = BlockEdit(**{key: item[key] for key in BlockEdit.model_fields})
        await _target(edit)
        _transition(identity, 'pending', 'applying')
        try:
            target = await _target(edit)
            await _upstream('POST', '/update-block', {'id': target['block/id'], 'content': edit.content})
        except Exception:
            # A disconnected response might still have reached logseqd. Never
            # offer another Apply for an outcome we cannot prove.
            _transition(identity, 'applying', 'uncertain')
            raise
        _transition(identity, 'applying', 'applied')
        return await _saved(edit.page)
