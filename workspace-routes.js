// Workspace & Website Builder Routes
// File management, AI website creation, DNS setup, preview hosting
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const NEXOS_KEY = "nexos-team-0b3ff8a01fafb409b1653195f04ca7251b8ffe06686443414fa8e121a50f4a3247deef4f836d6d81aaed1c97001256ada2e9bfdb374fbc3955b88e00ef1c5188";
const FLASH_MODEL = "4a8a7c5f-fcda-42bf-b2bb-1760f8598131";
const CLOUDFLARE_TOKEN = process.env.CLOUDFLARE_TOKEN || "";
const CLOUDFLARE_ZONE_ID = "1279142adc6129c5e95b9e29cfed3420";
const CLIENTS_ROOT = "/var/www/clients";
const DOMAIN = "pembantu.online";

// ============ WORKSPACE HELPERS ============

function getClientDir(clientId, subpath = "") {
  const dir = path.join(CLIENTS_ROOT, clientId, subpath);
  // Security: prevent path traversal
  if (!dir.startsWith(CLIENTS_ROOT)) return null;
  return dir;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  const result = [];
  for (const item of items) {
    if (item.name.startsWith(".")) continue;
    const fullPath = path.join(dir, item.name);
    result.push({
      name: item.name,
      isDirectory: item.isDirectory(),
      size: item.isFile() ? fs.statSync(fullPath).size : 0,
      ext: item.isFile() ? path.extname(item.name).toLowerCase() : "",
      modifiedAt: fs.statSync(fullPath).mtime.toISOString()
    });
  }
  return result.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
}

function readFileSafe(filePath) {
  if (!filePath.startsWith(CLIENTS_ROOT)) return null;
  if (!fs.existsSync(filePath)) return null;
  if (fs.statSync(filePath).isDirectory()) return null;
  return fs.readFileSync(filePath, "utf-8");
}

function isTextFile(ext) {
  const textExts = [".html", ".htm", ".css", ".js", ".ts", ".json", ".md", ".txt",
    ".xml", ".svg", ".yaml", ".yml", ".toml", ".env", ".sh", ".py", ".jsx", ".tsx",
    ".php", ".rb", ".go", ".rs", ".vue", ".svelte", ".astro"];
  return textExts.includes(ext);
}

function getMimeType(ext) {
  const mimes = {
    ".html": "text/html", ".htm": "text/html", ".css": "text/css",
    ".js": "application/javascript", ".json": "application/json",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".ico": "image/x-icon", ".pdf": "application/pdf",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf"
  };
  return mimes[ext] || "application/octet-stream";
}

// ============ CLOUDFLARE DNS ============

