# Legacy Car Sprites

These sprites are **not referenced** by the current `src/config/cars/manifest.ts`
or by the monolith's `VEHICLE_IMAGE_MANIFEST`. They are kept here for two reasons:

1. **Rollback safety** — if a current sprite needs to be reverted, the older
   version is still on hand.
2. **Diff context** — version comments in the monolith (`v8.99.122.55` etc.)
   reference these filenames by name when explaining what was replaced.

| File | Reason it's legacy |
|---|---|
| `Dodge-Charger-69-Green.png` | Replaced by `Dodge-Charger-Orange.png` (v8.99.123.29); current sprite covers both `dodge_charger` ('70 R/T) and a future Charger entry. |
| `NSX-Red.png` | Replaced by `Acura-NSX-Red.png` (v8.99.122.84). The new sprite ships at 400×184 (cache-target size); the old one was ~1505×650. |
| `Untitled (3).png` | Old placeholder for `accord99`. Replaced by `Honda-Accord-Heather.png`. |
| `Untitled (4).png` | Was the 180SX hatchback sprite mistakenly assigned to S13 Silvia. Replaced by `Nissan-Silvia-Coupe.png` (for coupe variants) and `Nissan-180via-Yellow.png` (for hatch variants). |
| `Untitled (6).png` | Old `civic_eg` sprite. Replaced by `Untitled (7).png` per v8.99.122.26 — better proportions for the 5th-gen EG Civic. |

**Do not delete these without checking git log first** for any active references.
