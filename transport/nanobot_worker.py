"""Run one pinned nanobot channel transport against DSH's private stdio broker."""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import hashlib
import importlib
import json
import mimetypes
import os
import re
import sqlite3
import stat
import sys
import tempfile
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from importlib import metadata as package_metadata
from urllib.parse import urlsplit

MAX_FRAME = 8 * 1024 * 1024
MAX_AUTH_STATE = 2 * 1024 * 1024
MAX_MEDIA_BYTES = 1024 * 1024
MAX_REPLY_MEDIA_BYTES = 4 * 1024 * 1024
MAX_TEXT = 64 * 1024
MAX_ROUTES = 512
MAX_ROUTE_AGE = 30 * 60
UPSTREAM_COMMIT = "e76717445058f4670ac9299cc89f91504da2f5f2"
TRANSPORTS = {
    "dingtalk", "discord", "email", "feishu", "linear", "matrix", "mattermost",
    "mochat", "msteams", "napcat", "qq", "signal", "slack", "telegram", "wecom",
    "whatsapp", "whatsapp_agent",
}
ROUTE_KEYS = {
    "message_id", "origin_message_id", "event_id", "timestamp", "uid", "chat_type",
    "chat_id", "msg_type", "conversation_type", "channel_type", "thread_ts",
    "root_id", "thread_id", "message_thread_id", "is_group", "group_id", "wa_id",
    "reply_in_thread", "reply_to_message_id", "subject", "topic_id", "sender_number",
    "receive_id_type", "thread_root_id", "quoted_msg_id", "sender_name",
    "thread_root_event_id", "thread_reply_to_event_id", "parent_id", "callback_query_id",
}
ROUTE_GROUPS = {
    "linear": {
        "organization_id", "agent_session_id", "issue_id", "comment_id", "app_user_id",
        "oauth_client_id", "action", "signal", "delivery_id",
    },
    "msteams": {"activity_id", "conversation_id", "conversation_type", "service_url", "bot_id", "tenant_id"},
    "mattermost": {"root_id", "post_id", "thread_ts", "channel_type", "is_action", "is_group"},
    "slack": {"thread_ts", "channel_type"},
}
AUTH_FILES = {
    "linear": re.compile(r"linear/state\.sqlite3"),
    "whatsapp": re.compile(r"whatsapp-auth/neonize\.db"),
    "matrix": re.compile(r"matrix-store/(?:session\.json|[^/\\]{1,450}\.db)"),
}


class WorkerError(Exception):
    def __init__(self, code, status="error"):
        self.code = code
        self.status = status
        super().__init__(code)


@dataclass
class ReplyStream:
    id: str
    text: str = ""
    closed: bool = False


def attach_files(root, paths):
    media_root = root / "media"
    remaining = MAX_MEDIA_BYTES
    attachments = []
    for value in paths[:8]:
        try:
            path = Path(value).resolve(strict=True)
            if not path.is_relative_to(media_root):
                continue
            with path.open("rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= remaining:
                    continue
                data = handle.read(remaining + 1)
            if not 0 < len(data) <= remaining:
                continue
        except (OSError, TypeError, ValueError):
            continue
        remaining -= len(data)
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        attachments.append({
            "name": path.name[:255], "kind": "image" if mime.startswith("image/") else "file",
            "mediaType": mime, "data": base64.b64encode(data).decode("ascii"),
        })
    return attachments


def stage_reply_files(directory, attachments):
    if not isinstance(attachments, list) or len(attachments) > 8:
        raise ValueError("invalid attachments")
    paths = []
    remaining = MAX_REPLY_MEDIA_BYTES
    for index, file in enumerate(attachments):
        if not isinstance(file, dict):
            raise ValueError("invalid attachment")
        name, mime, data = file.get("name"), file.get("mime"), file.get("data")
        if (
            not isinstance(name, str) or not 0 < len(name.encode("utf-8")) <= 230
            or name.endswith((" ", ".")) or re.search(r'[<>:"/\\|?*\x00-\x1f\x7f]', name)
            or re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", name.split(".")[0])
            or not isinstance(mime, str) or not re.fullmatch(r"[\w.+-]+/[\w.+-]+", mime)
            or not isinstance(data, str) or len(data) > ((remaining + 2) // 3) * 4
        ):
            raise ValueError("invalid attachment")
        content = base64.b64decode(data, validate=True)
        if not 0 < len(content) <= remaining:
            raise ValueError("invalid attachment size")
        remaining -= len(content)
        folder = directory / str(index)
        folder.mkdir(mode=0o700)
        path = folder / name
        path.write_bytes(content)
        paths.append(str(path))
    return paths


def reply_buttons(options):
    rows = options.get("buttons", [])
    if (
        not isinstance(rows, list) or len(rows) > 8
        or any(not isinstance(row, list) or len(row) > 8
               or any(not isinstance(label, str) or not 0 < len(label) <= 200 for label in row)
               for row in rows)
    ):
        raise ValueError("invalid buttons")
    return rows


def safe_route_metadata(value):
    if not isinstance(value, dict):
        return {}
    def safe_value(item):
        return isinstance(item, (bool, int)) or isinstance(item, str) and len(item) <= 2048
    result = {key: item for key, item in value.items() if key in ROUTE_KEYS and safe_value(item)}
    for name, keys in ROUTE_GROUPS.items():
        fields = value.get(name)
        if isinstance(fields, dict):
            result[name] = {key: item for key, item in fields.items() if key in keys and safe_value(item)}
    slack_event = value.get("slack", {}).get("event") if isinstance(value.get("slack"), dict) else None
    if isinstance(slack_event, dict):
        result["slack"]["event"] = {
            key: slack_event[key] for key in ("channel", "ts")
            if key in slack_event and safe_value(slack_event[key])
        }
    return result


def stable_id(channel, sender, chat, metadata):
    event_id = (
        metadata.get("callback_query_id") or metadata.get("message_id") or metadata.get("event_id")
        or metadata.get("msteams", {}).get("activity_id")
        or metadata.get("linear", {}).get("delivery_id")
        or metadata.get("uid") or metadata.get("timestamp")
    )
    if not event_id:
        return uuid.uuid4().hex
    value = json.dumps([channel, sender, chat, str(event_id)], separators=(",", ":"))
    return hashlib.sha256(value.encode()).hexdigest()


def read_auth_file(path, channel):
    if path.name.endswith((".db", ".sqlite3")):
        with contextlib.closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=0.5)) as source:
            with contextlib.closing(sqlite3.connect(":memory:")) as snapshot:
                source.backup(snapshot)
                if channel == "linear":
                    snapshot.execute("DELETE FROM webhook_events")
                    snapshot.execute("DELETE FROM webhook_receipts")
                    snapshot.commit()
                    snapshot.execute("VACUUM")
                return snapshot.serialize()
    return path.read_bytes()


