export default async function catalogRoutes(app, pool) {
  // GET /products - public product catalog
  app.get("/products", async (req, reply) => {
    const { rows } = await pool.query(
      "SELECT * FROM products WHERE active = true ORDER BY sort_order"
    );
    return rows;
  });

  // GET /subscriptions/:client_id
  app.get("/subscriptions/:client_id", async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT s.*, p.name as product_name, p.price, p.billing_interval, p.credits_included, p.features
       FROM subscriptions s JOIN products p ON p.id = s.product_id
       WHERE s.client_id = $1 ORDER BY s.created_at DESC`,
      [req.params.client_id]
    );
    return rows;
  });

  // POST /subscriptions - create or upgrade subscription
  app.post("/subscriptions", async (req, reply) => {
    const { client_id, product_id, plan_type } = req.body;
    await pool.query(
      "UPDATE subscriptions SET status = 'cancelled', end_date = CURRENT_DATE WHERE client_id = $1 AND status = 'active'",
      [client_id]
    );
    const { rows } = await pool.query(
      `INSERT INTO subscriptions (client_id, product_id, plan_type, start_date, end_date)
       VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + INTERVAL '1 month')
       RETURNING *`,
      [client_id, product_id, plan_type || 'starter']
    );
    return rows[0];
  });

  // GET /usage/:client_id - get current usage summary
  app.get("/usage/:client_id", async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN credit_type = 'ai' THEN amount_used END), 0) as ai_used,
         COALESCE(SUM(CASE WHEN credit_type = 'ai' THEN amount_remaining END), 0) as ai_remaining
       FROM usage_tracker WHERE client_id = $1 AND period_end > CURRENT_DATE`,
      [req.params.client_id]
    );
    return rows[0];
  });

  // POST /usage/record - record credit usage
  app.post("/usage/record", async (req, reply) => {
    const { client_id, credit_type, amount } = req.body;
    let { rows } = await pool.query(
      `SELECT id, amount_remaining FROM usage_tracker
       WHERE client_id = $1 AND credit_type = $2 AND period_end > CURRENT_DATE
       LIMIT 1`,
      [client_id, credit_type]
    );
    if (rows.length === 0) {
      const sub = await pool.query(
        `SELECT s.id, p.credits_included FROM subscriptions s
         JOIN products p ON p.id = s.product_id
         WHERE s.client_id = $1 AND s.status = 'active' LIMIT 1`,
        [client_id]
      );
      const credits = sub.rows[0]?.credits_included || 5;
      const { rows: newRows } = await pool.query(
        `INSERT INTO usage_tracker (client_id, credit_type, amount_remaining, amount_used)
         VALUES ($1, $2, $3, 0) RETURNING id, amount_remaining`,
        [client_id, credit_type, credits]
      );
      rows = newRows;
    }
    const newRemaining = Math.max(0, parseFloat(rows[0].amount_remaining) - amount);
    await pool.query(
      "UPDATE usage_tracker SET amount_used = amount_used + $1, amount_remaining = $2 WHERE id = $3",
      [amount, newRemaining, rows[0].id]
    );
    return { remaining: newRemaining };
  });

  // WhatsApp config
  app.post("/whatsapp/config/:client_id", async (req, reply) => {
    const { whatsapp, auto_reconnect, reconnect_interval_minutes } = req.body;
    await pool.query(
      "UPDATE clients SET whatsapp = $1, whatsapp_connected = false WHERE id = $2",
      [whatsapp, req.params.client_id]
    );
    return { ok: true };
  });

  app.get("/whatsapp/config/:client_id", async (req, reply) => {
    const { rows } = await pool.query(
      "SELECT whatsapp, whatsapp_connected, status FROM clients WHERE id = $1",
      [req.params.client_id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    return rows[0];
  });

  // POST /usage/log - record per-session token usage
  app.post("/usage/log", async (req, reply) => {
    const { client_id, model, session_id, input_tokens, output_tokens, endpoint } = req.body;
    const total = (input_tokens || 0) + (output_tokens || 0);
    const TOKENS_PER_CREDIT = 50000;
    const creditsConsumed = parseFloat((total / TOKENS_PER_CREDIT).toFixed(4));

    await pool.query(
      `INSERT INTO usage_log (client_id, model, session_id, input_tokens, output_tokens, total_tokens, credits_consumed, endpoint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [client_id, model || 'deepseek-flash', session_id, input_tokens || 0, output_tokens || 0, total, creditsConsumed, endpoint || 'chat']
    );

    let { rows } = await pool.query(
      `SELECT id, amount_remaining FROM usage_tracker
       WHERE client_id = $1 AND credit_type = 'ai' AND period_end > CURRENT_DATE
       LIMIT 1`,
      [client_id]
    );

    if (rows.length === 0) {
      const sub = await pool.query(
        `SELECT s.id, p.credits_included FROM subscriptions s
         JOIN products p ON p.id = s.product_id
         WHERE s.client_id = $1 AND s.status = 'active' LIMIT 1`,
        [client_id]
      );
      const credits = sub.rows[0]?.credits_included || 5;
      const { rows: newRows } = await pool.query(
        `INSERT INTO usage_tracker (client_id, credit_type, amount_remaining, amount_used)
         VALUES ($1, 'ai', $2, 0) RETURNING id, amount_remaining`,
        [client_id, credits]
      );
      rows = newRows;
    }

    const newRemaining = Math.max(0, parseFloat(rows[0].amount_remaining) - creditsConsumed);
    await pool.query(
      "UPDATE usage_tracker SET amount_used = amount_used + $1, amount_remaining = $2 WHERE id = $3",
      [creditsConsumed, newRemaining, rows[0].id]
    );

    return { credits_consumed: creditsConsumed, credits_remaining: newRemaining, total_tokens: total };
  });

  // GET /usage/logs/:client_id - get usage log with pagination
  app.get("/usage/logs/:client_id", async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await pool.query(
      `SELECT ul.*,
        CASE
          WHEN ul.model LIKE '%pro%' OR ul.model LIKE '%r1%' THEN 'Pro'
          ELSE 'Flash'
        END as tier
       FROM usage_log ul
       WHERE ul.client_id = $1
       ORDER BY ul.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.client_id, limit, offset]
    );

    const { rows: totals } = await pool.query(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as total_input,
         COALESCE(SUM(output_tokens), 0) as total_output,
         COALESCE(SUM(credits_consumed), 0) as total_credits
       FROM usage_log WHERE client_id = $1`,
      [req.params.client_id]
    );

    return { logs: rows, totals: totals[0] };
  });
}
