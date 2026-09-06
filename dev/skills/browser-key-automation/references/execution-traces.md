# Bounded execution traces

Use traces to explain one extension command after it returns. They are Key-owned, bounded, redacted diagnostics—not a source of page content and not a replay log.

## Get the reference

Every admitted generic CLI `call` returns:

```json
{ "trace": { "state": "complete", "traceRef": "xr1.<opaque>" } }
```

- `complete`: the terminal record was persisted; the reference is readable.
- `partial`: a reference was allocated but final persistence failed; the browser command's own result is still authoritative.
- `unavailable`: there is no response reference. Trace setup may have been unavailable, or the command was `trace.read`/`trace.export`, which are intentionally not self-traced.
- `not_admitted`: schema, authentication, or the initial permission gate rejected the request before a Key-owned run began.

Transport failures before an extension response have no extension trace. Never infer delivery or repeat an effectful command from missing trace metadata.

## Read or export

Read an exact returned reference:

```text
node client/browser-key-cli.mjs call --method trace.read --params-json '{"traceRef":"<TraceRef>"}'
```

Passing `null` (or omitting the optional field) reads the current Key's latest non-`trace.*` command. Reading and exporting return `trace.state:"unavailable"` for their own response metadata and do not replace or evict that latest business trace.

Export the same record as a Key-owned JSON Artifact:

```text
node client/browser-key-cli.mjs call --method trace.export --params-json '{"traceRef":"<TraceRef>"}'
```

Then use the ordinary `artifact-save` helper if a local file is needed, and release the temporary Artifact when finished. Both commands require `trace.read`; export deliberately has no second permission. A reference from another Key or an evicted/unknown reference returns `TRACE_NOT_FOUND` without revealing which case occurred.

## Interpret safely

A record contains bounded timestamps, terminal status, error code, a monotonic `effectEntries` count, ordered internal phase/operation/status events, optional non-secret NodeRefs, and truncation evidence. Before an effect is called, the extension makes a bounded durable checkpoint containing `effect_entered`; if the Service Worker then disappears, the unfinished record reads as `interrupted` while retaining that effect-entry fact. `succeeded`, `failed`, `unknown`, and `interrupted` describe what the extension can prove about that command. They do not prove the website's external business outcome beyond the command's own registered goal.

Retention is bounded per Key and across the whole extension instance by record count, record bytes, owner count, total JSON bytes, age, and a finite storage-I/O deadline. Old whole records are evicted first; event truncation never erases the separate `effectEntries` count.

Traces never contain the API Key or Key secret, raw params/results, JavaScript source, form values, selectors, URLs, DOM/page text, screenshots, or file bodies. Do not paste secrets into diagnostic commands expecting redaction to make that safe. Use `page.tree`, DOM reads, screenshots, or bounded Artifacts explicitly when content is required.