def snapshot_auth_state(channel, root):
    pattern = AUTH_FILES.get(channel)
    if not pattern:
        return None
    files = {}
    size = 0
    for directory in ("linear", "whatsapp-auth", "matrix-store"):
        for path in sorted((root / directory).glob("*")):
            rel = path.relative_to(root).as_posix()
            if path.is_symlink() or not pattern.fullmatch(rel) or not path.is_file():
                continue
            if path.stat().st_size > MAX_AUTH_STATE:
                raise WorkerError("auth-state-too-large")
            encoded = base64.b64encode(read_auth_file(path, channel)).decode("ascii")
            size += len(encoded)
            if size > MAX_AUTH_STATE:
                raise WorkerError("auth-state-too-large")
            files[rel] = encoded
    auth_state = json.dumps(files, separators=(",", ":")) if files else None
    if auth_state and len(auth_state) > MAX_AUTH_STATE:
        raise WorkerError("auth-state-too-large")
    return auth_state


def restore_auth_state(channel, root, snapshot):
    if not snapshot:
        return
    pattern = AUTH_FILES.get(channel)
    if not pattern or not isinstance(snapshot, str) or len(snapshot) > MAX_AUTH_STATE:
        raise ValueError("invalid auth state")
    files = json.loads(snapshot)
    if not isinstance(files, dict) or len(files) > 32:
        raise ValueError("invalid auth state")
    for rel, encoded in files.items():
        if not pattern.fullmatch(rel) or not isinstance(encoded, str):
            raise ValueError("invalid auth file")
        path = root / rel
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(encoded, validate=True))
        path.chmod(0o600)


def config_for_runtime(channel, section, allowed):
    config = {
        key: value for key, value in section.items()
        if key not in {"enabled", "allowFrom", "allow_from", "instances"}
    }
    config.update({"enabled": True, "allowFrom": sorted(allowed)})
    if channel == "msteams":
        config.pop("validate_inbound_auth", None)
        config["validateInboundAuth"] = True
        config.setdefault("host", "127.0.0.1")
    if channel == "linear":
        config.setdefault("host", "127.0.0.1")
    if channel == "telegram" and config.get("mode") == "webhook":
        if not config.get("webhookSecretToken"):
            raise WorkerError("webhook-secret-required", "auth-required")
    if channel == "matrix":
        config.setdefault("e2eeEnabled", False)
        for key in ("userId", "user_id", "deviceId", "device_id"):
            value = config.get(key)
            if isinstance(value, str) and any(character in value for character in ("/", "\\", "\x00")):
                raise WorkerError("invalid-channel-configuration")
    # Transport-owned writable files stay in the private data directory.
    for key in ("databasePath", "database_path", "stateDir", "state_dir", "mediaDir", "media_dir"):
        config.pop(key, None)
    return config


