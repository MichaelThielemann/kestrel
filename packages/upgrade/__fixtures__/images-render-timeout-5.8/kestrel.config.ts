import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db" } },
    { use: "@michaelthielemann/kestrel-blobstore-s3", config: { bucket: "example-bucket", region: "eu-west-1", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" } },
    { use: "@michaelthielemann/kestrel-media-default", config: {} },
    { use: "@michaelthielemann/kestrel-images-default", config: { staleAfterMs: 20000 } },
  ],
  triggers: [],
});
