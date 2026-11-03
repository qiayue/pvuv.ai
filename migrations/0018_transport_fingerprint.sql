-- ============================================================================
-- Transport-layer fingerprint columns (JA4-INSPIRED, OWN IMPLEMENTATION — the
-- JA4+ suite itself is under the FoxIO license; nothing here implements it).
--
--   tls_fp        — keyed hash of tlsVersion|tlsCipher|tlsClientExtensionsSha1|
--                   tlsClientHelloLength|httpProtocol from request.cf. Server-
--                   observed and spoof-resistant from JS; the strongest single
--                   signal against HTTP-level bots and the session-linking key
--                   for low-and-slow attacks rotating residential IPs.
--   tcp_rtt       — smoothed TCP RTT to the edge (ms). Cross-checked against
--                   IP geolocation it exposes proxy chains (nearby IP with a
--                   long RTT = traffic relayed through somewhere else).
--   http_protocol — negotiated protocol. A modern Chromium UA speaking
--                   HTTP/1.x is a transport/UA contradiction (evidence-only
--                   flag 0x100000 until validated; see config.example.toml).
--
-- This migration alters the initial partition it can name; all other
-- partitions are repaired by shared/events.ts EVENT_LATE_COLUMNS.
-- ============================================================================

ALTER TABLE events_202607 ADD COLUMN tls_fp TEXT;
ALTER TABLE events_202607 ADD COLUMN tcp_rtt INTEGER;
ALTER TABLE events_202607 ADD COLUMN http_protocol TEXT;
