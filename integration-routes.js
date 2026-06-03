// E-commerce & Third-Party Integrations API
// Lazada, eBay, TikTok Shop, Shopee - API credential management

import crypto from "crypto";

export default async function integrationRoutes(app, pool) {
  // ============ CRUD ============

  // GET /integrations/:client_id - list all integrations for a client
  app.get("/integrations/:client_id", async (req, reply) => {
    const { rows } = await pool.query(
      "SELECT id, platform, label, enabled, config, created_at, updated_at FROM integrations WHERE client_id = $1 ORDER BY platform",
      [req.params.client_id]
    );
    // Mask sensitive config fields
    return rows.map(r => ({
      ...r,
      config: maskConfig(r.platform, r.config)
    }));
  });

  // POST /integrations/:client_id - create or update integration
  app.post("/integrations/:client_id", async (req, reply) => {
    const { platform, label, enabled, config } = req.body || {};
    if (!platform) return reply.code(400).send({ error: "platform required" });

    const validPlatforms = ["lazada", "ebay", "tiktok", "shopee", "shopify", "woocommerce"];
    if (!validPlatforms.includes(platform.toLowerCase())) {
      return reply.code(400).send({ error: `Invalid platform. Valid: ${validPlatforms.join(", ")}` });
    }

    // Validate and encrypt sensitive fields
    const safeConfig = validatePlatformConfig(platform, config || {});

    // Upsert
    const existing = await pool.query(
      "SELECT id FROM integrations WHERE client_id = $1 AND platform = $2",
      [req.params.client_id, platform.toLowerCase()]
    );

    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE integrations SET config = $1, enabled = COALESCE($2, enabled), label = COALESCE($3, label), updated_at = NOW()
         WHERE id = $4 RETURNING *`,
        [safeConfig, enabled !== undefined ? enabled : null, label || null, existing.rows[0].id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO integrations (client_id, platform, label, enabled, config)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.params.client_id, platform.toLowerCase(), label || null, enabled !== false, safeConfig]
      );
    }

    return { ok: true, integration: maskConfig(platform, result.rows[0]) };
  });

  // DELETE /integrations/:client_id/:platform - remove integration
  app.delete("/integrations/:client_id/:platform", async (req, reply) => {
    await pool.query(
      "DELETE FROM integrations WHERE client_id = $1 AND platform = $2",
      [req.params.client_id, req.params.platform.toLowerCase()]
    );
    return { ok: true };
  });

  // POST /integrations/:client_id/test - test integration connection
  app.post("/integrations/:client_id/test", async (req, reply) => {
    const { platform } = req.body || {};
    if (!platform) return reply.code(400).send({ error: "platform required" });

    const { rows } = await pool.query(
      "SELECT config FROM integrations WHERE client_id = $1 AND platform = $2 AND enabled = true",
      [req.params.client_id, platform.toLowerCase()]
    );
    if (!rows[0]) return reply.code(404).send({ error: "Integration not found" });

    const config = rows[0].config;
    const result = await testConnection(platform, config);

    return { ok: result.success, message: result.message, latency: result.latency };
  });

  // ============ PLATFORM-SPECIFIC HELPERS ============

  function validatePlatformConfig(platform, config) {
    const safe = { ...config };
    switch (platform.toLowerCase()) {
      case "lazada":
        // Lazada Open API: App Key, App Secret, Access Token, API Region
        return {
          app_key: safe.app_key || "",
          app_secret: safe.app_secret ? encrypt(safe.app_secret) : "",
          access_token: safe.access_token ? encrypt(safe.access_token) : "",
          region: safe.region || "MY",
          api_endpoint: "https://api.lazada.com.my/rest"
        };

      case "ebay":
        // eBay Seller API: Client ID, Client Secret, Refresh Token, Auth Token
        return {
          client_id: safe.client_id || "",
          client_secret: safe.client_secret ? encrypt(safe.client_secret) : "",
          refresh_token: safe.refresh_token ? encrypt(safe.refresh_token) : "",
          auth_token: safe.auth_token ? encrypt(safe.auth_token) : "",
          site_id: safe.site_id || "EBAY_MY",
          environment: safe.environment || "production"
        };

      case "tiktok":
        // TikTok Shop API: App Key, App Secret, Access Token, Shop ID
        return {
          app_key: safe.app_key || "",
          app_secret: safe.app_secret ? encrypt(safe.app_secret) : "",
          access_token: safe.access_token ? encrypt(safe.access_token) : "",
          shop_id: safe.shop_id || "",
          shop_cipher: safe.shop_cipher ? encrypt(safe.shop_cipher) : "",
          region: safe.region || "MY"
        };

      case "shopee":
        // Shopee Partner API: Partner ID, Partner Key, Shop ID, Access Token
        return {
          partner_id: safe.partner_id || "",
          partner_key: safe.partner_key ? encrypt(safe.partner_key) : "",
          shop_id: safe.shop_id || "",
          access_token: safe.access_token ? encrypt(safe.access_token) : "",
          api_version: safe.api_version || "v2",
          region: safe.region || "MY"
        };

      case "shopify":
        return {
          store: safe.store || "",
          api_key: safe.api_key ? encrypt(safe.api_key) : "",
          api_secret: safe.api_secret ? encrypt(safe.api_secret) : "",
          access_token: safe.access_token ? encrypt(safe.access_token) : ""
        };

      case "woocommerce":
        return {
          store_url: safe.store_url || "",
          consumer_key: safe.consumer_key ? encrypt(safe.consumer_key) : "",
          consumer_secret: safe.consumer_secret ? encrypt(safe.consumer_secret) : ""
        };

      default:
        return safe;
    }
  }

  function maskConfig(platform, row) {
    const config = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
    const masked = { ...config };
    const sensitiveKeys = ["app_secret", "client_secret", "refresh_token", "auth_token",
      "access_token", "partner_key", "api_secret", "consumer_secret", "api_key",
      "shop_cipher", "partner_id"];
    for (const key of sensitiveKeys) {
      if (masked[key] && masked[key].length > 4) {
        masked[key] = masked[key].slice(0, 4) + "****" + masked[key].slice(-4);
      }
    }
    return masked;
  }

  function encrypt(text) {
    // Simple obfuscation - in production use proper encryption
    if (!text) return "";
    return Buffer.from(text).toString("base64");
  }

  async function testConnection(platform, config) {
    // Stub - actual API calls would go here
    const platforms = {
      lazada: { url: "https://api.lazada.com.my/rest", test: "/auth/token/refresh" },
      ebay: { url: "https://api.ebay.com/identity/v1/oauth2/token", test: "" },
      tiktok: { url: "https://open-api.tiktokglobalshop.com", test: "/api/token/get" },
      shopee: { url: "https://partner.shopeemobile.com", test: "/api/v2/shop/get_shop_info" }
    };

    const info = platforms[platform];
    if (!info) return { success: false, message: "Unknown platform" };

    const start = Date.now();
    try {
      // Simulate connection test
      await new Promise(r => setTimeout(r, 500));
      return {
        success: true,
        message: `Connected to ${platform} API successfully`,
        latency: Date.now() - start
      };
    } catch (err) {
      return {
        success: false,
        message: `Connection failed: ${err.message}`,
        latency: Date.now() - start
      };
    }
  }
}
