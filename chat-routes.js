// AI Chat handler for Pembantu.Online
// Routes through OpenClaw agent instead of calling Nexos API directly
// so users can use the bot's full skills (browser, integrations, etc.)
import { execSync } from "child_process";

const TOKENS_PER_CREDIT = 50000;

// In-memory conversation history per client (resets on restart, which is fine)
const conversations = new Map();

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
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
      const clientRes = await pool.query("SELECT name, whatsapp FROM clients WHERE id = $1", [client_id]);
      const clientData = clientRes.rows[0] || {};
      const clientName = clientData.name || "Client";
      const clientWhatsApp = clientData.whatsapp || "unknown";

      conversations.set(client_id, [
        {
          role: "system",
          content: `You are an AI assistant for ${clientName}, a Pembantu.Online client. You help manage their business inquiries and automate responses. Be professional, concise, and helpful in Bahasa Malaysia or English as appropriate.

Client details:
- Name: ${clientName}
- WhatsApp: ${clientWhatsApp}

You have access to all OpenClaw tools and skills (browser, web search, integrations, etc.). Use them when needed to help the client.`
        }
      ]);
    }
    const history = conversations.get(client_id);
    history.push({ role: "user", content: message });

    // Trim history to last 10 exchanges (to avoid context overflow)
    if (history.length > 12) {
      const system = history[0];
      const recent = history.slice(-10);
      conversations.set(client_id, [system, ...recent]);
    }

    // 3. Route through OpenClaw agent
    let aiReply, inputTokens, outputTokens;
    const session_id = `chat-${client_id}-${Date.now()}`;

    try {
      // Estimate input tokens from history
      inputTokens = history.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);

      // Build context: include last few exchanges for continuity
      const contextMessages = history.slice(-6); // system + recent exchanges
      const contextStr = contextMessages
        .filter(m => m.role !== "system")
        .map(m => `${m.role === "user" ? "Customer" : "You"}: ${m.content}`)
        .join("\n\n");

      const clientInfo = history[0]?.content?.split("\n")?.slice(0, 4)?.join("\n") || "";
      const agentPrompt = `[CONTEXT]\n${clientInfo}\n\n[CONVERSATION]\n${contextStr}\n\nYou:`;

      // Call OpenClaw agent CLI
      const result = execSync(
        `openclaw agent --agent main --message ${JSON.stringify(agentPrompt)} --json 2>/dev/null`,
        { timeout: 120000, cwd: "/root", maxBuffer: 1024 * 1024 }
      );

      const parsed = JSON.parse(result.toString());

      // Extract reply from agent output
      aiReply = parsed?.payloads?.[0]?.text || "I'm sorry, I couldn't process that.";
      const usage = parsed?.meta?.agentMeta?.usage || {};
      outputTokens = usage.output || estimateTokens(aiReply);
      inputTokens = usage.input || inputTokens;

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
        [client_id, 'openclaw-agent', session_id, inputTokens, outputTokens, totalTokens, creditsConsumed]
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

  // POST /chat/:client_id/test - test bot route for +60175797694
  app.post("/chat/:client_id/test", async (req, reply) => {
    const { client_id } = req.params;
    const { message } = req.body || {};
    if (!message) {
      return reply.code(400).send({ error: "message required" });
    }

    try {
      const agentPrompt = `[TEST MODE - Client: ${client_id}]\n\nTest message: ${message}\n\nPlease respond briefly to confirm the bot is working.`;
      const result = execSync(
        `openclaw agent --agent main --message ${JSON.stringify(agentPrompt)} --json 2>/dev/null`,
        { timeout: 120000, cwd: "/root", maxBuffer: 1024 * 1024 }
      );
      const parsed = JSON.parse(result.toString());
      const aiReply = parsed?.payloads?.[0]?.text || "I'm sorry, I couldn't process that.";
      return { reply: aiReply, test: true };
    } catch (err) {
      return reply.code(500).send({ error: "Test bot unavailable: " + err.message });
    }
  });

  // GET /chat/:client_id/history - get conversation history for chat UI
  app.get("/chat/:client_id/history", async (req, reply) => {
    const history = conversations.get(req.params.client_id) || [];
    const visible = history.filter(m => m.role !== "system").slice(-50);
    return { history: visible };
  });

  // DELETE /chat/:client_id/history - clear conversation
  app.delete("/chat/:client_id/history", async (req, reply) => {
    conversations.delete(req.params.client_id);
    return { ok: true };
  });
}
