/**
 * Caddy config merge mechanism.
 *
 * Supports CADDY_CONFIG_MODE=merge:
 * Instead of POST /load (full replacement), reads the user's Caddyfile (via
 * `caddy adapt`), merges CPM-managed sections into it, and POSTs the merged
 * result. This preserves user-defined Caddyfile entries that live outside
 * CPM's managed sections.
 *
 * ## Config source: caddyfile adapt (two-phase)
 *
 *   1. **caddy adapt** (primary) — runs `caddy adapt --config <Caddyfile>` to
 *      produce a clean JSON base config containing ONLY the user's Caddyfile
 *      entries. No CPM history, no stale entries from previous merges.
 *   2. **Admin API** (fallback) — if the `caddy` binary or Caddyfile is
 *      unavailable, falls back to `GET /config/` on the running Caddy instance.
 *
 * The adapt approach eliminates stale-entry concerns because the Caddyfile is
 * never modified by CPM — so there's nothing to clean up. The fallback retains
 * the stale cleanup safety net.
 *
 * ## Reflection-based merge
 *
 * Instead of hardcoding specific config paths (apps.http.servers.cpm, apps.tls, etc.),
 * this module walks the cpmDocument tree recursively and dynamically discovers what
 * to merge. The recursion skips only the `admin` root key (user's Caddyfile owns it).
 *
 * For each key in cpmDocument at each level:
 *   - If both currentConfig and cpmDocument have objects → recurse deeper
 *   - Otherwise → replace with CPM's value
 *
 * Keys in currentConfig that don't exist in cpmDocument are PRESERVED.
 * This means any new section upstream CPM adds is automatically picked up.
 *
 * ## Stale cleanup (API fallback only)
 *
 * When falling back to the admin API, CPM may have previously written to a path
 * that it no longer produces (e.g., no proxy hosts → no servers.cpm). A minimal
 * set of "owned leaf paths" is maintained for this purpose.
 *
 *   - apps.http.servers.cpm  — CPM's reverse proxy server block
 *   - apps.layer4             — L4 TCP/UDP proxy servers
 *
 * Note: `apps.tls` is NOT in the cleanup set — users may have their own TLS
 * configuration in their Caddyfile that must never be auto-removed.
 *
 * The merge INCLUSION is fully dynamic. Only the DELETION set is enumerated.
 */
import { config } from "./config";
import http from "node:http";
import https from "node:https";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Caddy Admin API request (mirrors caddyRequest in caddy.ts)
// ---------------------------------------------------------------------------

function caddyApiRequest(
  url: string,
  method: string,
  body?: string
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: data })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Deep object helpers
// ---------------------------------------------------------------------------

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Get a value at a dotted path from an object. Returns undefined if
 * any intermediate key is missing.
 */
function deepGet(
  obj: Record<string, unknown>,
  path: string[]
): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Owned leaf paths — stale cleanup entries
// ---------------------------------------------------------------------------

/**
 * Paths that CPM definitely owns and should be removed from the merged config
 * when absent from cpmDocument. Without this, a deep-only merge would leave
 * old CPM entries lingering after the user deletes the corresponding resource.
 *
 * Note: `apps.tls` is intentionally excluded — users may have their own TLS
 * configuration in their Caddyfile (certificates, ACME settings, etc.) and
 * CPM does not exclusively own the entire `apps.tls` object.
 *
 * With the caddyfile adapt approach this cleanup is mostly a safety net:
 * since the Caddyfile base is always clean (no CPM history), stale entries
 * should not occur. The cleanup is kept for the API fallback case.
 */
const OWNED_LEAF_PATHS: string[][] = [
  ["apps", "http", "servers", "cpm"],
  ["apps", "layer4"],
];

// ---------------------------------------------------------------------------
// Caddyfile adapt — parse the user's Caddyfile to a clean JSON base
// ---------------------------------------------------------------------------

/**
 * Parses the user's Caddyfile via `caddy adapt --config <path>`.
 *
 * This gives a clean base config that contains ONLY what the user wrote in
 * their Caddyfile — no CPM history, no stale entries from previous merges.
 *
 * Returns the parsed JSON config, or null if the caddy binary / Caddyfile
 * is unavailable or the Caddyfile has parse errors (caller falls back to API).
 */