class Transport:
    def __init__(self, channel, root, allowed, emit, *, require_ack=False, instance_id=None):
        self.channel = channel
        self.instance_id = instance_id
        self.root = root.resolve()
        self.allowed = allowed
        self.emit = emit
        self.status = ""
        self.routes = OrderedDict()
        self.deliver = None
        self.require_ack = require_ack
        self.pending = {}
        self.streams = OrderedDict()

    def set_status(self, status, code=None):
        if self.status == (status, code):
            return
        self.status = (status, code)
        self.emit({"type": "status", "status": status, **({"code": code} if code else {})})

    async def inbound(self, msg, native_route=None):
        if (
            msg.channel not in {self.channel, self.runtime_name} or str(msg.sender_id) not in self.allowed
            or msg.input_role not in (None, "user")
            or not msg.chat_id or len(msg.chat_id) > 2048
        ):
            return
        metadata = safe_route_metadata(msg.metadata)
        if self.channel == "slack" and not metadata.get("message_id"):
            slack = msg.metadata.get("slack", {})
            event = slack.get("event", {}) if isinstance(slack, dict) else {}
            if isinstance(event, dict) and isinstance(event.get("ts"), str):
                metadata["message_id"] = event["ts"][:128]
        route = {"chatId": msg.chat_id, "senderId": str(msg.sender_id), "metadata": metadata}
        if self.instance_id is not None:
            route["instanceId"] = self.instance_id
        message_id = stable_id(self.runtime_name, route["senderId"], msg.chat_id, metadata)
        self.routes.pop(message_id, None)
        self.routes[message_id] = (time.monotonic(), route, native_route)
        if len(self.routes) > MAX_ROUTES:
            self.routes.popitem(last=False)
        self.set_status("connected")
        message = {
            "id": message_id, "senderId": route["senderId"], "chatId": msg.chat_id,
            "text": str(msg.content).replace(str(self.root), "[channel attachment]")[:MAX_TEXT],
            "route": route,
        }
        if self.instance_id is not None:
            message["instanceId"] = self.instance_id
        mattermost = metadata.get("mattermost", {})
        if msg.require_existing_session or metadata.get("callback_query_id") or mattermost.get("is_action") is True:
            message["requireExistingSession"] = True
        if isinstance(msg.session_key_override, str):
            message["threadId"] = msg.session_key_override[:2048]
        attachments = attach_files(self.root, msg.media or [])
        if attachments:
            message["attachments"] = attachments
        if not self.require_ack:
            self.emit({"type": "message", "message": message})
            return
        ack = self.pending.get(message_id)
        if ack:
            if not await asyncio.shield(ack):
                raise WorkerError("bridge-ingress-unavailable")
            return
        if len(self.pending) >= 32:
            raise WorkerError("bridge-backpressure")
        ack = asyncio.get_running_loop().create_future()
        self.pending[message_id] = ack
        try:
            self.emit({"type": "message", "message": message})
            if not await asyncio.wait_for(asyncio.shield(ack), timeout=45):
                raise WorkerError("bridge-ingress-unavailable")
        finally:
            self.pending.pop(message_id, None)
            if not ack.done():
                ack.cancel()

    @property
    def runtime_name(self):
        return f"{self.channel}.{self.instance_id}" if self.instance_id is not None else self.channel

    def acknowledge(self, command):
        message_id = command.get("messageId")
        if isinstance(message_id, str):
            ack = self.pending.get(message_id)
            if ack is not None and not ack.done():
                ack.set_result(command.get("ok") is True)

    async def send(self, command):
        req = command.get("requestId")
        message_id = command.get("messageId")
        text = command.get("text")
        if not isinstance(req, str) or not 0 < len(req) <= 200:
            return
        def sent(ok, code=None):
            self.emit({"type": "sent", "requestId": req, "ok": ok, **({"code": code} if code else {})})
        attachments = command.get("attachments", [])
        options = command.get("metadata") or {}
        update = command.get("type") if command.get("op") == "update" else None
        if (
            not isinstance(message_id, str) or not 0 < len(message_id) <= 512
            or not isinstance(text, str) or len(text) > MAX_TEXT
            or not isinstance(options, dict) or not isinstance(attachments, list)
            or (command.get("op") == "update" and update not in ("delta", "progress", "tool", "reasoning"))
            or (update is not None and (not text or attachments))
        ):
            sent(False, "invalid-reply")
            return
        origin_id = command.get("originId")
        cached = self.routes.get(origin_id if isinstance(origin_id, str) else message_id)
        recent = cached and time.monotonic() - cached[0] < MAX_ROUTE_AGE
        route = cached[1] if recent else command.get("route")
        if not self.deliver or not isinstance(route, dict):
            sent(False, "reply-route-unavailable")
            return
        sender_id = route.get("senderId")
        chat_id = route.get("chatId")
        if (
            route.get("instanceId") != self.instance_id
            or not isinstance(sender_id, str) or sender_id not in self.allowed
            or not isinstance(chat_id, str) or not 0 < len(chat_id) <= 2048
        ):
            sent(False, "reply-route-invalid")
            return
        with contextlib.ExitStack() as stack:
            try:
                buttons = reply_buttons(options) if update is None else []
                if not text and not attachments and not any(buttons):
                    raise ValueError("empty reply")
                media = []
                if attachments:
                    folder = stack.enter_context(tempfile.TemporaryDirectory(prefix="reply-", dir=self.root))
                    media = stage_reply_files(Path(folder), attachments)
            except (ValueError, OSError):
                sent(False, "invalid-reply")
                return
            try:
                await asyncio.wait_for(self.deliver({
                    "messageId": message_id, "chatId": chat_id, "text": text,
                    "metadata": safe_route_metadata(route.get("metadata")),
                    "nativeRoute": cached[2] if recent else None,
                    "options": options, "media": media, "buttons": buttons, "update": update,
                }), timeout=45)
            except Exception as exc:
                code = {
                    "DeliveryRejectedError": "delivery-rejected",
                    "ChannelNotReadyError": "channel-not-ready",
                }.get(type(exc).__name__, "delivery-uncertain")
                sent(False, code)
            else:
                if update is None:
                    self.streams.pop(message_id, None)
                sent(True)


