// Client Agent Configuration & Chat Routes
// Each client gets their own OpenClaw agent with configurable identity
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const AGENTS_DIR = "/root/.openclaw/agents";
const OPENCLAW_CONFIG = "/root/.openclaw/openclaw.json";
const MODEL_ID = "nexos/4a8a7c5f-fcda-42bf-b2bb-1760f8598131";
const TOKENS_PER_CREDIT = 50000;

// In-memory conversation history per client agent (resets on restart)
const conversations = new Map();

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

export default async function agentRoutes(app, pool) {
  // GET /agent/:client_id - return agent config for a client
  app.get("/agent/:client_id", async (req, reply) => {
    const { client_id } = req.params;
    const { rows } = await pool.query(
      "SELECT client_id, agent_name, agent_id, system_prompt, personality, created_at, updated_at FROM client_agent WHERE client_id = $1",
      [client_id]
    );
    if (!rows[0]) {
      // Return defaults if not set up yet
      return {
        client_id,
        agent_name: "Bot",
        agent_id: `client_${client_id.replace(/-/g, "_")}`,
        system_prompt: "You are a helpful assistant.",
        personality: "friendly",
        created_at: null,
        updated_at: null,
      };
    }
    return rows[0];
  });

  // POST /agent/:client_id - create/update agent config
  app.post("/agent/:client_id", async (req, reply) => {
    const { client_id } = req.params;
    const { agent_name, system_prompt, personality } = req.body || {};

    const agent_id = `client_${client_id.replace(/-/g, "_")}`;

    // Upsert into database
    const { rows } = await pool.query(
      `INSERT INTO client_agent (client_id, agent_name, agent_id, system_prompt, personality)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id) DO UPDATE SET
         agent_name = COALESCE($2, client_agent.agent_name),
         system_prompt = COALESCE($4, client_agent.system_prompt),
         personality = COALESCE($5, client_agent.personality),
         agent_id = $3,
         updated_at = NOW()
       RETURNING *`,
      [
        client_id,
        agent_name || "Bot",
        agent_id,
        system_prompt || "You are a helpful assistant.",
        personality || "friendly",
      ]
    );

    const config = rows[0];

    // Create agent directory with SOUL.md
    const agentDir = path.join(AGENTS_DIR, agent_id);
    fs.mkdirSync(agentDir, { recursive: true });

    // Also create workspace directory
    const workspaceDir = `/var/www/clients/${client_id}/agent`;
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Write SOUL.md with personality and system prompt
    const personalityGuide = {
      friendly: "Be warm, approachable, and encouraging. Use casual language and emojis occasionally. Make the user feel comfortable.",
      professional: "Be concise, precise, and business-appropriate. Use formal language. Stay on topic and avoid casual expressions.",
      witty: "Be clever and humorous. Use wordplay, light sarcasm, and pop culture references when appropriate. Keep it entertaining but helpful.",
      formal: "Be extremely polite and proper. Use formal titles and complete sentences. Maintain a respectful distance.",
      casual: "Be relaxed and conversational. Use everyday language, contractions, and a laid-back tone. Chat like a friend.",
    };

    const personalityDesc = personalityGuide[config.personality] || personalityGuide.friendly;

    const soulContent = `# SOUL: ${config.agent_name}

## Identity
You are **${config.agent_name}**, an AI assistant for a Pembantu.Online client.
Your agent ID is \`${agent_id}\`.
You help manage business inquiries, automate responses, and assist customers.

## Personality
Personality: **${config.personality}**
${personalityDesc}

## System Prompt
${config.system_prompt}

## Capabilities
You have access to all OpenClaw tools and skills:
- Web browsing and research
- File system operations
- Code execution
- Integrations with external services
- Communication tools

Use these tools when needed to help the client or their customers.

## Guidelines
1. Always identify yourself as ${config.agent_name} when asked.
2. Be helpful and responsive to the client's needs.
3. Use Bahasa Malaysia or English as appropriate for the conversation.
4. If you need more context or permissions, ask the client.
5. Never share sensitive credentials or API keys.
6. Stay within your configured personality at all times.
`;

    fs.writeFileSync(path.join(agentDir, "SOUL.md"), soulContent);

    // Register in OpenClaw gateway config
    registerAgentInGateway(agent_id, client_id);

    return config;
  });

  // POST /agent/:client_id/chat - chat with the client's specific agent
  app.post("/agent/:client_id/chat", async (req, reply) => {
    const { client_id } = req.params;
    const { message } = req.body || {};
    if (!message) {
      return reply.code(400).send({ error: "message is required" });
    }

    // Get agent config
    const { rows } = await pool.query(
      "SELECT * FROM client_agent WHERE client_id = $1",
      [client_id]
    );

    let agentConfig;
    let isNew = false;
    if (!rows[0]) {
      // Auto-create default agent
      agentConfig = {
        client_id,
        agent_name: "Bot",
        agent_id: `client_${client_id.replace(/-/g, "_")}`,
        system_prompt: "You are a helpful assistant.",
        personality: "friendly",
      };
      isNew = true;
    } else {
      agentConfig = rows[0];
    }

    const agent_id = agentConfig.agent_id;

    // Ensure agent is registered in gateway
    if (isNew) {
      const agentDir = path.join(AGENTS_DIR, agent_id);
      fs.mkdirSync(agentDir, { recursive: true });
      const workspaceDir = `/var/www/clients/${client_id}/agent`;
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "SOUL.md"), `# SOUL: ${agentConfig.agent_name}\n\n${agentConfig.system_prompt}`);
      registerAgentInGateway(agent_id, client_id);
    }

    // Get or create conversation
    if (!conversations.has(agent_id)) {
      conversations.set(agent_id, [
        {
          role: "system",
          content: `You are ${agentConfig.agent_name}, an AI assistant for a Pembantu.Online client.

Personality: ${agentConfig.personality}
System Instructions: ${agentConfig.system_prompt}

You have access to all OpenClaw tools and skills. Use them when needed.`,
        },
      ]);
    }

    const history = conversations.get(agent_id);
    history.push({ role: "user", content: message });

    // Trim history to last 10 exchanges
    if (history.length > 12) {
      const system = history[0];
      const recent = history.slice(-10);
      conversations.set(agent_id, [system, ...recent]);
    }

    // Route through OpenClaw agent
    let aiReply, inputTokens, outputTokens;
    const session_id = `agent-${agent_id}-${Date.now()}`;

    try {
      inputTokens = history.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);

      const contextMessages = history.slice(-6);
      const contextStr = contextMessages
        .filter((m) => m.role !== "system")
        .map((m) => `${m.role === "user" ? "User" : "You"}: ${m.content}`)
        .join("\n\n");

      const agentPrompt = `[CONTEXT]\nYou are ${agentConfig.agent_name}.\nPersonality: ${agentConfig.personality}\n\n[CONVERSATION]\n${contextStr}\n\nYou:`;

      // Call OpenClaw agent CLI with the client's specific agent
      const result = execSync(
        `openclaw agent --agent ${agent_id} --message ${JSON.stringify(agentPrompt)} --json 2>/dev/null`,
        { timeout: 120000, cwd: "/root", maxBuffer: 1024 * 1024 }
      );

      const parsed = JSON.parse(result.toString());
      aiReply = parsed?.payloads?.[0]?.text || "I'm sorry, I couldn't process that.";
      const usage = parsed?.meta?.agentMeta?.usage || {};
      outputTokens = usage.output || estimateTokens(aiReply);
      inputTokens = usage.input || inputTokens;

      history.push({ role: "assistant", content: aiReply });

      // Record usage
      const totalTokens = inputTokens + outputTokens;
      const creditsConsumed = Math.max(0.001, parseFloat((totalTokens / TOKENS_PER_CREDIT).toFixed(4)));

      try {
        await pool.query(
          `INSERT INTO usage_log (client_id, model, session_id, input_tokens, output_tokens, total_tokens, credits_consumed, endpoint)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'agent-chat')`,
          [client_id, `agent-${agent_id}`, session_id, inputTokens, outputTokens, totalTokens, creditsConsumed]
        );
      } catch (logErr) {
        // Non-fatal: usage logging failure shouldn't break chat
        console.error("Usage log error:", logErr.message);
      }
    } catch (err) {
      return reply.code(500).send({ error: "AI service unavailable: " + err.message });
    }

    return {
      reply: aiReply,
      agent_name: agentConfig.agent_name,
      personality: agentConfig.personality,
      credits_consumed: Math.max(0.001, parseFloat(((inputTokens + outputTokens) / TOKENS_PER_CREDIT).toFixed(4))),
    };
  });

  // DELETE /agent/:client_id/history - clear conversation
  app.delete("/agent/:client_id/history", async (req, reply) => {
    const { client_id } = req.params;
    const agent_id = `client_${client_id.replace(/-/g, "_")}`;
    conversations.delete(agent_id);
    return { ok: true };
  });
}

function registerAgentInGateway(agentId, clientId) {
  try {
    const configPath = OPENCLAW_CONFIG;
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    // Ensure agents.list exists
    if (!config.agents) config.agents = { defaults: {}, list: [] };
    if (!config.agents.list) config.agents.list = [];
    if (!config.agents.defaults) config.agents.defaults = {};

    // Check if agent already registered
    const existingIdx = config.agents.list.findIndex((a) => a.id === agentId);
    const agentEntry = {
      id: agentId,
      name: agentId,
      model: { primary: MODEL_ID },
      workspace: `/var/www/clients/${clientId}/agent`,
    };

    if (existingIdx >= 0) {
      config.agents.list[existingIdx] = agentEntry;
    } else {
      config.agents.list.push(agentEntry);
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    // Reload gateway (SIGUSR1 or restart)
    try {
      execSync("openclaw gateway restart", { timeout: 10000, cwd: "/root" });
    } catch (restartErr) {
      console.error("Gateway restart note:", restartErr.message);
    }
  } catch (err) {
    console.error("Failed to register agent in gateway:", err.message);
  }
}
