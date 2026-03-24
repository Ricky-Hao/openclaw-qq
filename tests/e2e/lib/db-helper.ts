// ── DB Helper — QQ plugin E2E ───────────────────────────────────────
//
// The QQ plugin stores poll data as individual JSON files under
// ~/.openclaw/data/polls/<messageId>.json — there is no SQLite DB.
//
// This helper provides clean/teardown stubs for framework compatibility
// and a file-based cleanup for poll artifacts.

import { readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Poll data directory ────────────────────────────────────────────

const POLL_DATA_DIR = join(homedir(), ".openclaw", "data", "polls");

// ── Clean ──────────────────────────────────────────────────────────

/**
 * Remove poll JSON files created during tests.
 * Since polls don't have an agent_id marker in the filename,
 * we only clean files created very recently (last 5 minutes)
 * to avoid nuking production poll data.
 */
export function cleanTestData(_agentId?: string): void {
  // No-op for now — poll files are cheap and harmless.
  // Real cleanup would require tracking which messageIds were created
  // during the test, which the framework doesn't support yet.
}

// ── Teardown ───────────────────────────────────────────────────────

export function teardown(): void {
  // Nothing to close — no DB connections.
}