# A started task is not a connection. These callbacks or live properties are
# tied to the pinned transport's actual protocol exchange.
LOGGER_READY = {
    "linear": ("Linear webhook listening",),
    "mattermost": ("websocket connected",),
    "napcat": ("napcat: logged in as",),
    "qq": ("QQ bot ready:",),
    "signal": ("Subscribed to Signal messages via SSE",),
    "wecom": ("authenticated successfully",),
}
LOGGER_DISCONNECTED = {
    "mattermost": ("websocket error:",),
    "napcat": ("napcat: connection lost:",),
    "qq": ("QQ bot network error", "QQ bot WebSocket error"),
    "signal": ("Signal channel error:", "signal-cli daemon not responding"),
    "wecom": ("WebSocket disconnected:",),
}
LOGGER_AUTH_FAILURE = {
    "matrix": ("Authentication failed irrecoverably", "Failed to log in:"),
    "slack": ("auth_test failed:",),
    "telegram": ("bot token rejected by Telegram",),
}


def websocket_open(sock):
    return bool(sock and getattr(getattr(sock, "state", None), "name", "") == "OPEN")


def wire_runtime(transport, channel):
    """Maintain platform routing, while keeping admission and agent work in DSH."""
    from loguru import logger
    from nanobot.bus.delivery import DeliveryRejectedError
    from nanobot.bus.events import InboundMessage, OutboundMessage
    from nanobot.bus.outbound_events import ProgressEvent
    from nanobot.channels.base import BaseChannel

    upstream_is_allowed = channel.is_allowed

    def is_allowed(subject):
        identifier = str(subject)
        if transport.channel == "linear":
            try:
                _, sender = json.loads(identifier)
            except (TypeError, ValueError):
                return False
            # Upstream checks installation and current workspace membership.
            return isinstance(sender, str) and sender in transport.allowed and upstream_is_allowed(subject)
        return identifier in transport.allowed

    async def handle_message(sender_id, chat_id, content, media=None, metadata=None,
                             session_key=None, is_dm=False, authorization_id=None,
                             require_existing_session=False, session_generation=None):
        if str(sender_id) not in transport.allowed:
            return False
        if authorization_id is not None and not is_allowed(authorization_id):
            return False
        native_route = None
        metadata = dict(metadata or {})
        if metadata.get("is_callback") is True:
            require_existing_session = True
        if transport.channel == "msteams":
            with channel._refs_guard:
                ref = channel._conversation_refs.get(str(chat_id))
            if ref:
                route_metadata = metadata.get("msteams", {})
                metadata["msteams"] = {
                    **route_metadata, "service_url": ref.service_url,
                    "bot_id": ref.bot_id, "tenant_id": ref.tenant_id,
                }
        elif transport.channel == "wecom":
            native_route = channel._chat_frames.get(str(chat_id))
        await transport.inbound(InboundMessage(
            channel=channel.name, sender_id=str(sender_id), chat_id=str(chat_id),
            content=content, media=media or [], metadata=metadata,
            session_key_override=session_key, require_existing_session=require_existing_session,
        ), native_route)
        return True

    async def no_transcription(_path):
        # This transport process never calls nanobot's model providers.
        return ""

    async def deliver(route):
        chat, metadata = route["chatId"], route["metadata"]
        update = route["update"]
        text = route["text"]
        options = route["options"]
        message_id = route["messageId"]
        if route["media"] and transport.channel in {"mochat", "msteams"}:
            raise DeliveryRejectedError("This adapter cannot upload a local attachment")
        stream_id = options.get("streamId")
        if not isinstance(stream_id, str) or not 0 < len(stream_id) <= 200:
            stream_id = message_id
        if update == "delta":
            if type(channel).send_delta is not BaseChannel.send_delta:
                stream = transport.streams.get(message_id) or ReplyStream(stream_id)
                if stream.closed:
                    return
                await channel.send_delta(chat, text, metadata, stream_id=stream.id)
                stream.text = (stream.text + text)[:MAX_TEXT]
                transport.streams[message_id] = stream
                transport.streams.move_to_end(message_id)
                if len(transport.streams) > MAX_ROUTES:
                    transport.streams.popitem(last=False)
            return
        if update == "reasoning":
            message = OutboundMessage(
                channel=channel.name, chat_id=chat, content=text, metadata=metadata,
                event=ProgressEvent(content=text, reasoning=True, stream_id=stream_id),
            )
            await channel.send_reasoning(message)
            return
        event = None
        if update in ("progress", "tool"):
            event = ProgressEvent(content=text, tool_hint=update == "tool")
        elif message_id in transport.streams:
            stream = transport.streams[message_id]
            streamed = stream.text.lstrip()
            complete = text.rstrip() == streamed.rstrip() or text.startswith(streamed)
            if not stream.closed:
                if text.startswith(streamed) and text != streamed:
                    await channel.send_delta(chat, text[len(streamed):], metadata, stream_id=stream.id)
                    stream.text = text
                await channel.send_delta(chat, "", metadata, stream_id=stream.id, stream_end=True)
                stream.closed = True
            if complete:
                text = ""
                if not route["media"] and not any(route["buttons"]):
                    return
        if transport.channel == "email":
            # Email keeps reply headers by sender. Restore them per message so
            # interleaved messages cannot pick up a newer email's headers.
            channel._last_subject_by_chat[chat] = metadata.pop("subject", "")
            message_id = metadata.get("message_id")
            if message_id:
                channel._last_message_id_by_chat[chat] = message_id
            else:
                channel._last_message_id_by_chat.pop(chat, None)
        reply_to = None
        if transport.channel == "mochat" and metadata.get("message_id"):
            reply_to = str(metadata["message_id"])
        buttons = route["buttons"]
        if any(buttons) and transport.channel not in {"linear", "slack", "telegram"}:
            labels = "\n".join(" ".join(f"[{label}]" for label in line) for line in buttons if line)
            text = "\n\n".join(part for part in (text, labels) if part)
            buttons = []
        message = OutboundMessage(
            channel=channel.name, chat_id=chat, content=text, metadata=metadata, reply_to=reply_to,
            media=route["media"], buttons=buttons, event=event,
        )
        if transport.channel == "msteams":
            from nanobot.channels.msteams.runtime import ConversationRef

            teams = metadata.get("msteams", {})
            service_url = teams.get("service_url")
            if not isinstance(service_url, str) or not channel._is_trusted_service_url(service_url):
                raise DeliveryRejectedError("Teams conversation route unavailable")
            ref = ConversationRef(
                service_url=service_url, conversation_id=chat,
                bot_id=teams.get("bot_id"), activity_id=teams.get("activity_id"),
                conversation_type=teams.get("conversation_type"), tenant_id=teams.get("tenant_id"),
                updated_at=time.time(),
            )
            with channel._refs_guard:
                channel._conversation_refs[chat] = ref
        if transport.channel == "wecom":
            proactive = options.get("proactive") is True
            frame = None if proactive else route["nativeRoute"]
            if frame is None and not proactive:
                raise DeliveryRejectedError("WeCom message-scoped reply context expired")
            previous = channel._chat_frames.get(chat)
            if frame is not None:
                channel._chat_frames[chat] = frame
            else:
                channel._chat_frames.pop(chat, None)
            try:
                await channel.send(message)
            finally:
                if channel._chat_frames.get(chat) is frame:
                    if previous is not None:
                        channel._chat_frames[chat] = previous
                    else:
                        channel._chat_frames.pop(chat, None)
            return
        await channel.send(message)

    channel.is_allowed = is_allowed
    channel._handle_message = handle_message
    channel.transcribe_audio = no_transcription
    transport.deliver = deliver

    name = transport.channel
    loop = asyncio.get_running_loop()

    def status_from_record(message):
        record = message.record
        if not record["name"] or record["name"] != f"nanobot.channels.{name}.runtime":
            return
        text = record["message"]
        if text.startswith(LOGGER_AUTH_FAILURE.get(name, ())):
            loop.call_soon_threadsafe(transport.set_status, "auth-required", "platform-auth-rejected")
        elif text.startswith(LOGGER_READY.get(name, ())):
            if name == "napcat" and not re.search(r"\(user_id=[0-9]+\)$", text):
                return
            loop.call_soon_threadsafe(transport.set_status, "connected")
        elif text.startswith(LOGGER_DISCONNECTED.get(name, ())):
            loop.call_soon_threadsafe(transport.set_status, "connecting", "connection-lost")

    # No upstream log, stack trace, host path, or credential goes to the app.
    logger.remove()
    logger.add(status_from_record, level="DEBUG", catch=False)

    if name == "email":
        open_inbox = channel._open_imap_client

        def track_imap(*args, **kwargs):
            try:
                client = open_inbox(*args, **kwargs)
            except Exception:
                loop.call_soon_threadsafe(transport.set_status, "connecting", "imap-unavailable")
                raise
            if client:
                loop.call_soon_threadsafe(transport.set_status, "connected")
            return client

        channel._open_imap_client = track_imap
    if name == "whatsapp_agent":
        poll = channel._poll_once

        async def track_poll():
            try:
                batch = await poll()
            except Exception:
                transport.set_status("connecting", "poll-unavailable")
                raise
            transport.set_status("connected")
            return batch

        channel._poll_once = track_poll
    if name == "matrix":
        on_sync = channel._on_sync_invite_fallback

        async def track_sync(response):
            transport.set_status("connected")
            await on_sync(response)

        channel._on_sync_invite_fallback = track_sync
    if name == "mochat":
        post_json = channel._post_json

        async def track_mochat(path, payload):
            result = await post_json(path, payload)
            # _post_json returns only successful, authenticated operations.
            transport.set_status("connected")
            return result

        channel._post_json = track_mochat
    if name == "napcat":
        dispatch_message = channel._on_message

        async def handle_napcat_message(event):
            if str(event.get("user_id", "")) in transport.allowed:
                await dispatch_message(event)

        channel._on_message = handle_napcat_message


