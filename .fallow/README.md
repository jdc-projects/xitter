# fallow baselines

Pre-existing findings accepted at scaffold time, so `npm run lint:repo` gates
on **new** issues rather than the known state of the skeletons.

- `dead-code.json` - mostly unused deps reserved for feature tickets
- `health.json` - 7 complexity findings in orchestration/script code
- `dupes.json` - 13-file clone groups (service skeletons share shape)

Regenerate when the accepted state changes (e.g. a cleanup ticket lands):

```sh
npx fallow dead-code --save-baseline .fallow/dead-code.json
npx fallow health --save-baseline .fallow/health.json
npx fallow dupes --save-baseline .fallow/dupes.json
```

Caches (`cache*`, `*.bin`) are gitignored; baselines are committed.
