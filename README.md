# TANTIVY

Isometric horse racer. A point-to-point steeplechase to sanctuary —
**ride hard, mind the horse, first to the bells.**

v0.3: the Wild Hunt is CUT (a new pressure mechanic is TBD) — it's a pure race
against 3 AI rivals on one 807m fenced course. Home menu + level select +
guided tutorial + settings (rebindable keys, sound toggle) + pause. Rotatable
camera (Q/E, 90° stops), horse-vs-horse collision, hazards: mud bogs (×4),
fallen logs (×3), a stone wall, cross-fence gates with flagged gaps (×2), hay
bales on the road (×6), and deer crossings (×2). Spectators with limbs, faces,
hats and cheering; clouds, hoof dust, water shimmer; procedural WebAudio
(hoofbeats by gait, horn, finish bells, wind + birdsong).
Storybook painterly, Three.js fixed-iso, no build step.

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

## Tuning invariants (learned the hard way)

- Canter must be stamina-neutral. When cruise drains, there is no sustainable
  pace and the whole field slowly bleeds out.
- Brook width (3.4m) vs jump distance (speed × 0.75s): canter clears with a
  tight window, gallop generously. Widening a jumpable band below
  canter-clearance soft-locks slow riders.
- If a pursuit mechanic ever returns: it must ride the same ground
  (grade-scaled speed) and its speed must sit below the slowest cruise —
  punish mismanagement, not slowness. (The Hunt broke both before it was cut.)

## Debug / balance API (console)

- `TANTIVY.sim(21)` — headless races, all-AI field mirroring the live one.
  Aggregates finish rates + times. `sim(1, seed, true).trace` gives a
  per-second timeline.
- `TANTIVY.debug.start()` / `.setAutopilot(true)` / `.tick(n)` — drive the real
  game without RAF (the Browser pane doesn't fire RAF when hidden).
- `TANTIVY.debug.shot()` — POST canvas to `/shot` → writes `shot.png`.
- `TANTIVY.debug.probe()` — renderer/terrain sanity.

Balance baseline (21-run sim): all four bots finish, 141–144s, skill-ordered.
NOTE: bot races are near-deterministic (rng only gates jump timing) — the 21
runs collapse to ~1 sample. Deer exist only in live races, not the sim.

## Status / next

- ⚠ Feel UNVALIDATED — needs Daniel's hands on the reins.
- The Hunt was cut; a replacement pressure/tension mechanic is an open design
  question. Candidates live with Daniel.
- Next after playtest: a second course (the level-select scaffolding is in),
  named-rival personalities, richer audio.
