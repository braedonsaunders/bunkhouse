/**
 * The typed desk event stream and the ports a consumer supplies.
 *
 * AppKit owns the mechanism of running a desk; the consumer owns the record.
 * Every governed thing that happens on a desk is delivered to `onEvent` as one
 * member of a closed union so the consumer's append-only ledger can persist it
 * without inventing its own taxonomy. Handover boundaries additionally reach
 * the `audit` port — and, while a handover is active, they are the *only*
 * thing that reaches any port. See the masking contract on `DeskPorts`.
 */
export {};
//# sourceMappingURL=events.js.map