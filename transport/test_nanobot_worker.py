import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from nanobot_worker import (
    TRANSPORTS, Transport, WorkerError, config_for_runtime, restore_auth_state,
    safe_route_metadata, snapshot_auth_state, verify_upstream, wire_runtime,
)


class TransportTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.messages = []
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.transport = Transport("slack", self.root, {"U1"}, self.messages.append)
        self.msg = SimpleNamespace(
            channel="slack", sender_id="U1", chat_id="C1", content="hi",
            metadata={"message_id": "1.1", "thread_ts": "1.0", "_runtime_control": "unsafe"},
            session_key_override="slack:C1:1.0", media=[], input_role=None,
            require_existing_session=False,
        )

    async def test_ingress_requires_approved_sender_and_preserves_reply_route(self):
        await self.transport.inbound(self.msg)
        self.msg.sender_id = "U2"
        self.msg.metadata["message_id"] = "2.2"
        await self.transport.inbound(self.msg)
        self.assertEqual(len(self.messages), 2)
        self.assertEqual(self.messages[0], {"type": "status", "status": "connected"})
        msg = self.messages[1]["message"]
        self.assertEqual(msg["senderId"], "U1")
        self.assertEqual(msg["threadId"], "slack:C1:1.0")
        self.assertEqual(msg["route"], {"chatId": "C1", "senderId": "U1", "metadata": {
            "message_id": "1.1", "thread_ts": "1.0",
        }})

    async def test_replays_have_stable_ids_but_distinct_platform_messages_are_distinct(self):
        await self.transport.inbound(self.msg)
        await self.transport.inbound(self.msg)
        self.msg.metadata["message_id"] = "1.2"
        await self.transport.inbound(self.msg)
        self.assertEqual(self.messages[1]["message"]["id"], self.messages[2]["message"]["id"])
        self.assertNotEqual(self.messages[2]["message"]["id"], self.messages[3]["message"]["id"])

    async def test_attachments_never_read_outside_transport_data(self):
        with tempfile.NamedTemporaryFile(delete=False) as secret:
            secret.write(b"private")
        outside = Path(secret.name)
        self.addCleanup(outside.unlink)
        media = self.root / "media"
        media.mkdir()
        (media / "photo.png").write_bytes(b"picture")
        (media / "private.png").symlink_to(outside)
        self.msg.media = [str(media / "photo.png"), str(media / "private.png"), "https://test/file"]
        await self.transport.inbound(self.msg)
        self.assertEqual(self.messages[1]["message"]["attachments"], [{
            "name": "photo.png", "kind": "image", "mediaType": "image/png", "data": "cGljdHVyZQ==",
        }])

    async def test_restored_routes_require_the_current_allowlist(self):
        async def deliver(envelope):
            self.assertEqual(envelope["chatId"], "C1")
        self.transport.deliver = deliver
        await self.transport.inbound(self.msg)
        route = self.messages[1]["message"]["route"]
        for request_id, route_arg in [("blocked", {**route, "senderId": "U2"}), ("accepted", route)]:
            await self.transport.send({
                "requestId": request_id, "messageId": "previous-process", "route": route_arg, "text": "ok",
            })
        self.assertFalse(self.messages[2]["ok"])
        self.assertTrue(self.messages[3]["ok"])

    async def test_platform_acceptance_waits_for_durable_ack(self):
        self.transport.require_ack = True
        pending = asyncio.create_task(self.transport.inbound(self.msg))
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        message_id = self.messages[1]["message"]["id"]
        self.transport.acknowledge({"messageId": message_id, "ok": False})
        with self.assertRaisesRegex(WorkerError, "bridge-ingress-unavailable"):
            await pending
        self.assertEqual(self.transport.pending, {})

    def test_slack_only_preserves_original_origin_and_thread(self):
        route = safe_route_metadata({"slack": {
            "thread_ts": "1.0", "event": {"channel": "C01", "ts": "1.1", "token": "hidden"},
        }})
        self.assertEqual(route, {"slack": {"thread_ts": "1.0", "event": {"channel": "C01", "ts": "1.1"}}})


