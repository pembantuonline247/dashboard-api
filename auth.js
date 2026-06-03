import jwt from "jsonwebtoken";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString("hex");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const ADMIN_EXPIRY = "7d";
const CLIENT_EXPIRY = "30d";

export function generateAdminToken() {
  return jwt.sign({ role: "admin", sub: "admin" }, JWT_SECRET, { expiresIn: ADMIN_EXPIRY });
}

export function generateClientToken(client) {
  return jwt.sign({
    role: "client",
    sub: client.id,
    name: client.name,
    subdomain: client.subdomain,
  }, JWT_SECRET, { expiresIn: CLIENT_EXPIRY });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function authMiddleware(requiredRole = null) {
  return async (req, reply) => {
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }

    if (!token && req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return reply.code(401).send({ error: "Invalid or expired token" });
    }

    if (requiredRole && payload.role !== requiredRole && payload.role !== "admin") {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }

    req.user = payload;
  };
}

export default async function authRoutes(app, pool) {
  app.post("/auth/login", async (req, reply) => {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return reply.code(400).send({ error: "Email and password required" });
    }

    if (email === "admin@pembantu.online" && password === ADMIN_PASSWORD) {
      const token = generateAdminToken();
      reply.setCookie("token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
      });
      return { token, user: { role: "admin", name: "Admin" } };
    }

    const { rows } = await pool.query(
      "SELECT id, name, subdomain FROM clients WHERE id = $1",
      [email]
    );
    if (rows[0]) {
      // Client auth placeholder
    }

    return reply.code(401).send({ error: "Invalid credentials" });
  });

  app.get("/auth/me", { preHandler: [authMiddleware()] }, async (req, reply) => {
    return { user: req.user };
  });

  app.post("/auth/logout", async (req, reply) => {
    reply.clearCookie("token", { path: "/" });
    return { ok: true };
  });
}
