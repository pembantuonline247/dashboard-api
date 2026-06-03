// WhatsApp configuration routes for Pembantu.Online
// Handles saving WhatsApp numbers and triggering QR/reconnect
// Note: /whatsapp/config/:client_id endpoints are in catalog-routes.js
import { execSync } from "child_process";

export default async function whatsappRoutes(app, pool) {
  // POST /whatsapp/save - save WhatsApp number for a client
  app.post("/whatsapp/save", async (req, reply) => {
    const { client_id, whatsapp } = req.body || {};
    if (!client_id || !whatsapp) {
      return reply.code(400).send({ error: "client_id and whatsapp number required" });
    }

    // Validate E.164 format roughly
    const cleaned = whatsapp.replace(/[^0-9+]/g, "");
    if (!cleaned.startsWith("+") || cleaned.length < 10) {
      return reply.code(400).send({ error: "WhatsApp number must be in E.164 format (e.g., +60123456789)" });
    }

    try {
      await pool.query(
        "UPDATE clients SET whatsapp = $1, whatsapp_connected = false WHERE id = $2",
        [cleaned, client_id]
      );
      return { ok: true, whatsapp: cleaned, message: "WhatsApp number saved. Use 'Connect WhatsApp' to link the device." };
    } catch (err) {
      return reply.code(500).send({ error: "Failed to save WhatsApp number: " + err.message });
    }
  });

  // POST /whatsapp/connect - trigger QR code / reconnect WhatsApp
  app.post("/whatsapp/connect", async (req, reply) => {
    const { client_id } = req.body || {};
    if (!client_id) {
      return reply.code(400).send({ error: "client_id required" });
    }

    try {
      // Get client info
      const { rows } = await pool.query(
        "SELECT id, name, whatsapp, whatsapp_connected FROM clients WHERE id = $1",
        [client_id]
      );
      if (!rows[0]) {
        return reply.code(404).send({ error: "Client not found" });
      }

      const client = rows[0];
      if (!client.whatsapp) {
        return reply.code(400).send({ error: "No WhatsApp number saved. Please save a number first." });
      }

      // Trigger OpenClaw WhatsApp QR through agent
      let qrData = "";
      try {
        const result = execSync(
          `openclaw agent --agent main --message "I need to connect WhatsApp for client ${client.name} (${client.whatsapp}). Please generate a WhatsApp QR code for connection. Return ONLY the QR code data URL if available." --json 2>/dev/null`,
          { timeout: 120000, cwd: "/root", maxBuffer: 1024 * 1024 }
        );
        const parsed = JSON.parse(result.toString());
        qrData = parsed?.payloads?.[0]?.text || "";
      } catch (agentErr) {
        console.error("Agent QR generation error:", agentErr.message);
      }

      return {
        ok: true,
        client: {
          id: client.id,
          name: client.name,
          whatsapp: client.whatsapp,
          connected: client.whatsapp_connected
        },
        qr: qrData,
        message: "WhatsApp connection initiated. Check the QR code above to link your device."
      };
    } catch (err) {
      return reply.code(500).send({ error: "Failed to connect WhatsApp: " + err.message });
    }
  });

  // GET /whatsapp/status/:client_id - check WhatsApp connection status
  app.get("/whatsapp/status/:client_id", async (req, reply) => {
    const { client_id } = req.params;
    try {
      const { rows } = await pool.query(
        "SELECT whatsapp, whatsapp_connected, name FROM clients WHERE id = $1",
        [client_id]
      );
      if (!rows[0]) {
        return reply.code(404).send({ error: "Client not found" });
      }
      return {
        whatsapp: rows[0].whatsapp,
        connected: rows[0].whatsapp_connected,
        name: rows[0].name
      };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
