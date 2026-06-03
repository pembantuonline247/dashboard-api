// AI Chat handler for Pembantu.Online
// Connects to Nexos AI, tracks per-client usage, deducts AI Credits
import https from "https";

const NEXOS_KEY = "nexos-team-0b3ff8a01fafb409b1653195f04ca7251b8ffe06686443414fa8e121a50f4a3247deef4f836d6d81aaed1c97001256ada2e9bfdb374fbc3955b88e00ef1c5188";
const FLASH_MODEL = "4a8a7c5f-fcda-42bf-b2bb-1760f8598131";
const PRO_MODEL = "f6583f1c-c251-4a4c-bf20-510295fc9087";
const TOKENS_PER_CREDIT = 50000;

// In-memory conversation history per client (resets on restart, which is fine)
const conversations = new Map();

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function buildSystemPrompt(clientName, clientData) {
  return `You are an AI assistant for ${clientName || "a Pembantu.Online client"}. You help manage their business inquiries and automate responses. Be professional, concise, and helpful.

Context: You are running on Pembantu.Online's platform. Respond naturally and helpfully to customer questions. If asked about capabilities, explain that you can handle customer inquiries, provide information about services, and assist with common questions.`;
}

function callNexos(messages, model = FLASH_MODEL) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: 4096,
      stream: false
    });

    const req = https.request(
      {
        hostname: "api.nexos.ai",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${NEXOS_KEY}`,
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Nexos parse error: ${data.slice(0,200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export default async function chatRoutes(app, pool) {
  // POST /chat - send a message as a client
  app.post("/chat", async (req, reply) => {
    const { client_id, message } = req.body || {};
    if (!client_id || !message) {
      return reply.code(400).send({ error: "client_id and message required" });
    }

    // 1. Check remaining credits
    let creditCheck = await pool.query(
      `SELECT COALESCE(SUM(amount_remaining), 0) as remaining
       FROM usage_tracker WHERE client_id = $1 AND credit_type = 'ai' AND period_end > CURRENT_DATE`,
      [client_id]
    );
    let remaining = parseFloat(creditCheck.rows[0]?.remaining || 0);

    if (remaining <= 0) {
      // Try to create a new tracker if subscription exists
      const sub = await pool.query(
        `SELECT p.credits_included FROM subscriptions s
         JOIN products p ON p.id = s.product_id
         WHERE s.client_id = $1 AND s.status = 'active' LIMIT 1`,
        [client_id]
      );
      const credits = sub.rows[0]?.credits_included || 0;
      if (credits <= 0) {
        return reply.code(403).send({ error: "No AI credits remaining. Please top up at the Subscriptions page.", credits: 0 });
      }
      await pool.query(
        `INSERT INTO usage_tracker (client_id, credit_type, amount_remaining, amount_used)
         VALUES ($1, 'ai', $2, 0)`,
        [client_id, credits]
      );
      remaining = credits;
    }

    // 2. Get or create conversation history
    if (!conversations.has(client_id)) {
      const clientRes = await pool.query("SELECT name FROM clients WHERE id = $1", [client_id]);
      const clientName = clientRes.rows[0]?.name || "Client";
      conversations.set(client_id, [
        { role: "system", content: buildSystemPrompt(clientName) }
      ]);
    }
    const history = conversations.get(client_id);
    history.push({ role: "user", content: message });

    // Trim history to last 20 messages (to avoid context overflow)
    if (history.length > 21) {
      const system = history[0];
      const recent = history.slice(-20);
      conversations.set(client_id, [system, ...recent]);
    }

    // 3. Call AI
    let aiReply, inputTokens, outputTokens;
    const session_id = `chat-${client_id}-${Date.now()}`;

    try {
      // Estimate input tokens from history
      inputTokens = history.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);

      const result = await callNexos(history);

      if (result.error) {
        return reply.code(500).send({ error: result.error.message || "AI service error" });
      }

      aiReply = result.choices?.[0]?.message?.content || "I'm sorry, I couldn't process that.";
      outputTokens = result.usage?.completion_tokens || estimateTokens(aiReply);
      inputTokens = result.usage?.prompt_tokens || inputTokens;

      // Store reply in history
      history.push({ role: "assistant", content: aiReply });
    } catch (err) {
      return reply.code(500).send({ error: "AI service unavailable: " + err.message });
    }

    // 4. Log usage and deduct credits
    const totalTokens = inputTokens + outputTokens;
    const creditsConsumed = Math.max(0.001, parseFloat((totalTokens / TOKENS_PER_CREDIT).toFixed(4)));

    try {
      await pool.query(
        `INSERT INTO usage_log (client_id, model, session_id, input_tokens, output_tokens, total_tokens, credits_consumed, endpoint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'chat')`,
        [client_id, 'deepseek-flash', session_id, inputTokens, outputTokens, totalTokens, creditsConsumed]
      );

      await pool.query(
        `UPDATE usage_tracker SET amount_used = amount_used + $1, amount_remaining = amount_remaining - $1
         WHERE client_id = $2 AND credit_type = 'ai' AND period_end > CURRENT_DATE`,
        [creditsConsumed, client_id]
      );
    } catch (err) {
      console.error("Usage logging error:", err.message);
    }

    // 5. Return response
    return {
      reply: aiReply,
      credits: {
        consumed: creditsConsumed,
        remaining: Math.max(0, remaining - creditsConsumed)
      },
      tokens: {
        input: inputTokens,
        output: outputTokens,
        total: totalTokens
      }
    };
  });

  // GET /chat/:client_id/history - get conversation history for chat UI
  app.get("/chat/:client_id/history", async (req, reply) => {
    const history = conversations.get(req.params.client_id) || [];
    // Only return user/assistant messages (hide system prompt)
    const visible = history.filter(m => m.role !== "system").slice(-50);
    return { history: visible };
  });

  // DELETE /chat/:client_id/history - clear conversation
  app.delete("/chat/:client_id/history", async (req, reply) => {
    conversations.delete(req.params.client_id);
    return { ok: true };
  });
}
