# TANTIVY

Isometric horse racer. A point-to-point flight to sanctuary — the Wild Hunt sweeps
the road behind the field, and its dread bleeds the stamina of whoever trails.
**Ride hard. Reach the bells. Don't be last when the horns sound.**

v0.2: full loop (riding model + 3 AI rivals + the Hunt) on one 807m fenced
steeplechase. Home menu, guided tutorial, settings with rebindable keys, pause,
rotatable camera (Q/E, 90° stops), horse-vs-horse collision, and a hazard set:
mud bogs, jumpable fallen logs, cross-fence gates with flagged gaps, and deer
that burst across the road. Storybook painterly, Three.js fixed-iso, no build step.

## Run

```
python serve.py 5815
```

Then open http://localhost:5815 (or `preview_start` name `tantivy`).
The dev server sends no-store on everything — plain `http.server` lets Chrome
cache stale modules.

## Controls (rebindable in Settings; arrows always work as fallback)

- **W/S** or **↑/↓** — gait up / down (walk · trot · canter · gallop)
- **A/D** or **←/→** — steer
- **Space** — jump brooks and logs (canter or better)
- **Q/E** — rotate the camera in 90° steps
- **Esc/P** — pause · **R** — restart

## The three riding systems (the pillars)

1. **Gait ladder** — discrete speed states, no throttle. Each gait is a speed
   AND a handling class; gallop turns wide (commitment cornering).
2. **Stamina economy** — gallop spends (−6/s, much worse uphill), canter is the
   sustainable cruise (0/s), trot recovers (+4/s). Blown at 0 → forced trot
   until 25. The race is *when do you spend the horse*.
3. **Terrain** — terraced hills drawn as topo bands. Uphill taxes speed and
   gallop stamina; downhill is free speed with worse turning.

**The Hunt** rides the same ground (grade-scaled speed, 5.8→7.1 m/s), rubber-bands
to the last rider, drains stamina ×2.5 and blocks recovery inside its 40m dread
radius, and captures anyone it holds within 7m for 2s.

## Tuning invariants (learned the hard way this session)

- The Hunt's speed MUST be grade-scaled. A pursuer that ignores hills wipes the
  whole field at the first climb (it did: 100% capture at s≈400).
- Canter must be stamina-neutral. When cruise drains, there is no sustainable
  pace and everyone slowly dies (it did: 100% capture at the first brook,
  arriving blown at trot, unable to jump).
- The Hunt's late speed (7.1) sits deliberately below the slowest horse's canter
  (~7.3) and far above a blown trot (4.6): it punishes *mismanagement*, not
  slowness.
- Brook width (3.4m) vs jump distance (speed × 0.75s): canter clears with a
  tight window, gallop generously. Widening the brook below canter-clearance
  soft-locks slow riders.

## Debug / balance API (console)

- `TANTIVY.sim(21)` — headless races, all-AI field mirroring the live one.
  Aggregates finish/capture rates + times. `sim(1, seed, true).trace` gives a
  per-second timeline.
- `TANTIVY.debug.start()` / `.setAutopilot(true)` / `.tick(n)` — drive the real
  game without RAF (the Browser pane doesn't fire RAF when hidden).
- `TANTIVY.debug.shot()` — POST canvas to `/shot` → writes `shot.png`.
- `TANTIVY.debug.probe()` — renderer/terrain sanity.

Balance baseline (21-run sim): all four bots finish, 137–141s, Hunt ends ~43m
behind the last rider, 3 of 4 riders touch dread mid-race, zero bot captures.
NOTE: bot races are near-deterministic (rng only gates jump timing) — the 21
runs collapse to ~1 sample. Human variance is the real test.

## Status / next

- ⚠ Feel UNVALIDATED — needs Daniel's hands on the reins.
- Next after playtest: sound (horn calls as the gap closes), a second course,
  capture animation polish, maybe named-rival personalities.