async def monitor(transport, channel, sync_auth):
    now = time.monotonic()
    next_auth_snapshot = now + 5
    connecting_since = now
    next_teams_probe = 0
    while True:
        await asyncio.sleep(1)
        name = transport.channel
        client = getattr(channel, "_client", None)
        ready = None
        if name == "dingtalk":
            ready = websocket_open(getattr(client, "websocket", None))
        elif name == "discord":
            ready = bool(client and client.is_ready() and not client.is_closed())
        elif name == "feishu":
            ready = websocket_open(getattr(channel._ws_client, "_conn", None))
        elif name == "msteams" and channel._server_thread and channel._server_thread.is_alive():
            if time.monotonic() >= next_teams_probe and transport.status[0] != "connected":
                next_teams_probe = time.monotonic() + 30
                try:
                    ready = bool(await asyncio.wait_for(channel._get_access_token(), timeout=15))
                except Exception as exc:
                    if getattr(getattr(exc, "response", None), "status_code", None) in {400, 401, 403}:
                        transport.set_status("auth-required", "platform-auth-rejected")
                    else:
                        transport.set_status("connecting", "platform-unavailable")
        elif name == "napcat" and not websocket_open(channel._ws):
            ready = False
        elif name == "slack":
            socket = channel._socket_client
            ready = bool(channel._bot_user_id and socket and await socket.is_connected())
        elif name == "telegram":
            ready = channel._app_ready.is_set()
        elif name == "whatsapp":
            ready = channel._connected
        if ready:
            transport.set_status("connected")
        elif ready is False and transport.status[0] == "connected":
            transport.set_status("connecting", "connection-lost")
            connecting_since = time.monotonic()
        now = time.monotonic()
        if transport.status[0] == "connected":
            connecting_since = now
        elif transport.status[0] == "connecting" and now - connecting_since >= 60:
            transport.set_status("error", "connection-unverified")
        if now >= next_auth_snapshot:
            await sync_auth()
            next_auth_snapshot = now + 15


