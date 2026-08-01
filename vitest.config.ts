import { defineConfig } from 'vitest/config';

// Defaulted here rather than only in tools/with-local-env.sh so that running
// `pnpm vitest` or an IDE's test runner directly still points at LocalStack
// instead of failing with an opaque credentials error.
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_DEFAULT_REGION ??= process.env.AWS_REGION;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // *.slow.test.ts covers behaviour that is real but takes minutes to
    // observe locally (SQS redrive). Run it with `pnpm run test:slow`.
    exclude: ['**/node_modules/**', 'test/**/*.slow.test.ts'],
    // LocalStack runs every Lambda invocation as a Docker container, so test
    // parallelism translates directly into container concurrency. Running the
    // suite in one fork, one file at a time, keeps it from wedging the
    // emulator — slower, but it actually finishes.
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    sequence: { concurrent: false },

    // These are integration tests against an emulator, and a few assert on
    // timing (throttle windows, fault propagation, queue drain). On a shared CI
    // runner that occasionally produces a blip: measured locally at roughly one
    // flake in three full runs, always a different test, never reproducible.
    //
    // A retry cannot hide a real regression — a genuine break fails all three
    // attempts — but it stops a slow runner from reddening an otherwise good
    // build. Locally the default stays 0, so flakiness surfaces during
    // development instead of being papered over.
    retry: process.env.CI ? 2 : 0,
  },
});