class ConfigAndAuthTest(unittest.TestCase):
    def test_gateway_keeps_transport_security_and_only_exact_sender_ids(self):
        config = config_for_runtime("msteams", {
            "allowFrom": ["*"], "validateInboundAuth": False, "appId": "test",
        }, {"trusted"})
        self.assertEqual(config["allowFrom"], ["trusted"])
        self.assertTrue(config["validateInboundAuth"])
        self.assertEqual(config["host"], "127.0.0.1")

    def test_auth_state_round_trip_requires_channel_specific_files(self):
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as dst:
            matrix = Path(src) / "matrix-store"
            matrix.mkdir()
            (matrix / "session.json").write_text('{"access_token":"test"}')
            (matrix / "unknown.txt").write_text("ignore")
            snapshot = snapshot_auth_state("matrix", Path(src))
            restore_auth_state("matrix", Path(dst), snapshot)
            self.assertEqual((Path(dst) / "matrix-store/session.json").read_text(), '{"access_token":"test"}')
            self.assertFalse((Path(dst) / "matrix-store/unknown.txt").exists())
            with self.assertRaises(ValueError):
                restore_auth_state("linear", Path(dst), snapshot)

    def test_linear_vault_snapshot_excludes_webhook_payloads_and_receipts(self):
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as dst:
            db = Path(src) / "linear/state.sqlite3"
            db.parent.mkdir()
            with sqlite3.connect(db) as conn:
                conn.executescript("""
                    CREATE TABLE installations (access_token TEXT);
                    INSERT INTO installations VALUES ('token');
                    CREATE TABLE webhook_events (payload TEXT);
                    INSERT INTO webhook_events VALUES ('secret message');
                    CREATE TABLE webhook_receipts (id TEXT);
                    INSERT INTO webhook_receipts VALUES ('receipt');
                """)
            conn.close()
            restore_auth_state("linear", Path(dst), snapshot_auth_state("linear", Path(src)))
            with sqlite3.connect(Path(dst) / "linear/state.sqlite3") as result:
                self.assertEqual(result.execute("SELECT access_token FROM installations").fetchall(), [("token",)])
                self.assertEqual(result.execute("SELECT * FROM webhook_events").fetchall(), [])
                self.assertEqual(result.execute("SELECT * FROM webhook_receipts").fetchall(), [])
            result.close()

    def test_manifest_matches_worker_and_native_channels(self):
        catalog = json.loads(Path(__file__).with_name("channels.json").read_text(encoding="utf-8"))
        ids = [item["id"] for item in catalog["channels"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), TRANSPORTS | {"websocket", "weixin"})


