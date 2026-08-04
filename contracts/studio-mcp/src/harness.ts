/**
 * What a Studio implementation must give the conformance suite in order to be checked.
 *
 * The suite drives the MCP wire and nothing else — it discovers the endpoint from the published
 * handle, authenticates with the published bearer, and calls tools. Two things it cannot reach over
 * that wire, and both are here rather than reached around:
 *
 *  1. STARTING the implementation. Every implementation boots differently (an Electron app, a headless
 *     CLI host, something else later). The contract does not care how, only that a handle appears.
 *
 *  2. The HUMAN's half of the two turn-based properties. `not_holder` only exists because a human can
 *     take the wheel, and a private-address grant only exists because a human can give it. Neither is
 *     agent-reachable — that is the point of them — so an implementation has to expose its own human
 *     seam for the suite to act as the human. An implementation that made either of these reachable
 *     from the agent wire would be broken in the way these properties exist to prevent.
 *
 * Keeping exactly those three behind an interface is what makes the suite portable: everything else it
 * asserts, it observes through the same endpoint an agent uses.
 */
export interface StudioUnderTest {
  /** Names the implementation in failure messages. */
  readonly name: string;

  /**
   * Boot it and return the data dir it publishes its discovery handle under. Must resolve only once
   * the implementation is up; the suite polls for the handle itself (the handle appearing LAST, after
   * the host is wired, is a contract property it checks).
   */
  start(): Promise<{ dataDir: string }>;

  /** Shut it down and clean up. Must not throw on an already-dead implementation. */
  stop(): Promise<void>;

  /**
   * Act as the human taking the wheel on the live session, so the agent's next act must be refused
   * `not_holder`. Resolves once the flip has been applied.
   */
  humanTakesControl(): Promise<void>;

  /**
   * Act as the human granting this session access to private/loopback addresses, so the fixture page
   * served on 127.0.0.1 becomes navigable. Cloud-metadata must STAY blocked after this — the suite
   * asserts exactly that, which is why the grant is part of the harness rather than avoided.
   */
  humanGrantsPrivateAddresses(): Promise<void>;
}
