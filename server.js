import Fastify from "fastify";
import cors from "@fastify/cors";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  user: "pembantu",
  password: "P3mb@ntuDB2026!",
  host: "localhost",
  database: "pembantu_online",
  port: 5432,
});

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

// Init DB tables
await pool.query(`
  CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    subdomain TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT pending,
    whatsapp TEXT,
    whatsapp_connected BOOLEAN DEFAULT false,
    plan TEXT DEFAULT starter,
    messages_count INTEGER DEFAULT 0,
    sessions_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    currency TEXT DEFAULT MYR,
    status TEXT DEFAULT pending,
    due_date DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`);

// GET /api/clients
app.get("/clients", async (req, reply) => {
  const { rows } = await pool.query(
    "SELECT id, name, subdomain, status, whatsapp, whatsapp_connected, plan, messages_count as messages, sessions_count as sessions, created_at FROM clients ORDER BY created_at DESC"
  );
  return rows.map(r => ({
    ...r,
    usage: { messages: r.messages, sessions: r.sessions },
    createdAt: r.created_at,
    whatsappConnected: r.whatsapp_connected,
  }));
});

// GET /api/clients/:id
app.get("/clients/:id", async (req, reply) => {
  const { rows } = await pool.query(
    "SELECT id, name, subdomain, status, whatsapp, whatsapp_connected, plan, messages_count as messages, sessions_count as sessions, created_at FROM clients WHERE id = $1",
    [req.params.id]
  );
  if (!rows[0]) return reply.code(404).send({ error: "Not found" });
  const r = rows[0];
  return { ...r, usage: { messages: r.messages, sessions: r.sessions }, createdAt: r.created_at, whatsappConnected: r.whatsapp_connected };
});

// POST /api/clients
app.post("/clients", async (req, reply) => {
  const { name, subdomain, whatsapp, plan } = req.body;
  const { rows } = await pool.query(
    "INSERT INTO clients (name, subdomain, whatsapp, plan) VALUES ($1, $2, $3, $4) RETURNING id, name, subdomain, status, whatsapp, whatsapp_connected, plan, messages_count, sessions_count, created_at",
    [name, subdomain, whatsapp || null, plan || "starter"]
  );
  const r = rows[0];
  return { ...r, usage: { messages: r.messages_count, sessions: r.sessions_count }, createdAt: r.created_at, whatsappConnected: r.whatsapp_connected };
});

// DELETE /api/clients/:id
app.delete("/clients/:id", async (req, reply) => {
  await pool.query("DELETE FROM clients WHERE id = $1", [req.params.id]);
  return { ok: true };
});

// GET /api/clients/:id/whatsapp/qr
app.get("/clients/:id/whatsapp/qr", async (req, reply) => {
  // Placeholder - actual WhatsApp QR generation TBD
  return { qr: "" };
});

// GET /api/invoices
app.get("/invoices", async (req, reply) => {
  const { rows } = await pool.query(
    "SELECT i.id, i.client_id, c.name as client_name, i.amount, i.currency, i.status, i.due_date FROM invoices i JOIN clients c ON c.id = i.client_id ORDER BY i.created_at DESC"
  );
  return rows.map(r => ({
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    amount: parseFloat(r.amount),
    currency: r.currency,
    status: r.status,
    dueDate: r.due_date,
  }));
});

// POST /api/invoices (for Stripe FPX integration)
app.post("/invoices", async (req, reply) => {
  const { client_id, amount, currency, due_date } = req.body;
  const { rows } = await pool.query(
    "INSERT INTO invoices (client_id, amount, currency, due_date) VALUES ($1, $2, $3, $4) RETURNING *",
    [client_id, amount, currency || "MYR", due_date]
  );
  return rows[0];
});

// GET /api/_openclaw/system/stats
app.get("/_openclaw/system/stats", async (req, reply) => {
  const os = await import("os");
  const cpus = os.cpus();
  const load = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    cpu: parseFloat((load[0] / cpus.length * 100).toFixed(1)),
    memory: { total: totalMem, used: totalMem - freeMem, free: freeMem },
    uptime: os.uptime(),
    gateways: [{ id: "main", port: 18789, status: "online" }],
  };
});

// Start
const port = 3001;
await app.listen({ port, host: "127.0.0.1" });
console.log(`API server running on port ${port}`);
