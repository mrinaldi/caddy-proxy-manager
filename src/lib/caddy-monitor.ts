/**
 * Caddy health monitoring service
 * Monitors Caddy for restarts/crashes and automatically reapplies configuration
 */

import http from "node:http";
import https from "node:https";
import { config } from "./config";
import { applyCaddyConfig, caddyRequest } from "./caddy";

type CaddyMonitorState = {
  isHealthy: boolean;
  lastConfigId: string | null;
  lastCheckTime: number;
  consecutiveFailures: number;
};

const HEALTH_CHECK_INTERVAL = 10000; // Check every 10 seconds
const MAX_CONSECUTIVE_FAILURES = 3; // Consider unhealthy after 3 failures
const REAPPLY_DELAY = 5000; // Wait 5 seconds after detecting restart before reapplying
const MIN_REAPPLY_INTERVAL = 30000; // Minimum interval between merge re-applies (prevents tight loops)

const monitorState: CaddyMonitorState = {
  isHealthy: false,
  lastConfigId: null,
  lastCheckTime: 0,
  consecutiveFailures: 0
};

let monitorInterval: NodeJS.Timeout | null = null;
let isMonitoring = false;
let lastReapplyTime = 0; // Timestamp of last merge-mode re-apply (debounce)

/**
 * Get the current Caddy config ID from the admin API
 * This is used to detect when Caddy has restarted (config ID changes)
 */
async function getCaddyConfigId(): Promise<string | null> {
  try {
    const response = await new Promise<{ status: number; text: string; etag: string | null }>((resolve, reject) => {
      const parsed = new URL(`${config.caddyApiUrl}/config/`);
      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.request(
        { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: "GET" },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data, etag: res.headers.etag ?? null }));
        }
      );
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", reject);
      req.end();
    });

    if (response.status < 200 || response.status >= 300) {
      return null;
    }

    // Use ETag or compute a simple hash from the response
    const etag = response.etag;
    if (etag) {
      return etag;
    }

    // Fallback: use the config object's structure
    const configData = JSON.parse(response.text);
    // Check if config is essentially empty (default state after restart)
    const isEmpty = !configData.apps || Object.keys(configData.apps).length === 0;
    return isEmpty ? "empty" : "configured";
  } catch {
    // Network error or timeout
    return null;
  }
}

/**
 * Check if Caddy is healthy and detect restarts
 */
async function checkCaddyHealth(): Promise<void> {
  const now = Date.now();
  monitorState.lastCheckTime = now;

  const currentConfigId = await getCaddyConfigId();

  if (currentConfigId === null) {
    // Caddy is not responding
    monitorState.consecutiveFailures++;

    if (monitorState.isHealthy && monitorState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.warn(
        `[CaddyMonitor] Caddy appears to be down (${monitorState.consecutiveFailures} consecutive failures)`
      );
      monitorState.isHealthy = false;
    }
    return;
  }

  // Caddy is responding
  const wasUnhealthy = !monitorState.isHealthy;
  monitorState.consecutiveFailures = 0;
  monitorState.isHealthy = true;

  // Detect restart: config ID changed to "empty" or Caddy was previously unhealthy
  const hasRestarted =
    (monitorState.lastConfigId !== null && currentConfigId === "empty") ||
    (wasUnhealthy && currentConfigId === "empty");

  if (hasRestarted) {
    console.log("[CaddyMonitor] Caddy restart detected! Waiting before reapplying configuration...");

    // Wait a bit for Caddy to fully initialize
    setTimeout(async () => {
      try {
        console.log("[CaddyMonitor] Reapplying Caddy configuration after restart...");
        await applyCaddyConfig();
        console.log("[CaddyMonitor] Configuration reapplied successfully");

        // Update the config ID after successful reapplication
        const newConfigId = await getCaddyConfigId();
        monitorState.lastConfigId = newConfigId;
      } catch (error) {
        console.error("[CaddyMonitor] Failed to reapply configuration after restart:", error);
        // Will retry on next health check
      }
    }, REAPPLY_DELAY);
  } else if (monitorState.lastConfigId === null) {
    // First time seeing Caddy healthy
    console.log("[CaddyMonitor] Caddy health monitoring initialized");
    monitorState.lastConfigId = currentConfigId;
  } else {
    // Normal operation — config may have changed (e.g. Caddy reload)
    if (
      config.caddyConfigMode === "merge" &&
      monitorState.lastConfigId !== null &&
      currentConfigId !== monitorState.lastConfigId
    ) {
      await reapplyIfSectionMissing();
    }

    monitorState.lastConfigId = currentConfigId;
  }
}

/**
 * After a config change is detected, check whether CPM-managed sections
 * still exist in the running config. If they're missing (e.g., after a
 * `caddy reload` that re-reads the Caddyfile), re-apply the merge.
 *
 * Uses a lightweight GET on the CPM-owned section path to avoid the full
 * config fetch. Debounced to MIN_REAPPLY_INTERVAL to prevent tight loops
 * when CPM has no proxy hosts configured (the check would always show
 * the section missing, but we still limit frequency).
 */
async function reapplyIfSectionMissing(): Promise<void> {
  const now = Date.now();
  if (now - lastReapplyTime < MIN_REAPPLY_INTERVAL) return;

  try {
    // Probe the CPM-owned server section — 404 = missing (reloaded/restarted)
    const response = await caddyRequest(
      `${config.caddyApiUrl}/config/apps/http/servers/cpm/`,
      "GET"
    );

    if (response.status === 404) {
      console.log(
        "[CaddyMonitor] CPM config section missing — likely a Caddy reload. Reapplying merge..."
      );
      lastReapplyTime = now;
      await applyCaddyConfig();
      console.log("[CaddyMonitor] Merge re-applied successfully after reload");
    }
  } catch (error) {
    console.warn("[CaddyMonitor] Failed to check CPM config section:", error);
  }
}

/**
 * Start monitoring Caddy health
 */
export function startCaddyMonitoring(): void {
  if (isMonitoring) {
    console.log("[CaddyMonitor] Already monitoring");
    return;
  }

  console.log(`[CaddyMonitor] Starting Caddy health monitoring (interval: ${HEALTH_CHECK_INTERVAL}ms)`);
  isMonitoring = true;

  // Do initial check immediately
  checkCaddyHealth().catch((error) => {
    console.error("[CaddyMonitor] Initial health check failed:", error);
  });

  // Set up periodic checks
  monitorInterval = setInterval(() => {
    checkCaddyHealth().catch((error) => {
      console.error("[CaddyMonitor] Health check failed:", error);
    });
  }, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop monitoring Caddy health
 */
export function stopCaddyMonitoring(): void {
  if (!isMonitoring) {
    return;
  }

  console.log("[CaddyMonitor] Stopping Caddy health monitoring");
  isMonitoring = false;

  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

/**
 * Get current monitoring state (useful for debugging)
 */
export function getMonitorState(): Readonly<CaddyMonitorState> {
  return { ...monitorState };
}
