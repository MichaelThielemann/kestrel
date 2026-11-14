# kestrel-target-cloudfoundry
A target for `kestrel-ops` (and so for `kestrel status`, `kestrel backup` and `kestrel restore`) that stops,
starts and describes one app in a Cloud Foundry space through the `cf` CLI. Besides `cf`, the target starts
only the commands of `{ "command": [...] }` sources in `vars`; `cf` must be on `PATH` and logged in.

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
| `org`, `space` | Where the app lives. The target reads `cf target` and refuses with exit 2 while cf targets another org or space; it never switches the target itself. Stop, start and the droplet change go to the app's guid through the v3 API, so switching cf to another space during a run cannot redirect them; before `cf apply-manifest` and `cf logs`, which take the app's name, the target reads `cf target` and the app's guid again and refuses with exit 2 when either changed. |
| `dir` | The directory of the deployed app's `package.json`, relative to the environments file (default `.`). The installed versions of its dependencies, and of `kestrel-replication-sqlite` and `kestrel` they bring along, are recorded in each backup and tell `kestrel-ops` whether the runtime seals its replica. Run the commands from a checkout of the deployed state. |
| `stopGraceSeconds` | Optional, default 15, at most 600. How long a stop waits after the stop request when it sees no instance shut down; see Stop below. Set it to at least the platform's graceful shutdown interval (10 s unless the operator changed it). |
| `readyUrl` | Optional. After an instance reports `RUNNING`, the target waits until this URL answers 200. |
| `manifest` | Optional. A manifest that holds the app's entry, read by `applyManifest()`. |
| `vars` | Where each `((name))` placeholder of the manifest gets its value: `{ "env": "NAME" }` or `{ "command": ["argv", "..."] }`, as for storage credentials. A name consists of letters, digits, `_` and `-`; cf reads a dot as a field path. |

## Behaviour
- **Status** reads the app's state, the desired instance count of its `web` process and the state of each
  instance through the v3 API (`cf curl`). An app reads `stopped` once it reports `STOPPED` and no instance is
  in any state but `DOWN`; an instance that is `STARTING` or `CRASHED` counts as running. An app scaled to more
  than one instance, or one with an active deployment (a rolling or canary push), ends every command with
  exit 1 before anything is stopped or started, a live backup included: two instances would write to the same
  replica. A started app scaled to 0 instances ends with exit 1 as well, naming `cf scale <app> -i 1` and
  `cf stop <app>`, and a stopped one scaled to 0 is not started: no instance would ever become ready.
- **Stop** sends the stop action to the app and waits until it reads `stopped` with no instance; a status read
  that fails during the wait is repeated until the stop timeout (120 s). The Cloud Controller answers the stop
  request before the instance receives its stop signal, so the instance's shutdown, in which the replica is
  synced and sealed, runs after the answer. A Cloud Controller with the `STOPPING` instance state (property
  `cc.app_instance_stopping_state`) lists the instance as `STOPPING` until its container is gone, and the target
  waits for that. Without that state the instance reads `DOWN` at once; when the target sees no instance shut
  down, it waits until `stopGraceSeconds` have passed since the stop request. When cf answers the stop request
  with an error but the app reads `STOPPED` afterwards, the target goes on waiting as after a stop that was
  answered. When the stop request fails otherwise or the wait fails, the error says that the app may stay stopped and names `cf start` to start it again. **Start**
  repeats a failing status read for up to 30 s, then sends the start action; when cf answers that request
  with an error but the app reads `STARTED` afterwards, the start counts as done. Readiness is an instance in
  state `RUNNING`, and then `readyUrl` answering 200 when it is set; a failing read during that wait counts as
  not ready yet and is repeated until the wait ends.
- **Describe** records the app's guid, its current droplet (null only when the platform answers that the app
  has none), its newest revision (guid and version, or null) and the names of its environment variables,
  never their values, next to the installed package versions. A read that fails ends the description with
  exit 1.
- **Evidence** for a stop without a seal lists the app's recent stop and crash events and, from
  `cf logs --recent`, the lines that report a teardown or replication failure.
- A backup or restore promotes a replica generation: an app instance starts on an empty disk and restores the
  newest generation of its replica.

Messages name the cf command and its exit code, never what cf printed. Colored and trace output are switched
off, also when `CF_TRACE` is set in the caller's environment. A failing `cf app <app> --guid` is reported as a
missing app or an expired cf session, which `cf target` does not reveal.

## Manifest and variables
`applyManifest()` (an update step; the target refuses unless the app is stopped) reads the manifest as cf
does, as YAML 1.1 with `<<` merge keys and `yes`/`no` booleans, with unquoted dates and clock times such as
`2026-11-14` and `03:00` kept as strings, and reduces it to its `version` and the app's resolved entry, so the
other applications and blocks a shared manifest describes stay untouched. Placeholders are found as cf finds
them, `((name))` and `((!name))`. It runs `cf apply-manifest -f <manifest> --vars-file <vars>`. The values of
the placeholders that entry uses are resolved from `vars`, written into a file only the current user can read
(mode 0600, in a directory with mode 0700) and removed when the call ends, also when it fails, the process
exits or SIGINT, SIGTERM or SIGHUP arrives during the call. No value is ever passed on a command line, and the
target never runs `cf set-env`. A placeholder without a source in `vars`, a placeholder with a dot (cf reads
`((db.url))` as the field `url` of the variable `db`), an entry that sets `instances`, or the `instances` of
its `web` process, to anything but 1, or a manifest without the app ends with exit 2 before cf runs.
`setDroplet(guid)` makes a staged droplet current, also only while the app is stopped.

## API
`createTarget(config, { root, clock })` is the factory `kestrel-ops` imports. `cloudFoundryTarget(config, deps,
options)` builds the same target with another environment for cf (`env`) and other waiting intervals
(`pollMs`, `stopTimeoutMs`, `readTimeoutMs`).

## Testing
The package's tests put a stub `cf` first on `PATH` that hands each call to a fake space in the test process,
and run backup and restore end to end through `kestrel` against MinIO (`pnpm test:s3`).

Not included: staging a new droplet, apps with more than one instance, other process types than `web`.
