#!/usr/bin/env node
// Starts MinIO in Podman, runs the blobstore-s3 contract test against it, always stops the
// container afterwards. Exits non-zero on any failure (container start, bucket creation, or
// the test run itself).
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// @aws-sdk/client-s3 is only a dependency of packages/blobstore-s3, not of the workspace root,
// so resolve it from there rather than adding it to the root package.json.
const require = createRequire(fileURLToPath(new URL("../packages/blobstore-s3/package.json", import.meta.url)));
const { S3Client, CreateBucketCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");

const PORT = 9000;
const ROOT_USER = "kestrel";
const ROOT_PASSWORD = "kestrel-test-password";
const BUCKET = "kestrel-test";
const CONTAINER_NAME = `kestrel-s3-minio-${process.pid}`;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}`);
  }
  return result;
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ENDPOINT}/minio/health/live`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`MinIO did not become healthy within ${timeoutMs}ms`);
}

async function ensureBucket() {
  const client = new S3Client({
    region: "us-east-1",
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: ROOT_USER, secretAccessKey: ROOT_PASSWORD },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
}

async function main() {
  console.log(`== starting MinIO container ${CONTAINER_NAME}`);
  run("podman", [
    "run", "-d", "--rm",
    "--name", CONTAINER_NAME,
    "-p", `127.0.0.1:${PORT}:9000`,
    "-e", `MINIO_ROOT_USER=${ROOT_USER}`,
    "-e", `MINIO_ROOT_PASSWORD=${ROOT_PASSWORD}`,
    "quay.io/minio/minio:latest",
    "server", "/data",
  ]);

  try {
    console.log("== waiting for MinIO to become healthy");
    await waitForHealth(30_000);

    console.log(`== creating bucket ${BUCKET}`);
    await ensureBucket();

    console.log("== running contract tests against MinIO");
    const env = {
      ...process.env,
      KESTREL_S3_ENDPOINT: ENDPOINT,
      KESTREL_S3_BUCKET: BUCKET,
      KESTREL_S3_ACCESS_KEY: ROOT_USER,
      KESTREL_S3_SECRET_KEY: ROOT_PASSWORD,
    };
    const child = spawn("pnpm", ["vitest", "run", "packages/blobstore-s3/minio.test.ts"], {
      stdio: "inherit",
      env,
    });
    const exitCode = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) {
      throw new Error(`vitest exited with ${exitCode}`);
    }
    console.log("== s3-minio verification passed");
  } finally {
    console.log(`== stopping MinIO container ${CONTAINER_NAME}`);
    spawnSync("podman", ["stop", CONTAINER_NAME], { stdio: "inherit" });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