function cloudflareApi(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.cloudflare.com",
      path: `/client/v4${path}`,
      method,
      headers: {
        "Authorization": `Bearer ${CLOUDFLARE_TOKEN}`,
        "Content-Type": "application/json"
      }
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function setupDNS(subdomain, ip) {
  const name = `${subdomain}.${DOMAIN}`;

  // Check existing records
  const existing = await cloudflareApi("GET", `/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${name}&type=A`);
  if (existing.success && existing.result.length > 0) {
    // Update existing
    const id = existing.result[0].id;
    return cloudflareApi("PUT", `/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${id}`, {
      type: "A", name, content: ip, ttl: 120, proxied: false
    });
  }

  // Create new
  return cloudflareApi("POST", `/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
    type: "A", name, content: ip, ttl: 120, proxied: false
  });
}

async function removeDNS(subdomain) {
  const name = `${subdomain}.${DOMAIN}`;
  const existing = await cloudflareApi("GET", `/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${name}&type=A`);
  if (existing.success) {
    for (const record of existing.result) {
      await cloudflareApi("DELETE", `/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${record.id}`);
    }
  }
}

// ============ NGINX CONFIG ============

function setupNginx(subdomain, clientId) {
  const serverName = `${subdomain}.${DOMAIN}`;
  const root = getClientDir(clientId, "public");
  const config = `server {
    listen 80;
    server_name ${serverName};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${serverName};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root ${root};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
        add_header X-Frame-Options "SAMEORIGIN" always;
    }

    location /uploads/ {
        alias ${root}/uploads/;
    }
}
`;
  const configPath = `/etc/nginx/sites-enabled/${subdomain}.${DOMAIN}`;
  try {
    // Remove old config if exists
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  } catch {}
  fs.writeFileSync(configPath, config);
  return configPath;
}

// ============ AI WEBSITE GENERATOR ============

function callNexos(messages, maxTokens = 4096) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: FLASH_MODEL,
      messages,
      max_tokens: maxTokens,
      stream: false
    });
    const req = https.request({
      hostname: "api.nexos.ai", path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${NEXOS_KEY}`,
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function generateWebsite(clientId, prompt) {
  const clientDir = getClientDir(clientId, "public");
  ensureDir(clientDir);
  ensureDir(path.join(clientDir, "uploads"));

  const systemPrompt = `You are a professional web developer. Create a complete, production-ready website based on the user's request.

Output ALL files needed for the website. For each file, use this exact format:

---FILE: filename.ext
file content here
---

Rules:
- Always include index.html as the main page
- Use modern HTML5, CSS3, and vanilla JS (no frameworks unless requested)
- Make it responsive and mobile-friendly
- Include inline CSS in <style> tags or provide a separate style.css
- Use semantic HTML
- Make it visually appealing with good color schemes
- All files go in the same directory (no subdirectories)
- Do NOT include markdown outside the file blocks

For a landing page, include:
- Hero section with headline, subtext, and CTA
- Features/services section
- About section
- Contact section
- Footer
- Responsive navigation`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt }
  ];

  const result = await callNexos(messages, 8192);
  const reply = result.choices?.[0]?.message?.content || "";

  // Parse file blocks from the response
  const fileRegex = /---FILE:\s*(.+?)\s*\n([\s\S]*?)(?=\n---FILE:|$)/g;
  let match;
  let filesCreated = [];
  let hasIndex = false;

  while ((match = fileRegex.exec(reply)) !== null) {
    const fileName = match[1].trim();
    const content = match[2].trim();
    if (!fileName) continue;
    if (fileName === "index.html") hasIndex = true;
    const filePath = path.join(clientDir, fileName);
    if (filePath.startsWith(clientDir)) {
      fs.writeFileSync(filePath, content);
      filesCreated.push(fileName);
    }
  }

  // If no index.html, generate one from any files created
  if (!hasIndex && filesCreated.length === 0) {
    // Try regenerating with stricter instructions
    fs.writeFileSync(path.join(clientDir, "index.html"), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${prompt.slice(0, 60)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    h1 { text-align: center; margin-top: 3rem; color: #1e293b; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${prompt}</h1>
    <p style="text-align:center;color:#64748b;margin-top:1rem;">Generating your website...</p>
  </div>
</body>
</html>`);
    filesCreated.push("index.html");
  }

  return {
    reply: `Created ${filesCreated.length} file(s): ${filesCreated.join(", ")}`,
    files: filesCreated,
    preview: `https://${clientId.slice(0, 8)}.${DOMAIN}`
  };
}

async function editWebsite(clientId, prompt, existingContent) {
  const systemPrompt = `You are editing an existing website. Below is the current file content. Apply the requested changes and return ONLY the complete updated file content (no explanations, no markdown, no file headers). Return the ENTIRE file, not just the changes.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Current file:\n\`\`\`\n${existingContent}\n\`\`\`\n\nRequested change: ${prompt}\n\nReturn ONLY the updated file content.` }
  ];

  const result = await callNexos(messages, 8192);
  return result.choices?.[0]?.message?.content?.replace(/```/g, "").trim() || "";
}

// ============ EXPRESS ROUTES ============

export default async function workspaceRoutes(app, pool) {
  const VPS_IP = "74.113.234.208";

  // === FILE MANAGEMENT ===

  // GET /workspace/:client_id/files - list files
  app.get("/workspace/:client_id/files", async (req, reply) => {
    const dir = getClientDir(req.params.client_id, "public");
    if (!dir) return reply.code(400).send({ error: "Invalid client ID" });
    ensureDir(dir);
    return { files: listFiles(dir), path: `public/` };
  });

  // GET /workspace/:client_id/files/* - read file
  app.get("/workspace/:client_id/files/*", async (req, reply) => {
    const filePath = getClientDir(req.params.client_id, `public/${req.params['*']}`);
    if (!filePath || !filePath.startsWith(getClientDir(req.params.client_id, "public"))) {
      return reply.code(400).send({ error: "Invalid path" });
    }
    const content = readFileSafe(filePath);
    if (content === null) return reply.code(404).send({ error: "File not found" });
    return { name: path.basename(filePath), content, ext: path.extname(filePath) };
  });

  // POST /workspace/:client_id/files/write - create/update file
  app.post("/workspace/:client_id/files/write", async (req, reply) => {
    const { name, content } = req.body;
    if (!name || content === undefined) return reply.code(400).send({ error: "name and content required" });
    // Prevent path traversal
    const cleanName = path.basename(name);
    const clientDir = getClientDir(req.params.client_id, "public");
    if (!clientDir) return reply.code(400).send({ error: "Invalid client" });
    ensureDir(clientDir);
    const filePath = path.join(clientDir, cleanName);
    if (!filePath.startsWith(clientDir)) return reply.code(400).send({ error: "Invalid path" });
    fs.writeFileSync(filePath, content);
    return { ok: true, name: cleanName, size: Buffer.byteLength(content) };
  });

  // POST /workspace/:client_id/files/delete - delete file
  app.post("/workspace/:client_id/files/delete", async (req, reply) => {
    const { name } = req.body;
    if (!name) return reply.code(400).send({ error: "name required" });
    const cleanName = path.basename(name);
    const filePath = getClientDir(req.params.client_id, `public/${cleanName}`);
    if (!filePath || !filePath.startsWith(getClientDir(req.params.client_id, "public"))) {
      return reply.code(400).send({ error: "Invalid path" });
    }
    try {
      fs.unlinkSync(filePath);
      return { ok: true };
    } catch (e) {
      return reply.code(404).send({ error: "File not found" });
    }
  });

  // POST /workspace/:client_id/files/upload - upload file
  app.post("/workspace/:client_id/files/upload", async (req, reply) => {
    // For multipart uploads, we use raw body
    const boundary = req.headers["content-type"]?.match(/boundary=(.+)/)?.[1];
    if (!boundary) return reply.code(400).send({ error: "multipart/form-data required" });

    const clientDir = getClientDir(req.params.client_id, "public");
    if (!clientDir) return reply.code(400).send({ error: "Invalid client" });
    ensureDir(clientDir);

    // Simple multipart parser
    const raw = req.body; // Buffer
    if (!raw || raw.length === 0) return reply.code(400).send({ error: "No data" });

    const parts = raw.toString("binary").split(boundary);
    let saved = [];

    for (const part of parts) {
      const headerMatch = part.match(/name="([^"]+)"\s*(?:filename="([^"]*)")?/);
      if (!headerMatch) continue;
      const fieldName = headerMatch[1];
      const fileName = headerMatch[2];

      // Split headers from content
      const sep = "\r\n\r\n";
      const sepIdx = part.indexOf(sep);
      if (sepIdx === -1) continue;
      const content = part.slice(sepIdx + sep.length).replace(/\r\n--$/, "").replace(/\r\n$/, "");

      if (fileName) {
        const cleanName = path.basename(fileName);
        const filePath = path.join(clientDir, cleanName);
        if (filePath.startsWith(clientDir)) {
          fs.writeFileSync(filePath, content, "binary");
          saved.push(cleanName);
        }
      }
    }

    return { ok: true, files: saved };
  });

  // === DNS & HOSTING ===

  // POST /workspace/:client_id/publish - publish website & setup DNS
  app.post("/workspace/:client_id/publish", async (req, reply) => {
    const { id } = req.params;
    // Get client info
    const { rows } = await pool.query("SELECT name, subdomain FROM clients WHERE id = $1", [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Client not found" });
    const client = rows[0];
    const subdomain = client.subdomain.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);

    try {
      // 1. Setup DNS on Cloudflare
      const dnsResult = await setupDNS(subdomain, VPS_IP);
      if (!dnsResult.success) {
        return reply.code(500).send({ error: "DNS setup failed", details: dnsResult.errors });
      }

      // 2. Setup Nginx
      const clientDir = getClientDir(id, "public");
      ensureDir(clientDir);
      setupNginx(subdomain, id);

      // 3. Reload nginx
      execSync("nginx -t && systemctl reload nginx", { timeout: 10000 });

      // 4. Update client record with domain
      const domain = `${subdomain}.${DOMAIN}`;
      await pool.query("UPDATE clients SET subdomain = $1 WHERE id = $2", [subdomain, id]);

      return {
        ok: true,
        domain,
        previewUrl: `https://${domain}`,
        dnsRecord: `A record ${subdomain}.${DOMAIN} → ${VPS_IP}`
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /workspace/:client_id/unpublish - remove site
  app.post("/workspace/:client_id/unpublish", async (req, reply) => {
    const { id } = req.params;
    const { rows } = await pool.query("SELECT subdomain FROM clients WHERE id = $1", [id]);
    if (rows[0]?.subdomain) {
      try {
        await removeDNS(rows[0].subdomain);
        const configPath = `/etc/nginx/sites-enabled/${rows[0].subdomain}.${DOMAIN}`;
        if (fs.existsSync(configPath)) {
          fs.unlinkSync(configPath);
          execSync("nginx -t && systemctl reload nginx", { timeout: 10000 });
        }
      } catch {}
    }
    return { ok: true };
  });

  // GET /workspace/:client_id/domain - get domain info
  app.get("/workspace/:client_id/domain", async (req, reply) => {
    const { rows } = await pool.query("SELECT subdomain FROM clients WHERE id = $1", [req.params.client_id]);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    const subdomain = rows[0].subdomain;
    return {
      domain: subdomain ? `${subdomain}.${DOMAIN}` : null,
      subdomain,
      dnsConfigured: subdomain ? true : false
    };
  });

  // === AI WEBSITE BUILDER ===

  // POST /workspace/:client_id/ai/generate - AI generates a full website
  app.post("/workspace/:client_id/ai/generate", async (req, reply) => {
    const { prompt } = req.body;
    if (!prompt) return reply.code(400).send({ error: "prompt required" });
    try {
      const result = await generateWebsite(req.params.client_id, prompt);
      return result;
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /workspace/:client_id/ai/edit - AI edits a file
  app.post("/workspace/:client_id/ai/edit", async (req, reply) => {
    const { file, prompt } = req.body;
    if (!file || !prompt) return reply.code(400).send({ error: "file and prompt required" });
    const filePath = getClientDir(req.params.client_id, `public/${file}`);
    if (!filePath || !filePath.startsWith(getClientDir(req.params.client_id, "public"))) {
      return reply.code(400).send({ error: "Invalid path" });
    }
    const content = readFileSafe(filePath);
    if (!content) return reply.code(404).send({ error: "File not found" });
    try {
      const updated = await editWebsite(req.params.client_id, prompt, content);
      fs.writeFileSync(filePath, updated);
      return { ok: true, name: file, size: Buffer.byteLength(updated) };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /workspace/:client_id/ai/chat - AI website chat (context-aware)
  app.post("/workspace/:client_id/ai/chat", async (req, reply) => {
    const { message, file } = req.body;
    if (!message) return reply.code(400).send({ error: "message required" });

    const clientDir = getClientDir(req.params.client_id, "public");
    const files = listFiles(clientDir);
    let fileContext = "";
    if (file) {
      const filePath = path.join(clientDir, file);
      const content = readFileSafe(filePath);
      if (content) fileContext = `\n\nCurrently viewing: ${file}\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\``;
    }

    const systemPrompt = `You are a web development assistant helping build a website. Current project files:
${files.map(f => `  ${f.isDirectory ? "📁" : "📄"} ${f.name}${f.isFile ? ` (${f.size} bytes)` : ""}`).join("\n")}
${fileContext}

You can help:
- Create new pages/files
- Edit existing files
- Review code for issues
- Suggest improvements
- Debug problems
- Add features

When the user asks to create or modify a file, respond with a JSON action:
{"action":"write","file":"filename.ext","content":"file content here"}

When answering questions, respond with:
{"action":"reply","text":"your response here"}

Always wrap your response in one of these JSON formats.`;

    try {
      const result = await callNexos([
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ], 8192);
      const reply = result.choices?.[0]?.message?.content || "";

      // Try to parse JSON action
      try {
        const action = JSON.parse(reply);
        if (action.action === "write" && action.file) {
          const cleanName = path.basename(action.file);
          const filePath = path.join(clientDir, cleanName);
          if (filePath.startsWith(clientDir)) {
            ensureDir(clientDir);
            fs.writeFileSync(filePath, action.content);
            return { action: "write", file: cleanName, text: `Created/updated ${cleanName}` };
          }
        }
        if (action.action === "reply") {
          return { action: "reply", text: action.text };
        }
      } catch {}

      // Not JSON, return as text
      return { action: "reply", text: reply };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // === REFERENCE FILES ===

  // POST /workspace/:client_id/refs/upload - upload reference files for AI
  app.post("/workspace/:client_id/refs/upload", async (req, reply) => {
    const refDir = getClientDir(req.params.client_id, "refs");
    if (!refDir) return reply.code(400).send({ error: "Invalid client" });
    ensureDir(refDir);

    const boundary = req.headers["content-type"]?.match(/boundary=(.+)/)?.[1];
    if (!boundary) return reply.code(400).send({ error: "multipart required" });

    const raw = req.body;
    if (!raw || raw.length === 0) return reply.code(400).send({ error: "No data" });

    const parts = raw.toString("binary").split(boundary);
    let saved = [];

    for (const part of parts) {
      const headerMatch = part.match(/name="([^"]+)"\s*(?:filename="([^"]*)")?/);
      if (!headerMatch) continue;
      const fileName = headerMatch[2];
      if (!fileName) continue;
      const sep = "\r\n\r\n";
      const sepIdx = part.indexOf(sep);
      if (sepIdx === -1) continue;
      const content = part.slice(sepIdx + sep.length).replace(/\r\n--$/, "").replace(/\r\n$/, "");
      const cleanName = path.basename(fileName);
      const filePath = path.join(refDir, cleanName);
      if (filePath.startsWith(refDir)) {
        fs.writeFileSync(filePath, content, "binary");
        saved.push(cleanName);
      }
    }

    return { ok: true, files: saved };
  });

  // GET /workspace/:client_id/refs - list reference files
  app.get("/workspace/:client_id/refs", async (req, reply) => {
    const refDir = getClientDir(req.params.client_id, "refs");
    if (!refDir) return reply.code(400).send({ error: "Invalid client" });
    ensureDir(refDir);
    return { files: listFiles(refDir) };
  });

  // DELETE /workspace/:client_id/refs/:name - delete reference
  app.delete("/workspace/:client_id/refs/:name", async (req, reply) => {
    const filePath = getClientDir(req.params.client_id, `refs/${req.params.name}`);
    if (!filePath || !filePath.startsWith(getClientDir(req.params.client_id, "refs"))) {
      return reply.code(400).send({ error: "Invalid" });
    }
    try {
      fs.unlinkSync(filePath);
      return { ok: true };
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });
}
