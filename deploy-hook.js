// Auto-deploy webhook receiver
// Hook this into the API server or run standalone
import { createServer } from "http";
import { execSync } from "child_process";

const SECRET = "p3mb4ntu_d3pl0y_2026";

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/deploy") {
    res.writeHead(404); res.end("Not found");
    return;
  }

  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    try {
      const event = JSON.parse(body);
      console.log("Deploy triggered by:", event.ref);
      
      // Run deploy
      const out = execSync("/root/deploy-dashboard.sh 2>&1", {
        cwd: "/root",
        timeout: 60000
      });
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, output: out.toString().slice(-500) }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}).listen(3002, "127.0.0.1", () => {
  console.log("Deploy hook listening on :3002");
});
