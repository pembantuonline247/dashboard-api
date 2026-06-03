import fs from "fs";
import path from "path";

const CLIENTS_ROOT = "/var/www/clients";

function getRefDir(clientId) {
  const dir = path.join(CLIENTS_ROOT, clientId, "refs");
  if (!dir.startsWith(CLIENTS_ROOT)) return null;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(item => !item.name.startsWith("."))
    .map(item => {
      const fullPath = path.join(dir, item.name);
      const stat = fs.statSync(fullPath);
      const ext = path.extname(item.name).toLowerCase();
      return {
        name: item.name,
        size: stat.size,
        ext,
        type: getMediaType(ext),
        modifiedAt: stat.mtime.toISOString()
      };
    });
}

function getMediaType(ext) {
  const types = {
    ".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image",
    ".webp": "image", ".svg": "image", ".pdf": "document",
    ".doc": "document", ".docx": "document", ".txt": "text",
    ".csv": "data", ".xlsx": "data", ".xls": "data"
  };
  return types[ext] || "other";
}

export default async function mediaTermsRoutes(app, pool) {
  // ============ MEDIA REFERENCES ============
  app.post("/media/:client_id/upload", async (req, reply) => {
    const refDir = getRefDir(req.params.client_id);
    if (!refDir) return reply.code(400).send({ error: "Invalid client" });
    const boundary = req.headers["content-type"]?.match(/boundary=(.+)/)?.[1];
    if (!boundary) return reply.code(400).send({ error: "multipart/form-data required" });
    const raw = req.body;
    if (!raw || raw.length === 0) return reply.code(400).send({ error: "No data" });
    const parts = raw.toString("binary").split(boundary);
    let saved = [];
    for (const part of parts) {
      const headerMatch = part.match(/name="([^"]+)"\s*(?:filename="([^"]*)")?/);
      if (!headerMatch || !headerMatch[2]) continue;
      const fileName = headerMatch[2];
      const sep = "\r\n\r\n";
      const sepIdx = part.indexOf(sep);
      if (sepIdx === -1) continue;
      const content = part.slice(sepIdx + sep.length).replace(/\r\n--$/, "").replace(/\r\n$/, "");
      const cleanName = path.basename(fileName);
      const filePath = path.join(refDir, cleanName);
      if (filePath.startsWith(refDir)) {
        fs.writeFileSync(filePath, content, "binary");
        saved.push(cleanName);
        const existing = await pool.query("SELECT media_refs FROM clients WHERE id = $1", [req.params.client_id]);
        const refs = existing.rows[0]?.media_refs || [];
        const ext = path.extname(cleanName).toLowerCase();
        refs.push({
          name: cleanName,
          type: getMediaType(ext),
          ext,
          size: Buffer.byteLength(content, "binary"),
          uploadedAt: new Date().toISOString()
        });
        await pool.query("UPDATE clients SET media_refs = $1 WHERE id = $2", [JSON.stringify(refs), req.params.client_id]);
      }
    }
    // Refresh storage usage
    try {
      const { execSync } = await import("child_process");
      const result = execSync('du -sb "' + refDir + '" 2>/dev/null | cut -f1');
      const usedBytes = parseInt(result.toString().trim()) || 0;
      await pool.query("UPDATE clients SET storage_used_bytes = $1 WHERE id = $2", [usedBytes, req.params.client_id]);
    } catch (e) {}
    return { ok: true, files: saved };
  });

  app.get("/media/:client_id/list", async (req, reply) => {
    const refDir = getRefDir(req.params.client_id);
    if (!refDir) return reply.code(400).send({ error: "Invalid client" });
    const dbRefs = await pool.query("SELECT media_refs FROM clients WHERE id = $1", [req.params.client_id]);
    const fsFiles = listFiles(refDir);
    const merged = fsFiles.map(f => {
      const dbEntry = (dbRefs.rows[0]?.media_refs || []).find(r => r.name === f.name);
      return { ...f, label: dbEntry?.label || null, uploadedAt: dbEntry?.uploadedAt || f.modifiedAt };
    });
    return { files: merged, path: "refs/" };
  });

  app.delete("/media/:client_id/:name", async (req, reply) => {
    const refDir = getRefDir(req.params.client_id);
    if (!refDir) return reply.code(400).send({ error: "Invalid client" });
    const cleanName = path.basename(req.params.name);
    const filePath = path.join(refDir, cleanName);
    if (!filePath.startsWith(refDir)) return reply.code(400).send({ error: "Invalid path" });
    try {
      fs.unlinkSync(filePath);
      const existing = await pool.query("SELECT media_refs FROM clients WHERE id = $1", [req.params.client_id]);
      const refs = (existing.rows[0]?.media_refs || []).filter(r => r.name !== cleanName);
      await pool.query("UPDATE clients SET media_refs = $1 WHERE id = $2", [JSON.stringify(refs), req.params.client_id]);
      return { ok: true };
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });

  app.get("/media/:client_id/:name", async (req, reply) => {
    const refDir = getRefDir(req.params.client_id);
    if (!refDir) return reply.code(400).send({ error: "Invalid client" });
    const cleanName = path.basename(req.params.name);
    const filePath = path.join(refDir, cleanName);
    if (!filePath.startsWith(refDir)) return reply.code(400).send({ error: "Invalid" });
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: "Not found" });
    const ext = path.extname(cleanName).toLowerCase();
    const mimes = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain" };
    reply.header("Content-Type", mimes[ext] || "application/octet-stream");
    return fs.createReadStream(filePath);
  });

  app.post("/media/:client_id/label", async (req, reply) => {
    const { name, label, category } = req.body || {};
    if (!name) return reply.code(400).send({ error: "name required" });
    const existing = await pool.query("SELECT media_refs FROM clients WHERE id = $1", [req.params.client_id]);
    const refs = existing.rows[0]?.media_refs || [];
    const idx = refs.findIndex(r => r.name === name);
    if (idx === -1) return reply.code(404).send({ error: "File not found" });
    refs[idx].label = label || refs[idx].label;
    refs[idx].category = category || refs[idx].category || "general";
    await pool.query("UPDATE clients SET media_refs = $1 WHERE id = $2", [JSON.stringify(refs), req.params.client_id]);
    return { ok: true };
  });

  // ============ PRIVACY & TERMS ============
  app.get("/legal/privacy", async (req, reply) => {
    return {
      lastUpdated: "2026-06-03",
      sections: [
        { title: "Information We Collect", content: "We collect information you provide when registering (business name, email, WhatsApp number) and usage data (chat transcripts, token consumption, uploaded media)." },
        { title: "How We Use Your Information", content: "Your information is used to operate the AI assistant service, process payments, improve service quality, and comply with legal obligations. We do not sell your personal data to third parties." },
        { title: "Data Storage & Security", content: "Data is stored on secure servers with encryption at rest and in transit. We retain your data for the duration of your subscription plus 90 days after cancellation." },
        { title: "WhatsApp & Messaging Data", content: "Messages sent through our platform are processed to provide the AI assistant service. Message content is stored temporarily for context continuity and permanently for quality assurance. You can request deletion of your data at any time." },
        { title: "Third-Party Integrations", content: "When you connect third-party services (Lazada, eBay, TikTok Shop, Shopee, etc.), data may be exchanged between our platform and those services as necessary for the integration to function." },
        { title: "Your Rights", content: "You have the right to access, correct, or delete your personal data. Contact us at support@pembantu.online to exercise these rights." },
        { title: "Changes to This Policy", content: "We may update this policy. Continued use after changes constitutes acceptance of the updated policy." }
      ]
    };
  });

  app.get("/legal/terms", async (req, reply) => {
    return {
      lastUpdated: "2026-06-03",
      sections: [
        { title: "Acceptance of Terms", content: "By using Pembantu.Online, you agree to these terms. If you do not agree, do not use the service." },
        { title: "Service Description", content: "Pembantu.Online provides AI-powered virtual assistant services including WhatsApp automation, website building, e-commerce integration, and workflow automation. Service availability depends on your subscription plan." },
        { title: "User Responsibilities", content: "You are responsible for maintaining the confidentiality of your account credentials. You agree not to use the service for illegal purposes or to violate any laws in your jurisdiction." },
        { title: "AI Credits & Billing", content: "AI Credits are consumed based on token usage. Unused credits expire at the end of each billing period. Refunds are provided only as required by applicable law." },
        { title: "Intellectual Property", content: "Websites and content created using our AI builder belong to you. Our platform, technology, and underlying AI models remain our intellectual property." },
        { title: "Limitation of Liability", content: "Pembantu.Online is not liable for indirect damages arising from use of the service. Our total liability is limited to the amount paid for the service in the preceding 12 months." },
        { title: "Termination", content: "We may terminate accounts for violation of these terms. You may cancel at any time through the dashboard." }
      ]
    };
  });

  app.post("/legal/accept-terms/:client_id", async (req, reply) => {
    const { rows } = await pool.query(
      "UPDATE clients SET terms_accepted = true, terms_accepted_at = NOW() WHERE id = $1 RETURNING id, name, terms_accepted, terms_accepted_at",
      [req.params.client_id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "Client not found" });
    return { ok: true, client: rows[0] };
  });

  app.get("/legal/check-terms/:client_id", async (req, reply) => {
    const { rows } = await pool.query(
      "SELECT terms_accepted, terms_accepted_at FROM clients WHERE id = $1",
      [req.params.client_id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "Client not found" });
    return rows[0];
  });

  // ============ WHATSAPP POLICIES ============
  app.get("/whatsapp/policies/:client_id", async (req, reply) => {
    const { rows } = await pool.query(
      "SELECT whatsapp_policies FROM clients WHERE id = $1",
      [req.params.client_id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "Client not found" });
    return rows[0].whatsapp_policies || {};
  });

  app.post("/whatsapp/policies/:client_id", async (req, reply) => {
    const { dm_policy, group_policy, group_only, auto_reply_dm, auto_reply_group } = req.body || {};
    await pool.query(
      "UPDATE clients SET whatsapp_policies = $1 WHERE id = $2",
      [JSON.stringify({
        dm_policy: dm_policy || "",
        group_policy: group_policy || "",
        group_only: !!group_only,
        auto_reply_dm: auto_reply_dm !== false,
        auto_reply_group: !!auto_reply_group
      }), req.params.client_id]
    );
    return { ok: true };
  });

  // ============ MEDIA STORAGE ============
  app.get("/storage/:client_id", async (req, reply) => {
    const { rows } = await pool.query(
      "SELECT c.storage_limit_bytes, c.storage_used_bytes, c.storage_addon_gb FROM clients c WHERE c.id = $1",
      [req.params.client_id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "Client not found" });
    const r = rows[0];
    const limitWithAddon = (r.storage_limit_bytes || 52428800) + (r.storage_addon_gb || 0) * 1073741824;
    return {
      limitBytes: limitWithAddon,
      usedBytes: r.storage_used_bytes || 0,
      usedMB: Math.round((r.storage_used_bytes || 0) / 1048576),
      limitMB: Math.round(limitWithAddon / 1048576),
      percentUsed: limitWithAddon > 0 ? Math.round(((r.storage_used_bytes || 0) / limitWithAddon) * 100) : 0,
      addonGB: r.storage_addon_gb || 0,
      addonPrice: 9.90
    };
  });

  app.post("/storage/refresh/:client_id", async (req, reply) => {
    const baseDir = "/var/www/clients/" + req.params.client_id;
    const { execSync } = await import("child_process");
    try {
      const result = execSync('du -sb "' + baseDir + '/refs" "' + baseDir + '/public" 2>/dev/null | awk \'{s+=$1} END {print s}\'');
      const usedBytes = parseInt(result.toString().trim()) || 0;
      await pool.query("UPDATE clients SET storage_used_bytes = $1 WHERE id = $2", [usedBytes, req.params.client_id]);
      return { ok: true, usedBytes };
    } catch {
      return { ok: true, usedBytes: 0 };
    }
  });

  // ============ WEBSITE PREVIEW ============
  app.get("/website/preview/:client_id", async (req, reply) => {
    const baseDir = "/var/www/clients/" + req.params.client_id + "/public";
    if (!fs.existsSync(baseDir)) {
      return { files: [], url: null };
    }
    const client = await pool.query("SELECT id FROM clients WHERE id = $1", [req.params.client_id]);
    if (!client.rows[0]) return reply.code(404).send({ error: "Not found" });
    return {
      url: "https://" + req.params.client_id + ".pembantu.online",
      files: fs.readdirSync(baseDir).filter(f => !f.startsWith("."))
    };
  });

  // ============ PRODUCTS WITH STORAGE ============
  app.get("/products/public", async (req, reply) => {
    const { rows } = await pool.query(
      "SELECT id, name, description, price, billing_interval, credits_included, features, active, storage_mb, storage_addon_price FROM products WHERE active = true ORDER BY sort_order, price"
    );
    // Add storage add-on as virtual product
    const addon = {
      id: "storage-addon",
      name: "Additional Storage",
      description: "Extra 1GB storage for media files (menus, catalogs, QR codes, documents)",
      price: 9.90,
      billing_interval: "month",
      credits_included: 0,
      features: ["1GB additional storage", "Shared across all media refs", "Auto-scaling"],
      active: true,
      is_addon: true,
      storage_mb: 1024,
      storage_addon_price: 9.90
    };
    return [...rows, addon];
  });
}
