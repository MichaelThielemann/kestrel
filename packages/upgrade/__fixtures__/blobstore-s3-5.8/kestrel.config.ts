import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db", busyTimeoutMs: 20000 } },
    { use: "@michaelthielemann/kestrel-blobstore-s3", config: { bucket: "prod-bucket", region: "eu-west-1", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" } },
    { use: "@michaelthielemann/kestrel-content-default", config: { types: {} } },
    { use: "@michaelthielemann/kestrel-renderer-plain", config: {} },
    { use: "@michaelthielemann/kestrel-site-default", config: {} },
    { use: "@michaelthielemann/kestrel-media-default", config: {} },
    { use: "@michaelthielemann/kestrel-images-default", config: {} },
    { use: "@michaelthielemann/kestrel-delivery-static", config: { types: {} } },
    { use: "@michaelthielemann/kestrel-replication-sqlite", config: { file: "./data/replica.db" } },
    { use: "@michaelthielemann/kestrel-backup-blobstore", config: { file: "./data/kestrel.db", key: "kestrel-backup" } },
  ],
  triggers: [],
});
