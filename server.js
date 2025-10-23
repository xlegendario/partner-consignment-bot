import express from "express";
import morgan from "morgan";

const app = express();

// --- Middleware
app.use(morgan("combined"));
app.use(express.json({ limit: "1mb" }));          // JSON bodies
app.use(express.urlencoded({ extended: true }));  // form bodies

// In-memory ring buffer of last 25 payloads
const last = [];
const pushLast = (entry) => {
  last.push(entry);
  while (last.length > 25) last.shift();
};

// --- Routes

app.get("/", (req, res) => {
  res.type("text/plain").send("OK - webhook probe is running. POST to /webhook, view /inspect");
});

app.get("/inspect", (req, res) => {
  // Simple HTML viewer so you can check from a browser
  const items = last
    .slice()
    .reverse()
    .map((it, i) => {
      const h = Object.entries(it.headers)
        .map(([k, v]) => `<div><code>${k}</code>: <code>${String(v)}</code></div>`)
        .join("");
      return `
        <section style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0">
          <div style="font:14px/1.4 system-ui">
            <b>#${i + 1}</b> • <code>${it.method} ${it.path}</code> • ${it.receivedAt}
            <div style="margin-top:6px;color:#666">ip: ${it.ip}</div>
            <details style="margin-top:6px">
              <summary>Headers</summary>
              ${h}
            </details>
            <details style="margin-top:6px">
              <summary>Body (JSON)</summary>
              <pre>${it.prettyBody}</pre>
            </details>
          </div>
        </section>`;
    })
    .join("");

  res.type("html").send(`
    <!doctype html>
    <meta charset="utf-8">
    <title>Webhook Inspector</title>
    <div style="max-width:900px;margin:24px auto;padding:0 12px;font:14px/1.5 system-ui">
      <h1 style="margin:0 0 8px">Webhook Inspector</h1>
      <div>Showing last ${last.length} requests to <code>/webhook</code></div>
      ${items || "<p>No payloads received yet.</p>"}
    </div>
  `);
});

app.post("/webhook", (req, res) => {
  const entry = {
    method: req.method,
    path: req.path,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    headers: req.headers,
    body: req.body,
    prettyBody: JSON.stringify(req.body, null, 2),
    receivedAt: new Date().toISOString()
  };
  pushLast(entry);

  // Echo back what we got so Make/Airtable logs show it
  res.status(200).json({
    status: "ok",
    receivedAt: entry.receivedAt,
    youSent: entry.body,
    headers: entry.headers
  });
});

// Fallback
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook probe listening on :${PORT}`);
});