function adaptCaddyfile(): Record<string, unknown> | null {
  const caddyfilePath = config.caddyfilePath;
  try {
    const stdout = execSync(
      `caddy adapt --config "${caddyfilePath}" --adapter caddyfile`,
      { encoding: "utf-8", timeout: 15000 }
    );
    const parsed = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(
        `[caddy-merge] caddy adapt returned unexpected type: ${typeof parsed}`
      );
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.warn(
      `[caddy-merge] caddy adapt failed for ${caddyfilePath}, falling back to API:`,
      error
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read base config — adapt or fall back to admin API
// ---------------------------------------------------------------------------

/**
 * Reads the base Caddy config for merging.
 *
 * Strategy (two-phase):
 *   1. Try `caddy adapt --config <Caddyfile>` — returns a CLEAN base config
 *      that contains only the user's Caddyfile entries (no CPM history).
 *   2. If caddy adapt fails (binary not found, Caddyfile missing/parse error,
 *      etc.), fall back to GET /config/ via the admin API.
 *
 * The adapt approach eliminates stale-entry concerns entirely because the
 * Caddyfile is never modified by CPM — so there's nothing to clean up.
 */
async function readCurrentCaddyConfig(): Promise<Record<string, unknown> | null> {
  // Phase 1: Try caddy adapt for a clean base config
  const adapted = adaptCaddyfile();
  if (adapted) {
    console.log("[caddy-merge] Using caddy adapt for clean base config");
    return adapted;
  }

  // Phase 2: Fall back to the running Caddy config via admin API
  console.warn(
    "[caddy-merge] Falling back to Caddy admin API for base config"
  );
  try {
    const response = await caddyApiRequest(
      `${config.caddyApiUrl}/config/`,
      "GET"
    );
    if (response.status < 200 || response.status >= 300) {
      console.warn(
        `[caddy-merge] Failed to read current config: ${response.status} ${response.text}`
      );
      return null;
    }
    return JSON.parse(response.text) as Record<string, unknown>;
  } catch (error) {
    console.warn(
      `[caddy-merge] Unable to read current Caddy config at ${config.caddyApiUrl}:`,
      error
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dynamic reflection-based merge
// ---------------------------------------------------------------------------

/**
 * Recursively merge `source` into `target`, reflecting on the structure of
 * `source` to determine what to merge.
 *
 * Rules per key at each depth:
 *   - `admin` is skipped at root depth (user's Caddyfile owns admin endpoint)
 *   - Both are objects → recurse deeper (preserves sibling keys in target)
 *   - Otherwise → replace with `source`'s value (CPM's configuration wins)
 *
 * Keys that exist in `target` but NOT in `source` are preserved untouched.
 * This ensures user-defined Caddyfile entries survive the merge.
 */
function reflectMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  depth: number
): void {
  for (const [key, srcVal] of Object.entries(source)) {
    // Skip admin at root — user's Caddyfile controls the admin endpoint
    if (depth === 0 && key === "admin") continue;

    const tgtVal = target[key];

    if (isObject(srcVal) && isObject(tgtVal)) {
      // Both sides have objects — recurse to preserve sibling keys
      reflectMerge(tgtVal, srcVal, depth + 1);
    } else if (srcVal !== undefined) {
      // Leaf value or type mismatch — CPM's version wins
      target[key] = deepClone(srcVal);
    }
  }
}

/**
 * Remove stale CPM entries from the merged config.
 *
 * For each OWNED_LEAF_PATH: if the value is present in `merged` but absent
 * from `cpmDocument`, CPM no longer manages this resource. Delete it so
 * stale routes/configs don't linger in Caddy.
 */
function removeStaleOwnedLeaves(
  merged: Record<string, unknown>,
  cpmDocument: Record<string, unknown>
): void {
  for (const path of OWNED_LEAF_PATHS) {
    if (deepGet(cpmDocument, path) !== undefined) continue; // CPM still manages this

    const key = path[path.length - 1];
    const parentPath = path.slice(0, -1);
    const parent = deepGet(merged, parentPath) as
      | Record<string, unknown>
      | undefined;

    if (parent && key in parent) {
      delete parent[key];
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge CPM's sections into the current running config.
 *
 * Strategy:
 *   1. Deep-clone currentConfig to avoid mutation
 *   2. Reflect-merge cpmDocument into the clone (dynamic tree walk)
 *   3. Remove stale entries from OWNED_LEAF_PATHS
 *
 * @param currentConfig  The config read from Caddy's GET /config/
 * @param cpmDocument    The config built by buildCaddyDocument()
 * @returns              Merged config ready for POST /load
 */
export function mergeCpmSections(
  currentConfig: Record<string, unknown>,
  cpmDocument: Record<string, unknown>
): Record<string, unknown> {
  const merged = deepClone(currentConfig);

  // Phase 1: Dynamic reflection merge — walks cpmDocument tree and merges
  // every key (except admin) into the cloned currentConfig. Keys in
  // currentConfig that don't appear in cpmDocument are preserved.
  reflectMerge(merged, cpmDocument, 0);

  // Phase 2: Remove stale entries that CPM no longer produces.
  // Without this, owned paths (servers.cpm, tls, layer4) would linger after
  // the user deletes the corresponding CPM resource.
  removeStaleOwnedLeaves(merged, cpmDocument);

  return merged;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Apply Caddy config in merge mode:
 *   1. Read base config (caddy adapt → Caddyfile, or API fallback)
 *   2. Merge CPM's managed sections into it
 *   3. POST the merged result
 *
 * If obtaining a base config fails (caddy binary unavailable AND Caddy not
 * running), falls back to a full POST /load with just the CPM document as a
 * bootstrap.
 */
export async function applyCaddyConfigMerge(
  cpmDocument: Record<string, unknown>
): Promise<void> {
  const currentConfig = await readCurrentCaddyConfig();

  let payload: string;

  if (currentConfig) {
    const merged = mergeCpmSections(currentConfig, cpmDocument);
    payload = JSON.stringify(merged);
    console.log("[caddy-merge] Merged CPM config into running config");
  } else {
    // Caddy not reachable — bootstrap with CPM's full document
    payload = JSON.stringify(cpmDocument);
    console.warn(
      "[caddy-merge] Could not read current config, bootstrapping with CPM document"
    );
  }

  const response = await caddyApiRequest(
    `${config.caddyApiUrl}/load`,
    "POST",
    payload
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Caddy config load failed: ${response.status} ${response.text}`
    );
  }
}
