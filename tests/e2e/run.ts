#!/usr/bin/env npx tsx
// ── E2E Test Runner — QQ Plugin ─────────────────────────────────────
//
// Uses the generic @ricky/openclaw-e2e framework.
// The QQ plugin stores poll data as JSON files (no SQLite),
// so hooks are minimal — just session reset + optional cleanup.

import { createE2ERunner } from "@ricky/openclaw-e2e";
import { cleanTestData, teardown } from "./lib/db-helper.js";

const runner = createE2ERunner({
  agentId: "test-bot",
  scenariosDir: new URL("./scenarios", import.meta.url).pathname,
  hooks: {
    clean: async (_agentId) => {
      cleanTestData(_agentId);
    },
    teardown: async () => {
      teardown();
    },
  },
});

runner.run();
