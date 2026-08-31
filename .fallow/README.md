# fallow baselines

Pre-existing findings accepted at scaffold time, so `npm run lint:repo` gates
on **new** issues rather than the known state of the skeletons.

- `dead-code.json` - mostly unused deps reserved for feature tickets
- `health.json` - 59 complexity/CRAP findings, concentrated in the UI apps
- `dupes.json` - 24 clone groups (service skeletons share shape)

Regenerate when the accepted state changes (e.g. a cleanup ticket lands).
Regeneration is a reviewable event, not routine: every entry is acknowledged
debt - the health baseline grew ~8x in two weeks, which deserved eyes on it,
not a silent re-amnesty. Prefer deleting the underlying finding (or its file)
over re-baselining it.

```sh
npx fallow dead-code --save-baseline .fallow/dead-code.json
npx fallow health --save-baseline .fallow/health.json
npx fallow dupes --save-baseline .fallow/dupes.json
```

Caches (`cache*`, `*.bin`) are gitignored; baselines are committed.
