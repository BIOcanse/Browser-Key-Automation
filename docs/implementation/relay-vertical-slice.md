# Relay vertical slice

This slice is running code and now routes Key-authenticated extension commands without owning their authorization.

- The relay binds only `127.0.0.1:32189`.
- `/v1/extension` and `/v1/client` use distinct WebSocket subprotocols.
- Application data is one uncompressed binary WebSocket message containing UTF-8 JSON.
- The relay sends the first protocol hello. A peer must then send the exact role hello before it is registered.
- Only the relay creates `relayEpoch` and monotonically increasing `instanceNumber` values. The extension sees the epoch in the protocol hello but receives no instance number and owns no InstanceRef.
- A disconnected extension retries forever at the generated 10,000 ms cadence. Connection/application handshake has its own generated 10,000 ms deadline. Failure closes that socket and schedules one retry; business requests are not replayed.
- Client-local operations are `instances.list` and `relay.stop`. `forward` routes a closed target envelope plus opaque auth/command payload to one live extension; all 39 current commands are authenticated and executed only by that extension. The relay does not parse or authorize their business semantics.

Extension teardown first unregisters and synchronizes its writer, then fails existing routes. New writes cannot escape the final route scan. The native client gives socket closure a bounded 250 ms grace before destroying its own connection; an unanswered call can report delivery unknown and actually exit.

The manifest carries a fixed public key, so Chromium derives one deterministic extension ID in unpacked runtime tests. The generator projects that exact `chrome-extension://<id>` Origin into Zig, and the relay rejects every other extension-shaped Origin. This is a transport endpoint gate, not a second business identity; Key authorization remains extension-owned. Packed artifact verification is still a separate future release gate.

Every inbound application message carries the transport worker's connection generation through the offscreen/background round trip. A response is sent only if that exact generation is still the active socket, so an old asynchronous result cannot be redirected into a restarted relay that reused a route number.

This slice deliberately rejects text frames, fragmentation, compression negotiation, non-canonical lengths, wrong masking, RSV bits, and messages over 64 KiB. Later routing work may raise generated limits but must not loosen the frame state machine implicitly.
