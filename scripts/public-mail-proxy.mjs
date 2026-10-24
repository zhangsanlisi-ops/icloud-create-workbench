import express from "express";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.PUBLIC_MAIL_PROXY_PORT || 4174);
const backendOrigin = String(process.env.BACKEND_ORIGIN || "http://127.0.0.1:4173").replace(/\/$/, "");
const frontendDir = join(process.cwd(), "frontend", "apps", "admin", "dist");

if (!existsSync(join(frontendDir, "index.html"))) {
  throw new Error(`Missing frontend build: ${frontendDir}`);
}

const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: { directives: {
  "connect-src": ["'self'"],
  "upgrade-insecure-requests": null
} } }));

for (const directory of ["assets", "css", "js"]) {
  app.use(`/${directory}`, express.static(join(frontendDir, directory), { maxAge: "1h" }));
}
app.get("/favicon.ico", (req, res) => res.sendFile(join(frontendDir, "favicon.ico")));
app.get("/favicon.svg", (req, res) => res.sendFile(join(frontendDir, "favicon.svg")));

app.get("/mail/:email/:token", (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.sendFile(join(frontendDir, "index.html"));
});

app.get("/openapi/mail/:email/:token/latest", async (req, res, next) => {
  try {
    const query = new URLSearchParams(req.query).toString();
    const url = `${backendOrigin}/openapi/mail/${encodeURIComponent(req.params.email)}/${encodeURIComponent(req.params.token)}/latest${query ? `?${query}` : ""}`;
    const response = await fetch(url);
    const body = await response.text();
    res.status(response.status);
    res.type(response.headers.get("content-type") || "application/json");
    res.send(body);
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(`${new Date().toISOString()} ${req.method} ${req.path}: ${error.message}`);
  res.status(502).json({ error: "Public mail proxy failed" });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`public mail proxy: http://127.0.0.1:${port} -> ${backendOrigin}`);
});
