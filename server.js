const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) continue;

    const key = trimmed.slice(0, equalsAt).trim();
    const value = trimmed.slice(equalsAt + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

loadEnvFile();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && require("node:crypto").timingSafeEqual(left, right);
}

function isAuthorized(req) {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;
  if (!username || !password) return true;

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const splitAt = decoded.indexOf(":");
  if (splitAt === -1) return false;

  const givenUser = decoded.slice(0, splitAt);
  const givenPass = decoded.slice(splitAt + 1);
  return timingSafeEqual(givenUser, username) && timingSafeEqual(givenPass, password);
}

function requireAuth(res) {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="Merch X", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8"
  });
  res.end("Authentication required");
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const requestedPath = safePath === path.sep ? "index.html" : safePath.slice(1);
  const filePath = path.join(publicDir, requestedPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(publicDir, "index.html"), (indexError, indexData) => {
        if (indexError) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "content-type": mimeTypes[".html"] });
        res.end(indexData);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) {
    requireAuth(res);
    return;
  }

  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`Merch X running at http://localhost:${port}`);
});
