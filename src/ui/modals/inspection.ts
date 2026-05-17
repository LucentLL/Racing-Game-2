/**
 * Used-car pre-existing fault type.
 *
 * Originally the home of a separate inspection modal — turned out
 * the seller-visit overlay (src/ui/modals/seller.ts H185) covers
 * the full inspection flow inline alongside HAGGLE / TEST DRIVE /
 * WALK AWAY, so the standalone modal never needed to land. H236
 * shrunk this file down to just the PreFault type the seller +
 * test-drive + purchase modules consume.
 *
 * The lot-flow inspection from the monolith (L43458-43580) which
 * this file originally scaffolded is dormant — the modular runtime
 * doesn't have a separate used-car lot (cars are bought through
 * newspaper listings → pinPicker → seller-visit), so the
 * inspection step happens inline on the seller menu.
 */

/** Single pre-existing fault (from generateUsedCarFaults).
 *
 *  Consumed by:
 *    - sim/usedCarFaults.ts — produces them.
 *    - ui/modals/seller.ts — renders the KNOWN ISSUES section +
 *      handles the INSPECT button's reveal logic.
 *    - sim/sellerTestDrive.ts — rolls testDriveOnly faults at
 *      end-of-drive.
 *    - ui/modals/purchase.ts — splits preFaults into detected /
 *      hidden when completePurchase fires.  */
export interface PreFault {
  name: string;
  /** Repair tier — drives color + label. */
  tier: 'cheap' | 'moderate' | 'extensive' | 'severe';
  /** Estimated repair cost ($). */
  cost: number;
  /** True when discoverable on inspection (visible on this modal). */
  detected: boolean;
  /** True when only the test drive surfaces this fault. */
  testDriveOnly?: boolean;
  /** Per-fault override on the random-detect roll the inspect button
   *  (default 0.5) and the end-of-test-drive reveal pass (default
   *  0.4) use. Set by generateUsedCarFaults per fault type so
   *  well-disguised issues stay hidden longer. */
  detectChance?: number;
  /** Free-form fault identifier (monolith `f.id`) used by
   *  FAULT_EFFECTS lookups (FAULT_EFFECTS itself ported in H247;
   *  reads from src/sim/faultEffects.ts). The test-drive symptom
   *  stream that consumes the desc strings isn't ported yet —
   *  see sellerTestDrive.ts header. */
  id?: string;
  /** Mid-drive reveal latch — true after the symptom stream has
   *  surfaced this fault as a notif. Prevents double-reveal. */
  _revealed?: boolean;
}