def valid_login_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        return False
    url = urlsplit(value)
    return url.scheme == "https" and url.hostname == "linear.app" and not url.username and not url.password


async def run_login(channel, plugin, config, network, emit):
    # Upstream ConnectStore uses Config only to read these two channel fields.
    # Supply the in-memory vault values without serializing configuration to disk.
    module = importlib.import_module(plugin.connector.split(":", 1)[0])
    module.load_config = lambda: SimpleNamespace(
        channels=SimpleNamespace(model_extra={channel: config}, **{channel: config}),
        network=network,
    )
    store = plugin.load_connector()
    session = ""
    last = None
    try:
        update = await store.handle("start", {})
        session = update.get("session_id", "")
        while update.get("status") == "pending":
            presentation = {}
            if channel == "linear" and valid_login_url(update.get("authorization_url")):
                presentation["authorizationUrl"] = update["authorization_url"]
            qr = update.get("qr_url")
            if channel == "whatsapp" and isinstance(qr, str) and re.fullmatch(r"data:image/png;base64,[A-Za-z0-9+/=]{1,150000}", qr):
                presentation["qrUrl"] = qr
            if presentation and presentation != last:
                emit({"type": "login", **presentation})
                last = presentation
            await asyncio.sleep(1.5)
            update = await store.handle("poll", {"session_id": [session]})
        if update.get("status") != "succeeded":
            raise WorkerError("platform-login-failed", "auth-required")
    except WorkerError:
        raise
    except Exception as exc:
        raise WorkerError("platform-login-failed", "auth-required") from exc
    finally:
        if last:
            emit({"type": "login"})
        if session:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(store.handle("cancel", {"session_id": [session]}), timeout=12)


