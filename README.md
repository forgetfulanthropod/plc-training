# plc-training

**Live app: https://forgetfulanthropod.github.io/plc-training/**

A browser-based ladder logic trainer. Write a PLC program in a ladder editor, run it with a simulated scan cycle, and watch it drive a virtual conveyor factory. Everything runs client-side as static files: no install, no backend.

![Ladder editor and virtual factory](docs/screenshot.png)

## Features

- **Ladder editor:** rungs with normally-open (XIC) and normally-closed (XIO) contacts, nested parallel branches, and output instructions: `OTE` coil, `OTL`/`OTU` latch and unlatch, `TON` on-delay timer, `CTU` up-counter, and `RES` reset. Every instruction uses a named tag, and the editor autocompletes I/O tags and timer/counter bits such as `T1.DN` and `C1.DN`.
- **Scan-cycle simulator:** **Run** scans continuously every 50 ms, **Stop** returns to program mode and de-energizes outputs, and **Single Scan** executes exactly one scan. Rungs are solved top to bottom, energized wires and closed contacts are highlighted live, and timer/counter ACC values update as the program runs.
- **Virtual factory (canvas):** the cell has a conveyor driven by `MOTOR`, an infeed box spawner (manual or auto), and four photo-eyes (`PE_ENTRY`, `PE_MID`, `PE_END`, and a `PE_TALL` height sensor). It also has a pneumatic `DIVERTER` that pushes boxes into a reject bin, a red/amber/green stack light, START/STOP/RESET pushbuttons, and a latching E-STOP that also hard-cuts motor and diverter power. Click a box to pick it off by hand.
- **One-click examples:** start/stop seal-in motor, a conveyor that stops at the end sensor, a timed dwell (TON), a batch of 5 (CTU + RES), and a tall-box sorter.
- **Save/Open** to browser localStorage (your work is also autosaved), plus **Export/Import** as JSON.

## I/O map

| Tag | Dir | Meaning |
| --- | --- | --- |
| `START_PB` | IN | Start pushbutton (ON while pressed) |
| `STOP_PB` | IN | Stop pushbutton (ON while pressed, so use an NC contact) |
| `RESET_PB` | IN | Reset pushbutton |
| `ESTOP` | IN | E-stop, ON while latched in |
| `PE_ENTRY`, `PE_MID`, `PE_END` | IN | Photo-eyes, ON when blocked |
| `PE_TALL` | IN | Height photo-eye at the diverter, sees only tall (blue) boxes |
| `MOTOR` | OUT | Conveyor motor |
| `DIVERTER` | OUT | Pusher into the reject bin |
| `LIGHT_GREEN`, `LIGHT_AMBER`, `LIGHT_RED` | OUT | Stack light |

Any other name, such as `RUN`, becomes an internal bit. Timers and counters are created by their `TON`/`CTU` instruction.

## Program JSON format

```json
{
  "name": "Start/Stop seal-in motor",
  "version": 1,
  "rungs": [{
    "comment": "Seal-in",
    "logic": [
      { "type": "BRANCH", "legs": [[{ "type": "NO", "tag": "START_PB" }], [{ "type": "NO", "tag": "MOTOR" }]] },
      { "type": "NC", "tag": "STOP_PB" },
      { "type": "NC", "tag": "ESTOP" }
    ],
    "outputs": [{ "type": "OTE", "tag": "MOTOR" }]
  }]
}
```

`TON` presets are in milliseconds and `CTU` presets are in counts.

## Development

Plain HTML, CSS, and ES modules, with no build step.

```bash
npm test          # unit tests for the ladder engine, editor ops, and factory integration (node:test)
npm start         # serve locally at http://localhost:8080
```

- `js/ladder.js`: pure ladder evaluation engine (scan, contacts, branches, timers, counters)
- `js/factory.js`: virtual factory physics and canvas rendering
- `js/editor.js`: SVG ladder renderer and editing operations
- `js/examples.js`: example programs
- `js/app.js`: UI wiring

Every push to `main` runs the tests and deploys to GitHub Pages through `.github/workflows/pages.yml`.
