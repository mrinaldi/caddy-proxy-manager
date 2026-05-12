/**
 * Caddy config merge mechanism.
 *
 * Supports CADDY_CONFIG_MODE=merge:
 * Instead of POST /load (full replacement), reads the current running Caddy config,
 * merges CPM-managed sections into it, and POSTs the merged result.
 * This preserves user-defined Caddyfile entries that live outside CPM's managed sections.
 *
 * Managed sections (CPM owns these):
 *   - apps.http.servers.cpm  — CPM's HTTP reverse proxy server block
 *   - apps.tls               — certificate automation + loaded PEMs
 *   - apps.layer4             — L4 (TCP/UDP) proxy servers
 *   - apps.logging.logs      — WAF rules logger + HTTP access logger (merged)
 *
 * Everything else in the config is preserved as-is.
 */
import { config } from "./config";
import http from "node:http";
import https from "node:https";

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
// Deep object helpers (avoid mutating the current config)
// ---------------------------------------------------------------------------

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Set a value at a dotted path inside an object, creating intermediate
 * objects as needed. Mutates the input object.
 */
function deepSet(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown
): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1];
  if (value === undefined) {
    delete current[lastKey];
  } else {
    current[lastKey] = value;
  }
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
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Read current running Caddy config
// ---------------------------------------------------------------------------

/**
 * Fetches the full running Caddy config via GET /config/.
 * Returns null if Caddy is unreachable.
 */
async function readCurrentCaddyConfig(): Promise<Record<string, unknown> | null> {
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
// Merge CPM-managed sections into an existing config
// ---------------------------------------------------------------------------

/**
 * Known CPM-managed config paths.
 * Keys are dot-separated paths in the CPM document, values describe the
 * merge strategy:
 *   "replace" — replace the subtree entirely with CPM's version
 *   "merge"   — merge CPM's object into the target (shallow merge of keys)
 *
 * @note When a managed section is empty/falsy in CPM's document, it is
 *       removed from the merged config (via delete).
 */
const MANAGED_SECTIONS: Record<
  string,
  { strategy: "replace" | "merge"; optional?: boolean }
> = {
  "apps.http.servers.cpm": { strategy: "replace" },
  apps: { strategy: "replace", optional: true },
  layer4: { strategy: "replace", optional: true },
  "apps.logging.logs": { strategy: "merge" },
};

/**
 * Merge CPM's sections into the current running config.
 *
 * @param currentConfig  The config read from Caddy's GET /config/
 * @param cpmDocument    The config built by buildCaddyDocument()
 * @returns              Merged config ready for POST /load
 */
export function mergeCpmSections(
  currentConfig: Record<string, unknown>,
  cpmDocument: Record<string, unknown>
): Record<string, unknown> {
  // Deep clone so we never mutate the argument
  const merged = deepClone(currentConfig);

  // 1. apps.http.servers.cpm — CPM's HTTP server block
  const cpmServer = deepGet(cpmDocument, ["apps", "http", "servers", "cpm"]);
  if (cpmServer !== undefined) {
    deepSet(merged, ["apps", "http", "servers", "cpm"], deepClone(cpmServer));
  } else {
    // CPM has no proxy hosts — remove the cpm server block if it exists
    const servers = deepGet(merged, ["apps", "http", "servers"]) as
      | Record<string, unknown>
      | undefined;
    if (servers && "cpm" in servers) {
      delete servers.cpm;
    }
  }

  // 2. apps.tls — certificate automation + loaded PEMs
  const tlsSection = deepGet(cpmDocument, ["apps", "tls"]);
  if (tlsSection !== undefined) {
    deepSet(merged, ["apps", "tls"], deepClone(tlsSection));
  } else {
    // Remove CPM-managed TLS if present
    const apps = deepGet(merged, ["apps"]) as
      | Record<string, unknown>
      | undefined;
    if (apps && "tls" in apps) {
      delete apps.tls;
    }
  }

  // 3. apps.layer4 — L4 TCP/UDP proxy servers
  const l4Section = deepGet(cpmDocument, ["apps", "layer4"]);
  if (l4Section !== undefined) {
    deepSet(merged, ["apps", "layer4"], deepClone(l4Section));
  } else {
    const apps = deepGet(merged, ["apps"]) as
      | Record<string, unknown>
      | undefined;
    if (apps && "layer4" in apps) {
      delete apps.layer4;
    }
  }

  // 4. apps.logging.logs — merge CPM's loggers into existing
  //    CPM manages two named loggers: "waf_rules" and "http_access".
  //    We shallow-merge these specific keys so the user's other loggers
  //    (if any) are preserved.
  const cpmLogs = deepGet(cpmDocument, ["logging", "logs"]) as
    | Record<string, unknown>
    | undefined;
  if (cpmLogs && typeof cpmLogs === "object") {
    // Ensure target path exists
    let targetLogs = deepGet(merged, ["logging", "logs"]) as
      | Record<string, unknown>
      | undefined;
    if (!targetLogs) {
      targetLogs = {};
      deepSet(merged, ["logging", "logs"], targetLogs);
    }
    // Merge each logger from CPM
    for (const [loggerName, loggerConfig] of Object.entries(cpmLogs)) {
      if (loggerConfig !== undefined && loggerConfig !== null) {
        targetLogs[loggerName] = deepClone(
          loggerConfig as Record<string, unknown>
        );
      } else {
        // CPM explicitly disabled this logger — remove it
        delete targetLogs[loggerName];
      }
    }
  }

  // 5. Admin config — intentionally NOT merged.
  //    The user's Caddyfile owns the admin endpoint config.
  //    We leave whatever is in the running config untouched.

  return merged;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Apply Caddy config in merge mode:
 * 1. Read current running config
 * 2. Merge CPM's managed sections into it
 * 3. POST the merged result
 *
 * If reading the current config fails (Caddy not running), falls back to
 * a full POST /load with just the CPM document as a bootstrap.
 */
export async function applyCaddyConfigMerge(
  cpmDocument: Record<string, unknown>
): Promise<void> {
  const currentConfig = await readCurrentCaddyConfig();

  let payload: string;

  if (currentConfig) {
    const merged = mergeCpmSections(currentConfig, cpmDocument);
    payload = JSON.stringify(merged);
    console.log(
      "[caddy-merge] Merged CPM config into running config"
    );
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
