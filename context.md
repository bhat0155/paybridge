# context.md — Working process for PayBridge implementation

How we're moving from `phases.md` (the plan) to actual implementation. This file just records the process, not project content — see `CLAUDE.md` (what/why), `contracts.md` (data contracts), `phases.md` (build chronology).

## The loop, per phase

1. **User explains the phase.** Ekam reads a phase from `phases.md` and explains it back in his own words — what it does and why, in order.
2. **Claude checks.** Claude verifies the explanation against `phases.md` (and `CLAUDE.md`/`contracts.md` where relevant), and corrects anything that's off. This repeats until the explanation is 100% correct — no moving on with a partial or fuzzy understanding.
3. **Only once understanding is confirmed correct**, Claude creates (or adds to) an `implementation/` folder at the repo root, with one file per phase — e.g. `implementation/phase-1.md` for Phase 1. That file contains **detailed, concrete implementation steps** for that phase: actual commands, file paths, config, code structure — enough to execute, not just restate the plan.
4. **Cross-verify Definition of Done.** Before moving to the next phase, Claude and Ekam check the implementation file's steps actually satisfy that phase's "Done when" criterion from `phases.md`. If they don't, the implementation file gets fixed first.
5. **Move to the next phase** and repeat from step 1.

## Ground rules

- Do not create an `implementation/phase-N.md` file until Ekam's explanation of phase N is confirmed 100% correct. Understanding comes before implementation detail.
- Each `implementation/phase-N.md` must trace back to the corresponding phase in `phases.md` — no scope drift, no steps borrowed from a later phase.
- The Definition of Done for each implementation file is the "Done when" line from that phase in `phases.md` — not a new or looser criterion invented at implementation time.
- Phases are done in order — no skipping ahead to a later phase's implementation file before the current one is cross-verified.
