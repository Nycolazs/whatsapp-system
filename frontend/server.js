const http = require('http');
const fs = require('fs');
const path = require('path');

const FRONTEND_DIR = __dirname;
const HOST = process.env.FRONTEND_HOST || '0.0.0.0';
const PORT = Number(process.env.FRONTEND_PORT || 8080);

const PAGE_ROUTES = {
  '/': 'index.html',
  '/login': 'index.html',
  '/agent': 'agent.html',
  '/admin-sellers': 'admin-sellers.html',
  '/whatsapp-qr': 'whatsapp-qr.html',
  '/setup-admin': 'setup-admin.html',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function sendFile(res, filePath, noCache = false) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };
    if (noCache) {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
      headers.Pragma = 'no-cache';
      headers.Expires = '0';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function isInsideFrontendDir(targetPath) {
  const normalized = path.normalize(targetPath);
  return normalized.startsWith(path.normalize(FRONTEND_DIR + path.sep));
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (PAGE_ROUTES[pathname]) {
    const filePath = path.join(FRONTEND_DIR, PAGE_ROUTES[pathname]);
    sendFile(res, filePath, true);
    return;
  }

  const decodedPath = decodeURIComponent(pathname);
  const relativePath = decodedPath.startsWith('/') ? decodedPath.slice(1) : decodedPath;
  const filePath = path.join(FRONTEND_DIR, relativePath);

  if (!isInsideFrontendDir(filePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const noCache = path.extname(filePath).toLowerCase() === '.html';
    sendFile(res, filePath, noCache);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Frontend server running at http://${HOST}:${PORT}`);
});