@unittest.skipUnless(os.getenv("DSH_TRANSPORT_SMOKE") == "1", "requires the pinned Python transport installation")
class PinnedRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_constructs_and_routes_replies_with_each_pinned_channel_runtime(self):
        from nanobot.bus.queue import MessageBus
        from nanobot.channels.registry import discover_plugins
        from nanobot.config.home import set_home_path
        from nanobot.config.loader import set_config_path

        verify_upstream()
        plugins = discover_plugins()
        self.assertEqual(set(plugins), TRANSPORTS | {"websocket", "weixin"})
        for name in sorted(TRANSPORTS):
            with self.subTest(channel=name), tempfile.TemporaryDirectory() as data:
                root = Path(data).resolve()
                set_home_path(root)
                set_config_path(root / "config.json")
                cls = plugins[name].load_channel_class()
                channel = cls(config_for_runtime(name, {}, {"trusted"}), MessageBus())
                out = []
                transport = Transport(name, root, {"trusted"}, out.append)
                wire_runtime(transport, channel)
                deliveries = []

                async def simulate_platform_send(message):
                    deliveries.append(message)

                channel.send = simulate_platform_send
                metadata = {"message_id": "origin", "thread_ts": "t1"}
                native_frame = None
                if name == "wecom":
                    native_frame = {"headers": {"req_id": "req"}}
                if name == "msteams":
                    metadata["msteams"] = {
                        "service_url": "https://smba.trafficmanager.net/teams", "activity_id": "origin",
                    }
                from nanobot.bus.events import InboundMessage
                await transport.inbound(
                    InboundMessage(name, "trusted", "chat", "prompt", metadata=metadata),
                    native_frame,
                )
                await transport.send({"requestId": "reply", "messageId": out[1]["message"]["id"], "text": "answer"})
                self.assertTrue(out[-1]["ok"], out[-1])
                self.assertEqual(deliveries[0].chat_id, "chat")
                self.assertEqual(deliveries[0].content, "answer")
                self.assertEqual(deliveries[0].metadata["message_id"], "origin")
                self.assertFalse(await channel._handle_message(
                    "trusted", "chat", "prompt", authorization_id="unknown-group",
                ))
                self.assertEqual(await channel.transcribe_audio(root / "voice.ogg"), "")

    @unittest.skipUnless(os.getenv("DSH_TRANSPORT_LOOPBACK") == "1", "requires loopback listening")
    async def test_worker_round_trip_uses_upstream_napcat_websocket(self):
        from websockets.asyncio.server import serve

        posted = asyncio.Future()

        async def onebot(connection):
            self.assertEqual(connection.request.headers["Authorization"], "Bearer local-test-token")
            login_request = json.loads(await connection.recv())
            self.assertEqual(login_request["action"], "get_login_info")
            await connection.send(json.dumps({
                "echo": login_request["echo"], "data": {"user_id": 99, "nickname": "Local bot"},
            }))
            for author in (44, 42):
                await connection.send(json.dumps({
                    "post_type": "message", "message_type": "private", "message_id": author,
                    "self_id": 99, "user_id": author,
                    "message": [{"type": "text", "data": {"text": "from local fixture"}}],
                }))
            reply = json.loads(await connection.recv())
            posted.set_result(reply)
            await connection.send(json.dumps({
                "echo": reply["echo"], "status": "ok", "retcode": 0, "data": {"message_id": 100},
            }))
            await connection.wait_closed()

        async with serve(onebot, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            worker = await asyncio.create_subprocess_exec(
                sys.executable, "-I", "-u", str(Path(__file__).with_name("nanobot_worker.py")),
                "--channel", "napcat", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            )

            async def write(frame):
                worker.stdin.write((json.dumps(frame) + "\n").encode())
                await worker.stdin.drain()

            async def read():
                return json.loads(await asyncio.wait_for(worker.stdout.readline(), timeout=10))

            try:
                await write({
                    "op": "start", "config": {
                        "wsUrl": f"ws://127.0.0.1:{port}", "accessToken": "local-test-token",
                    }, "allowedSenders": ["42"],
                })
                self.assertEqual(await read(), {"type": "status", "status": "connecting"})
                self.assertEqual(await read(), {"type": "status", "status": "connected"})
                inbound = (await read())["message"]
                self.assertEqual(inbound["senderId"], "42")
                self.assertEqual(inbound["text"], "from local fixture")
                await write({"op": "ack", "messageId": inbound["id"], "ok": True})
                await write({"op": "send", "requestId": "r", "messageId": inbound["id"], "text": "fixture reply"})
                reply = await asyncio.wait_for(posted, timeout=5)
                self.assertEqual(reply["action"], "send_msg")
                self.assertEqual(reply["params"]["user_id"], 42)
                self.assertEqual(reply["params"]["message"][0]["data"]["text"], "fixture reply")
                self.assertEqual(await read(), {"type": "sent", "requestId": "r", "ok": True})
                await write({"op": "stop"})
                self.assertEqual(await asyncio.wait_for(worker.wait(), timeout=8), 0)
            finally:
                if worker.returncode is None:
                    worker.kill()
                    await worker.wait()


if __name__ == "__main__":
    unittest.main()
