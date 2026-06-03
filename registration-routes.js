import crypto from "crypto";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "620d1c…6d0d";

function generateClientToken(client) {
  return jwt.sign({
    role: "client",
    sub: client.id,
    name: client.name,
    subdomain: client.subdomain,
  }, JWT_SECRET, { expiresIn: "30d" });
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.pbkdf2(password, salt, 100000, 64, "sha512", (err, derivedKey) => {
      if (err) reject(err);
      resolve(salt + ":" + derivedKey.toString("hex"));
    });
  });
}

function verifyPassword(password, hash) {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(":");
    crypto.pbkdf2(password, salt, 100000, 64, "sha512", (err, derivedKey) => {
      if (err) reject(err);
      resolve(derivedKey.toString("hex") === key);
    });
  });
}

export default async function registrationRoutes(app, pool) {
  // POST /auth/register - client self-signup
  app.post("/auth/register", async (req, reply) => {
    const { name, email, whatsapp, password, plan_id } = req.body || {};

    if (!name || !email || !password) {
      return reply.code(400).send({ error: "Business name, email, and password are required" });
    }
    if (password.length < 6) {
      return reply.code(400).send({ error: "Password must be at least 6 characters" });
    }

    const existing = await pool.query(
      "SELECT id FROM clients WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: "An account with this email already exists" });
    }

    let subdomain = name.toLowerCase()
      .replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    if (!subdomain) subdomain = "client-" + crypto.randomBytes(4).toString("hex");

    const subCheck = await pool.query("SELECT id FROM clients WHERE subdomain = $1", [subdomain]);
    if (subCheck.rows.length > 0) {
      subdomain = subdomain + "-" + crypto.randomBytes(3).toString("hex");
    }

    const passwordHash = await hashPassword(password);

    const { rows } = await pool.query(
      `INSERT INTO clients (name, email, whatsapp, password_hash, status, subdomain, plan)
       VALUES ($1, $2, $3, $4, 'active', $5, 'starter')
       RETURNING id, name, email, whatsapp, subdomain, plan, created_at`,
      [name, email, whatsapp || null, passwordHash, subdomain]
    );
    const client = rows[0];

    let creditsIncluded = 5;
    if (plan_id) {
      const planRes = await pool.query("SELECT id, credits_included, price FROM products WHERE id = $1 AND active = true", [plan_id]);
      if (planRes.rows[0]) {
        creditsIncluded = planRes.rows[0].credits_included || 5;
        await pool.query(
          `INSERT INTO subscriptions (client_id, product_id, plan_type, start_date, end_date, status)
           VALUES ($1, $2, 'starter', CURRENT_DATE, CURRENT_DATE + INTERVAL '1 month', 'active')`,
          [client.id, planRes.rows[0].id]
        );
      }
    }

    await pool.query(
      `INSERT INTO usage_tracker (client_id, credit_type, amount_remaining, amount_used)
       VALUES ($1, 'ai', $2, 0)`,
      [client.id, creditsIncluded]
    );

    const token = generateClientToken({
      id: client.id, name: client.name, subdomain: client.subdomain
    });

    reply.setCookie("token", token, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });

    return {
      ok: true, token,
      user: { role: "client", sub: client.id, name: client.name },
      client: { id: client.id, name: client.name, subdomain: client.subdomain, credits: creditsIncluded },
      message: "Account created! Welcome to Pembantu.Online."
    };
  });

  // POST /auth/client-login
  app.post("/auth/client-login", async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return reply.code(400).send({ error: "Email and password required" });
    }
    const { rows } = await pool.query(
      "SELECT id, name, subdomain, password_hash FROM clients WHERE email = $1 AND password_hash IS NOT NULL",
      [email]
    );
    if (!rows[0]) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    const valid = await verifyPassword(password, rows[0].password_hash);
    if (!valid) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    const token = generateClientToken({
      id: rows[0].id, name: rows[0].name, subdomain: rows[0].subdomain
    });
    reply.setCookie("token", token, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return { token, user: { role: "client", sub: rows[0].id, name: rows[0].name } };
  });

  // GET /products/public
  app.get("/products/public", async (req, reply) => {
    const { rows } = await pool.query(
      "SELECT id, name, description, price, currency, billing_interval, credits_included, features, sort_order FROM products WHERE active = true ORDER BY sort_order"
    );
    return rows;
  });
}
