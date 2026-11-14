# kestrel-target-cloudfoundry
A target for `kestrel-ops` (and so for `kestrel status`, `kestrel backup` and `kestrel restore`) that stops,
starts and describes one app in a Cloud Foundry space through the `cf` CLI. It is the only external program
the target starts; `cf` must be on `PATH` and logged in.

```
pnpm add -D @michaelthielemann/kestrel-ops @michaelthielemann/kestrel-target-cloudfoundry
```

Requires Node 22.18 or later and cf CLI 8.

## Configuration
The `target` block of an environment in `kestrel.environments.json` names this package as its adapter:

```json
{
  "target": {
    "adapter": "@michaelthielemann/kestrel-target-cloudfoundry",
    "app": "site-api",
    "org": "example-org",
    "space": "production",
    "readyUrl": "https://site-api.example.net/api/ready",
    "manifest": "deploy/manifest.yml",
    "vars": {
      "storage_secret": { "command": ["pass", "show", "example/storage-secret"] },
      "session_secret": { "env": "SESSION_SECRET" }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `app` | The app's name in the space. Every `cf` call names this app or its guid and no other; an app that serves the public output next to it, such as a static web server, is never stopped, started or changed. |
| `org`, `space` | Where the app lives. The target reads `cf target` and refuses with exit 2 while cf targets another org or space; it never switches the target itself. |
| `dir` | The directory of the deployed app's `package.json`, relative to the environments file (default `.`). The installed versions of its dependencies, and of `kestrel-replication-sqlite` and `kestrel` they bring along, are recorded in each backup and tell `kestrel-ops` whether the runtime seals its replica. Run the commands from a checkout of the deployed state. |
| `readyUrl` | Optional. After an instance reports `RUNNING`, the target waits until this URL answers 200. |
| `manifest` | Optional. A manifest that holds the app's entry, read by `applyManifest()`. |
| `vars` | Where each `((name))` placeholder of the manifest gets its value: `{ "env": "NAME" }` or `{ "command": ["argv", "..."] }`, as for storage credentials. |

## Behaviour
- **Status** reads the app's state, the desired instance count of its `web` process and the state of each
  instance through the v3 API (`cf curl`). An app reads `stopped` once it reports `STOPPED` and no instance is
  in any state but `DOWN`; an instance that is `STARTING` or `CRASHED` counts as running. An app scaled to more
  than one instance, or one with an active deployment (a rolling or canary push), ends every command with
  exit 1 before anything is stopped or started: two instances would write to the same replica.
- **Stop** runs `cf stop` and waits until the app reads `stopped` with no instance. **Start** runs `cf start`;
  readiness is an instance in state `RUNNING`, and then `readyUrl` answering 200 when it is set.
- **Describe** records the app's guid, its current droplet and the names of its environment variables, never
  their values, next to the installed package versions.
- **Evidence** for a stop without a seal lists the app's recent stop and crash events and, from
  `cf logs --recent`, the lines that report a teardown or replication failure.
- A backup or restore promotes a replica generation: an app instance starts on an empty disk and restores the
  newest generation of its replica.

Messages name the cf command and its exit code, never what cf printed. Colored output is switched off.

## Manifest and variables
`applyManifest()` (an update step; the target refuses unless the app is stopped) reduces the manifest to the
app's own entry, so the other applications a shared manifest describes stay untouched, and runs
`cf apply-manifest -f <manifest> --vars-file <vars>`. The values of the placeholders that entry uses are
resolved from `vars`, written into a file only the current user can read (mode 0600, in a directory with mode
0700) and removed when the call ends, also when it fails. No value is ever passed on a command line, and the
target never runs `cf set-env`. A placeholder without a source in `vars`, or a manifest without the app, ends
with exit 2 before cf runs. `setDroplet(guid)` makes a staged droplet current, also only while the app is
stopped.

## API
`createTarget(config, { root, clock })` is the factory `kestrel-ops` imports. `cloudFoundryTarget(config, deps,
options)` builds the same target with another environment for cf (`env`) and other waiting intervals.

## Testing
The package's tests put a stub `cf` first on `PATH` that hands each call to a fake space in the test process,
and run backup and restore end to end through `kestrel` against MinIO (`pnpm test:s3`).

Not included: staging a new droplet, apps with more than one instance, other process types than `web`.
