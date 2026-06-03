import Stripe from "stripe";

export default async function stripeRoutes(app, pool) {
  // Stripe instance initialized lazily
  let stripe = null;
  
  function getStripe() {
    if (!stripe) {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) throw new Error("STRIPE_SECRET_KEY not set");
      stripe = new Stripe(key);
    }
    return stripe;
  }

  // GET /api/stripe/config — return publishable key for frontend
  app.get("/stripe/config", async (req, reply) => {
    return {
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
      currency: "myr",
      paymentMethods: ["fpx"],
    };
  });

  // POST /api/stripe/create-checkout — create FPX checkout session
  app.post("/stripe/create-checkout", async (req, reply) => {
    try {
      const { client_id, amount, description } = req.body;
      if (!client_id || !amount) {
        return reply.code(400).send({ error: "client_id and amount required" });
      }

      const s = getStripe();
      
      // Get client info
      const { rows } = await pool.query(
        "SELECT name FROM clients WHERE id = $1", [client_id]
      );
      if (!rows[0]) return reply.code(404).send({ error: "Client not found" });

      const session = await s.checkout.sessions.create({
        payment_method_types: ["fpx"],
        line_items: [{
          price_data: {
            currency: "myr",
            product_data: {
              name: `Pembantu.Online - ${rows[0].name}`,
              description: description || "AI Bot Subscription",
            },
            unit_amount: Math.round(amount * 100), // cents
          },
          quantity: 1,
        }],
        mode: "payment",
        success_url: `https://dashboard.pembantu.online/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: "https://dashboard.pembantu.online/billing?canceled=true",
        metadata: {
          client_id,
        },
      });

      // Create invoice record
      await pool.query(
        `INSERT INTO invoices (client_id, amount, currency, status, due_date)
         VALUES ($1, $2, 'MYR', 'pending', $3)`,
        [client_id, amount, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]]
      );

      return { url: session.url, sessionId: session.id };
    } catch (err) {
      console.error("Stripe checkout error:", err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /api/stripe/webhook — Stripe webhook for payment events
  app.post("/stripe/webhook", async (req, reply) => {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      const s = getStripe();
      if (endpointSecret) {
        event = s.webhooks.constructEvent(req.body, sig, endpointSecret);
      } else {
        event = JSON.parse(req.body);
      }
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return reply.code(400).send({ error: err.message });
    }

    // Handle the event
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const clientId = session.metadata?.client_id;
        if (clientId) {
          await pool.query(
            `UPDATE invoices SET status = paid
             WHERE client_id = $1 AND status = pending
             RETURNING id`,
            [clientId]
          );
          console.log(`Payment completed for client ${clientId}`);
        }
        break;
      }
      case "checkout.session.expired": {
        const session = event.data.object;
        const clientId = session.metadata?.client_id;
        if (clientId) {
          await pool.query(
            `UPDATE invoices SET status = overdue
             WHERE client_id = $1 AND status = pending`,
            [clientId]
          );
        }
        break;
      }
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return { received: true };
  });
}
