# Durable execution rules for this repository

These rules exist to keep multi-step work fast, resumable, and honest across Codex sessions.

## Before acting

- Read this file, inspect `git status --short`, and identify the smallest files and checks relevant to the request.
- State the first verification target before starting a long command.
- Keep one short plan with one active step and record completed checks, generated artifacts, commit state, and hosting state.

## Parallelize safely

- Batch independent read-only work: status, `rg` searches, targeted source reads, package-script inspection, and lint/typecheck commands.
- Keep dependent writes sequential: edits, ingestion writes, migrations, commits, pushes, Site version saves, deployments, and browser navigation based on a prior result.
- Do not rerun a completed build, test, ingestion, or deployment because an unrelated later step failed. Reuse the completed artifact and retry only the failed dependency.

## Bound waiting

- Yield command output within 10–30 seconds. Poll retained sessions instead of starting duplicate commands.
- Send a concise progress update before work expected to take more than a minute and at least every 60 seconds while it continues.
- Use existing command/network timeouts. Retry transient failures at most twice; after that, preserve the last good state and report the blocker.

## Repository safeguards

- Preserve unrelated dirty files, especially `mobile/WhatspopularMobile/AssetImage.swift` unless the request explicitly includes it.
- Stage only in-scope files and verify `git diff --cached --name-only` before committing.
- For website code or data changes, the normal final checks are `npm run lint`, `npm run typecheck`, and `npm test` from `website/`; run lint and typecheck in parallel, then run the build-containing test suite.
- Do not run full live ingestion for a frontend-only change. Prefer the narrowest refresh mode and fail closed to the last valid snapshot.
- Generated data must be source-grounded and validated before publication; never fill missing evidence with generic copy.

## Hosting truthfulness

- Distinguish local, committed, pushed, saved Site version, private deployment, and public deployment.
- Saving a Site version does not change the public URL. Do not claim a live fix unless the current change was actually deployed and verified.
- For website code or data changes, public deployment is the default after validation: commit, push, package, save the Site version, deploy it, and verify the deployment URL. This standing project instruction applies across sessions. Skip deployment only when the user explicitly requests local-only work, a saved-but-undeployed version, or no publication. Never deploy before the relevant checks pass, and keep the distinction between committed, saved, and live states explicit.

## Handoff

End every multi-step task with: what changed, what passed, the exact commit or saved artifact, what remains live or unchanged, and the single next action needed. Future sessions should resume from that state rather than rediscovering the task.
