# T-48h demo freeze

> The team was told, on 19 Aug 2026, that *"a backend switch will allow disabling
> unfinished features 48 hours before the event."* This is that promise, written
> down as a procedure someone other than its author can run.

The governing instruction from the same meeting: **"a small working demo is
preferred over a flashy but buggy presentation."** Everything below optimises for
the happy path never breaking in front of a stranger, not for surface area.

## The switches

Nine flags, parsed strictly at boot — a value that is not exactly `true` or
`false` is a startup error, never a silent off (`apps/api/src/env.ts`).

| Flag | Turns off |
|---|---|
| `DATAROOM_MODULE_ENABLED` | versions, comments and chunked upload together |
| `DATAROOM_VERSIONS_ENABLED` | version history and restore only |
| `DATAROOM_COMMENTS_ENABLED` | document comments only |
| `DATAROOM_CHUNKED_UPLOAD_ENABLED` | resumable upload; the proven single-shot path remains |
| `QA_MODULE_ENABLED` | the whole Q&A surface |
| `QA_PRESENTATION_ENABLED` | broker rewordings only |
| `QA_NOMINATIONS_ENABLED` | seller nomination only |
| `CIM_MODULE_ENABLED` | the CIM builder |
| `QOE_MODULE_ENABLED` | the earnings bridge and Financial Statements |

`QOE_MODULE_ENABLED` is greenfield despite the domain being old: legacy serves
`/ebitda-adjustments`, and nothing at `/qoe`. Switching it off therefore removes
the capability rather than falling back — Bank and Tax Reconciliation are legacy
screens and stay, so the Quality of Earnings folder survives losing one child.

They are sub-flags rather than one per module on purpose: the commitment is that
a single unfinished thing can be killed **without losing the module around it**.
An all-or-nothing flag would force a choice between shipping something broken and
shipping nothing.

Two dependencies degrade rather than cascade. With the data room off, Q&A
attachments report unavailable and every other Q&A route keeps working. With Q&A
off, CIM question generation reports unavailable and the rest of the builder keeps
working.

## The procedure

Run it Saturday evening, and again Sunday afternoon.

**1. Decide the kill list.** Anything whose happy path failed even once in the
last 24 hours goes off. Not "we think we fixed it" — off.

**2. Flip flags only.** Set `false` in `docker-compose.demo.yml` or the booth
`.env`. Never delete code; a deletion cannot be undone at the stand.

**3. Cold rebuild.**

```
docker compose -f docker-compose.demo.yml down -v && ./tools/demo/up.sh
```

`up.sh` ends in ~43 live assertions against the running stack. Every check for a
new surface is wrapped in its own flag test, so a disabled feature's checks
**skip** rather than fail — which is what makes this script the rehearsal rather
than something that must be edited before one.

**4. Eyeball the SPA on the iPad, in Safari, with the console open.**
**This step is a blocking gate.** Look for:

- no navigation entry for a disabled feature (absent, not greyed out);
- no empty panel or tab where a disabled feature used to be;
- no spinner that never resolves;
- zero red in the console.

The client treats every feature as off until `/healthz` says otherwise, and off
if that request fails — so a disabled feature should be invisible rather than
broken. If it is merely *disabled-looking*, something is reading the flag too
late.

**5. Reset.** `./tools/demo/reset.sh` — seeded state in under 30 seconds, no
container restart, safe with the SPA already open in two browsers. It ends in its
own eight assertions.

**6. Two concurrent sessions.** Broker on the laptop, seller on the iPad, through
the full Q&A round trip and a data room upload. Watch specifically for one
person's cached folder tree appearing for the other — the store is keyed per user
now, and this is the check that proves it.

**7. Record the passing flag set and freeze it.** Any change afterwards re-runs
steps 3 to 6.

**8. Print the happy-path scripts** and tape them to the table.

## Bring the machine up the night before

Start the stack Sunday night and leave it running. Never cold-start on demo
morning: the container build pulls from the npm registry, and a registry that is
slow or unreachable turns a two-minute start into an unbounded one. That has
already happened during this build.

## What "working" means, per surface

The minimum each surface must do, unattended, on the booth hardware:

**Data room.** Open a seeded deal → tap Upload → progress advances → the file
appears → open it → preview renders → re-upload the same name → v2 appears with
v1 still viewable → leave an internal comment and see it attributed.

**Q&A.** Broker asks in a category → the seller's nominee is pre-filled → seller
answers on the iPad → broker rewords into a presentable version → both are
visible side by side → the audit shows who did what, when.

**CIM.** Open Project Atlas → a real-looking deck, partly filled → the gaps list
shows what is missing → the published v1 PDF opens from the data room.

If a surface cannot do its paragraph, switch it off and demo the other two.