def verify_upstream():
    try:
        from nanobot.build_info import COMMIT

        package = package_metadata.distribution("nanobot-ai")
    except (ImportError, package_metadata.PackageNotFoundError) as exc:
        raise WorkerError("upstream-missing") from exc
    if COMMIT == UPSTREAM_COMMIT:
        return
    try:
        direct_url = json.loads(package.read_text("direct_url.json") or "{}")
    except ValueError as exc:
        raise WorkerError("upstream-version") from exc
    url = direct_url.get("url", "")
    if url in {
        f"https://codeload.github.com/HKUDS/nanobot/tar.gz/{UPSTREAM_COMMIT}",
        f"https://github.com/HKUDS/nanobot/archive/{UPSTREAM_COMMIT}.tar.gz",
    }:
        return
    if (
        url == "https://github.com/HKUDS/nanobot.git"
        and direct_url.get("vcs_info", {}).get("commit_id") == UPSTREAM_COMMIT
    ):
        return
    raise WorkerError("upstream-version")


async def channel_runtime(transport, startup):
    verify_upstream()
    try:
        from nanobot.bus.queue import MessageBus
        from nanobot.channels.registry import load_channel_plugin
        from nanobot.config.home import set_home_path
        from nanobot.config.loader import set_config_path
        from nanobot.config.network import NetworkConfig
    except ImportError as exc:
        raise WorkerError("worker-dependencies-missing") from exc

    name, root = transport.channel, transport.root
    set_home_path(root)
    set_config_path(root / "config.json")
    section = config_for_runtime(name, startup["config"], transport.allowed)
    try:
        restore_auth_state(name, root, startup.get("authState"))
    except (ValueError, OSError) as exc:
        raise WorkerError("invalid-vault-auth-state", "auth-required") from exc
    plugin = load_channel_plugin(name)
    try:
        proxy = section.pop("proxyUrl", None)
        if proxy and (not isinstance(proxy, str) or "${" in proxy):
            raise ValueError("invalid proxy URL")
        network = NetworkConfig(proxy=proxy)
        cls = plugin.load_channel_class()
        bus = MessageBus()
        bus.publish_inbound = transport.inbound
        options = {"network": network} if cls.uses_shared_proxy else {}
        channel = cls(section, bus, **options)
        if transport.instance_id is not None:
            channel.name = transport.runtime_name
    except ImportError as exc:
        raise WorkerError("channel-dependencies-missing") from exc
    except (TypeError, ValueError) as exc:
        raise WorkerError("invalid-channel-configuration") from exc

    wire_runtime(transport, channel)
    last_auth = startup.get("authState")

    async def sync_auth():
        nonlocal last_auth
        if name not in AUTH_FILES:
            return
        try:
            updated = await asyncio.to_thread(snapshot_auth_state, name, root)
        except (OSError, sqlite3.Error, WorkerError):
            # The connection must not be presented as durable if updated
            # credentials cannot be handed to the vault.
            transport.emit({"type": "diagnostic", "code": "auth-state-unavailable"})
            return
        if updated and updated != last_auth:
            transport.emit({"type": "auth-state", "authState": updated})
            last_auth = updated

    if name in {"whatsapp", "linear"}:
        if not last_auth and not startup.get("login"):
            raise WorkerError("platform-login-required", "auth-required")
        if startup.get("login"):
            transport.set_status("auth-required", "platform-login-pending")
            await run_login(name, plugin, section, network, transport.emit)
            await sync_auth()
            if not last_auth:
                raise WorkerError("auth-state-unavailable", "auth-required")
            transport.set_status("connecting")

    health = asyncio.create_task(monitor(transport, channel, sync_auth))
    try:
        await channel.start()
        if name == "matrix" and channel._sync_task:
            await channel._sync_task
        if transport.status[0] == "auth-required":
            raise WorkerError("platform-auth-rejected", "auth-required")
        raise WorkerError("channel-stopped")
    except WorkerError:
        raise
    except Exception as exc:
        error_type = type(exc).__name__
        if error_type in {"WhatsAppAgentAuthError", "InvalidToken", "LoginFailure"}:
            raise WorkerError("platform-auth-rejected", "auth-required") from exc
        if error_type in {"WhatsAppDependencyError", "ImportError", "ModuleNotFoundError"}:
            raise WorkerError("channel-dependencies-missing") from exc
        raise WorkerError("channel-start-failed") from exc
    finally:
        health.cancel()
        await asyncio.gather(health, return_exceptions=True)
        if channel.is_running:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(channel.stop(), timeout=10)
        await sync_auth()


