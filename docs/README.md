# xitter docs

All documentation for the project. No code lives under `docs/`.

```mermaid
flowchart LR
    README[docs README] --> specs[specs<br/>desired end-state]
    README --> decisions[decisions<br/>immutable records]
    README --> runbooks[runbooks<br/>manual procedures]
```

| Directory   | Purpose                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `specs/`    | Living documents describing the **desired end-state** of the system (never current state).  |
| `decisions/`| Decision records. Immutable once created; changes supersede via a new record.               |
| `runbooks/` | Step-by-step manual procedures (setup, deploy, content promotion). Idempotent where possible.|

## Conventions

- Specs are self-contained: they may reference other specs, nothing outside `specs/`.
  Everything else references specs rather than repeating them.
- Use Mermaid diagrams, tables, and other structured formats over prose walls.
- When a spec changes and creates a gap with reality, tickets are created to close the gap.
- Decision records use a consistent format: state, context, decision, options.
- Runbooks use: context/intro, execution steps, validation steps.

## Spec areas

| Area          | Covers                                                        |
| ------------- | ------------------------------------------------------------- |
| `architecture`| Technology, infrastructure, interfaces, technical flows        |
| `product`     | Non-technical product information, rationale, strategy        |
| `data`        | Schemas, pipelines, seeding, lifecycle                        |
| `operations`  | Environments, resets, backups, access (links out to runbooks) |
| `testing`     | Test strategy, suites, requirements, coverage gates           |
