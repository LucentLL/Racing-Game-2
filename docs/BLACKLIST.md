# BLACKLIST — street racing progression design

Status: DESIGN FOR APPROVAL (H1062). Sanctioned invention (story is the one
stub area per the 2026-06-13 roadmap; this is not a monolith port).
Prime reference: NFS Most Wanted 2005's blacklist, adapted for a 2D game
with no pursuit system. Grounded in a 2026-07-06 code recon — every
"exists" claim below was verified against the tree at commit 2a16c85.

## What we build on (exists today — do not reinvent)

| System | Where | State |
|---|---|---|
| Street rep ladder | `sim/streetTier.ts` | 0–100 rep, OPEN→KNOWN(25)→TRUSTED(50)→INNER CIRCLE(75), tier bet ranges, win rep gain 6/4/2/2, decay after 7 idle days |
| City 1v1 races | `sim/race.ts` | full state machine, stakes incl. **pink slips** (car/house), 3 start modes, player-exact opponent physics |
| Meet/drag/oval races | `sim/trackRace.ts` | drive-up CHALLENGE at car meets (H1034), prize money, feeds the same streetRep |
| Connections | `sim/updateConnections.ts` | `sceneRegular` milestone (15 races + rep 25) — comment says it "vouches for next tier; opens future gating" — this IS the blacklist hook |
| Player avatar | `render/characterBase.ts` | one sheet: gender × fitness build (muscular/lean/overweight), drawn 26–32px on 3 screens |
| Mail + calendar | `home/overlay.ts` MAIL tab, `sim/calendarLog.ts` | list UI + producer pattern (carAds); 'R' race event type reserved, unwired |
| Save | `save/interim.ts` | wholesale `life` JSON blob — new fields persist free; defaults in `normalizeLoadedLife` |

The gap: **opponents are anonymous**. Both race systems key opponents by
catalog car id only. Rivals need a persona layer; that is the core of this
design.

## The ladder — 10 rivals over the existing tiers

MW's triple gate, adapted (bounty is cop-currency; ours is street rep):
a rival's challenge unlocks at **wins W + milestones M + streetRep R**.
Rep decay can re-lock an *unfought* challenge; defeats are permanent.

| # | Alias | Signature car (catalog) | Venue bias | Gate: W / M / R |
|---|---|---|---|---|
| 10 | JUICE | Civic EK | drag | 3 / 0 / 10 |
| 9 | PENNY | Miata NA | oval | 4 / 1 / 18 |
| 8 | DEACON | 240SX / Silvia | city sprint | 5 / 1 / 25 |
| 7 | KAZE | RX-7 FC | drag | 7 / 2 / 33 |
| 6 | BIG SAL | Plymouth Cuda | drag | 9 / 2 / 41 |
| 5 | WRENCH | Impreza GC8 | city sprint | 11 / 3 / 50 |
| 4 | DUCHESS | S2000 '99 | oval | 13 / 3 / 58 |
| 3 | PREACHER | Supra A80 | city sprint | 15 / 4 / 66 |
| 2 | GHOST | GT-R R34 V-spec | 2-of-3 series | 18 / 5 / 75 |
| 1 | CALLAHAN | RUF CTR2 | 3-race series | 20 / 5 / 85 |

Names/cars are proposals — swap freely. Rules that matter:
- **Boss cars are genuinely unique** (one-instance-per-model rule): while a
  rival is undefeated, their signature car never appears in dealer/used
  rotation. Winning it via pink-slip marker is winning THE car.
- Each rival declares a **specialty venue**; their challenge runs on the
  existing system for that venue (trackRace for drag/oval, race.ts for city
  sprint). Ranks 2–1 are multi-race series (tournament seed — ties into the
  weekend-calendar TODO).
- Milestone types (no cops; all detectable from existing state): win at a
  meet · win by >3 s · win with lower HP than the opponent · drag ET under a
  per-tier target · win a max-bet money race · hold a 15°+ drift ≥3 s
  during a race. Config table, per-rival mix.