def read_commands(loop, queue, stdin):
    """A daemon reader lets the process stop even on a blocked stdio pipe."""
    while True:
        try:
            raw = stdin.readline(MAX_FRAME + 1)
            item = json.loads(raw) if 0 < len(raw) <= MAX_FRAME else None
            if not isinstance(item, dict):
                item = None
        except (ValueError, OSError):
            item = None
        try:
            asyncio.run_coroutine_threadsafe(queue.put(item), loop).result()
        except (RuntimeError, asyncio.CancelledError):
            return
        if item is None or item.get("op") == "stop":
            return


async def run(channel, root, emit):
    import threading

    queue = asyncio.Queue(maxsize=16)
    reader = threading.Thread(
        target=read_commands, args=(asyncio.get_running_loop(), queue, sys.stdin.buffer),
        daemon=True,
    )
    reader.start()
    startup = await queue.get()
    if startup is None or startup.get("op") != "start":
        raise WorkerError("worker-start-required")
    allowed = startup.get("allowedSenders")
    if (
        not isinstance(startup.get("config"), dict) or not isinstance(allowed, list)
        or not 0 < len(allowed) <= 1000
        or not all(isinstance(sender, str) and 0 < len(sender) <= 2048 and sender != "*" for sender in allowed)
    ):
        raise WorkerError("invalid-channel-configuration")
    instance_id = startup.get("instanceId")
    if instance_id is not None and (
        channel != "feishu" or not isinstance(instance_id, str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", instance_id)
    ):
        raise WorkerError("invalid-channel-configuration")
    transport = Transport(
        channel, root, frozenset(allowed), emit, require_ack=True,
        instance_id=instance_id,
    )
    transport.set_status("connecting")
    lifecycle = asyncio.create_task(channel_runtime(transport, startup))
    next_command = asyncio.create_task(queue.get())
    dispatch = None
    try:
        while True:
            pending = {lifecycle, next_command}
            if dispatch:
                pending.add(dispatch)
            ready, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            if lifecycle in ready:
                await lifecycle
                break
            if dispatch and dispatch in ready:
                await dispatch
                dispatch = None
            if next_command in ready:
                command = next_command.result()
                if command is None or command.get("op") == "stop":
                    break
                if command.get("op") in ("send", "update"):
                    if dispatch:
                        emit({"type": "sent", "requestId": command.get("requestId"), "ok": False, "code": "send-busy"})
                    else:
                        dispatch = asyncio.create_task(transport.send(command))
                elif command.get("op") == "ack":
                    transport.acknowledge(command)
                next_command = asyncio.create_task(queue.get())
    finally:
        pending = [task for task in (next_command, dispatch, lifecycle) if task and not task.done()]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", required=True, choices=sorted(TRANSPORTS))
    parser.add_argument("--runtime-dir", type=Path)
    args = parser.parse_args()
    # Some upstream dependencies print directly or enable stdlib logging.
    # Preserve one dedicated protocol FD before redirecting both output streams.
    output = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    with open(os.devnull, "w") as null:
        os.dup2(null.fileno(), 1)
        os.dup2(null.fileno(), 2)
    os.umask(0o077)

    def emit(event):
        line = json.dumps(event, ensure_ascii=True, separators=(",", ":"))
        if len(line) <= MAX_FRAME:
            output.write(line + "\n")

    data_directory = (
        contextlib.nullcontext(args.runtime_dir)
        if args.runtime_dir else tempfile.TemporaryDirectory(prefix="dsh-channel-")
    )
    with data_directory as data:
        try:
            directory = Path(data).resolve(strict=True)
            if not directory.is_dir() or (os.name != "nt" and directory.stat().st_mode & 0o077):
                raise WorkerError("invalid-runtime-directory")
            os.chdir(directory)
            asyncio.run(run(args.channel, directory, emit))
        except WorkerError as exc:
            emit({"type": "status", "status": exc.status, "code": exc.code})
            return 1
        except Exception:
            emit({"type": "status", "status": "error", "code": "worker-failed"})
            return 1
        finally:
            output.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