## Personality budget (MW's trick, PS1-cheap)

Mugshot card + signature scrawl + trash talk. No cutscenes.
- **Mugshot**: P1 renders the rival via `characterBase` (gender × build ×
  skin tone) inside the dialogue portrait slot; modular avatars upgrade this
  later for free.
- **Taunts**: templated one-liners with slots filled from the PLAYER's
  active car (`CatalogCar`: name, modelYear, hp, drv, origin, eType) and
  per-car manual flag (`carConditions[id].isManual`). The canonical example:
  `"You think you're gonna beat my {rivalCar} with that {playerCar}? Does
  it even have a manual transmission?"` — the manual clause only renders
  when the player's car is actually an automatic. 3–5 lines per rival ×
  {pre-race, player-won, player-lost}, plus generic pools.

## Dialogue box (new primitive, reused everywhere later)

PS1 anatomy per the style-guide artifact: bevelled GT2 panel, bottom
quarter of the screen, portrait slot left, amber name tag, 2–4 lines
paginated, typewriter reveal (tap = complete, tap again = next page),
blinking ▼ more-indicator. Canvas modal following the seller/realtor
phase-machine + rect-cache tap pattern. Module: `ui/modals/dialogue.ts`,
state on `life.dialogue` (JSON-safe, transient-cleared on load).

## Modular avatar scaffolding (P-last, art-gated)

`AvatarSpec { gender, build, skinTone, outfitId, accessoryIds[],
condition }` + a compositor that layers sheets in order
base → outfit → accessories → condition overlay. P1 ships the INTERFACE
with only the existing base sheet behind it (outfit/accessories no-op), so
every consumer (dialogue portraits, STATUS tab, jobSelect, future barber/
clothing shops) codes against the final shape now. `build` derives from
fitness exactly as today; `condition` (tired/bruised/fit-glow) derives from
health/gym state. New art = new sheet columns; public/ PNGs are LFS-tracked
— verify real bytes after every asset commit (pointer-file gotcha).

## Contacts & invites (believability layer, user 2026-07-01)

- Beating/racing someone can yield their **phone number** → `life.contacts`.
- Contacts send **race invites** as MAIL items (carAds producer pattern) tied
  to calendar slots; accepting jumps into the right venue (`switchMap` +
  challenge start — the H1034 flow with a specific rival id).
- Tournaments: multi-race nights/weekends on the calendar; blacklist ranks
  2–1 are the first consumers.

## Save fields (all default-safe via normalizeLoadedLife)

```ts
life.blacklist = {
  defeated: number[],        // rival ranks beaten (permanent)
  attempts: Record<number, number>,
  pinkSlipsWon: string[],    // catalog ids won from bosses
}
life.contacts = ContactEntry[]   // { rivalRank | npcId, name, obtainedDay }
```
Rival definitions live in `config/blacklist.ts` (static), NOT in the save.

## Phasing (one commit per turn, exe-testable each step)

- **BL-1**: `config/blacklist.ts` roster + BLACKLIST board screen (RACE tab
  entry): 10 mugshot cards, locked/unlocked/beaten states, gate progress
  bars. View-only.
- **BL-2**: dialogue box primitive + pre-race taunt wired into the existing
  meet CHALLENGE flow (any opponent, generic pool) — proves the primitive
  before rivals depend on it.
- **BL-3**: challenge races: board → challenge → venue race vs the rival's
  signature car with rival persona attached; defeat tracking; rep/cash
  rewards; post-race dialogue.
- **BL-4**: reward markers (pick 2 of 4: cash / unique part / rival pink
  slip / contact) + boss-car uniqueness enforcement.
- **BL-5**: contacts list UI + mail invites + first weekend tournament.
- **BL-6**: avatar compositor interface + condition overlays (art pipeline
  starts here; interface ships in BL-1 consumers as no-ops).

Design notes for later phases: the challenge resolver must stay
headless-capable (cozy-mode SIMULATE RACE H963 is unbuilt; `advanceOppPhysics`
already runs without rendering) — no rendering assumptions in win/lose logic.
