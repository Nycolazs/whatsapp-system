const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const FRONTEND_DIR = __dirname;
const HOST = process.env.FRONTEND_HOST || '127.0.0.1';
const PORT = Number(process.env.FRONTEND_PORT || 8080);
const REQUIRE_ELECTRON = process.env.FRONTEND_REQUIRE_ELECTRON !== '0';
const RUNTIME_HEADER = 'x-whatsapp-system-runtime';

const PAGE_ROUTES = {
  '/': 'index.html',
  '/login': 'index.html',
  '/agent': 'agent.html',
  '/admin-sellers': 'admin-sellers.html',
  '/whatsapp-qr': 'whatsapp-qr.html',
  '/setup-admin': 'setup-admin.html',
};

const HTML_TO_CLEAN_ROUTE = {
  '/index.html': '/',
  '/agent.html': '/agent',
  '/admin-sellers.html': '/admin-sellers',
  '/whatsapp-qr.html': '/whatsapp-qr',
  '/setup-admin.html': '/setup-admin',
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

function getBackendBaseFromRequest(req) {
  const hostHeader = String((req && req.headers && req.headers.host) || '');
  const hostOnly = hostHeader ? hostHeader.split(':')[0] : 'localhost';
  const forced = String(process.env.API_PROXY_BASE || '').trim().replace(/\/+$/, '');
  if (forced) return forced;
  return `http://${hostOnly}:3001`;
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value || '');
}

function getProxyTargetBase(req) {
  const fromHeader = normalizeHeaderValue(req && req.headers ? req.headers['x-api-base'] : '').trim().replace(/\/+$/, '');
  const fallback = getBackendBaseFromRequest(req);
  const candidate = fromHeader || fallback;

  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Invalid protocol');
    return parsed;
  } catch (_) {
    return new URL(fallback);
  }
}

function proxyApiRequest(req, res, pathname) {
  const targetBase = getProxyTargetBase(req);
  const reqUrl = new URL(req.url, 'http://localhost');
  const upstreamPath = pathname.replace(/^\/__api/, '') || '/';
  const upstreamUrl = new URL(`${upstreamPath}${reqUrl.search || ''}`, targetBase);

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  delete headers['x-api-base'];
  headers.host = upstreamUrl.host;

  const transport = upstreamUrl.protocol === 'https:' ? https : http;
  const upstreamReq = transport.request(upstreamUrl, {
    method: req.method || 'GET',
    headers,
  }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    // CORS não é necessário no proxy same-origin e pode conflitar com o host local.
    delete responseHeaders['access-control-allow-origin'];
    delete responseHeaders['access-control-allow-credentials'];
    delete responseHeaders['access-control-allow-methods'];
    delete responseHeaders['access-control-allow-headers'];

    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Falha ao conectar no backend configurado' }));
      return;
    }
    try { res.end(); } catch (_) {}
  });

  req.pipe(upstreamReq);
}

function isElectronRequest(req) {
  try {
    const value = String(req.headers[RUNTIME_HEADER] || '').trim().toLowerCase();
    return value === 'electron';
  } catch (_) {
    return false;
  }
}

function sendElectronOnlyError(res) {
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    error: 'Frontend bloqueado para navegador. Use o aplicativo desktop (Electron).',
  }));
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      electronOnly: REQUIRE_ELECTRON,
      host: HOST,
      port: PORT,
    }));
    return;
  }

  if (REQUIRE_ELECTRON && !isElectronRequest(req)) {
    sendElectronOnlyError(res);
    return;
  }

  if (pathname === '/__api' || pathname.startsWith('/__api/')) {
    proxyApiRequest(req, res, pathname);
    return;
  }

  // Fallback de compatibilidade: quando a mídia vier como URL relativa (/media/*),
  // encaminha para o backend (porta 3001), onde os arquivos realmente são servidos.
  if (pathname.startsWith('/media/')) {
    const backendBase = getBackendBaseFromRequest(req);
    const target = `${backendBase}${req.url}`;
    res.writeHead(302, { Location: target });
    res.end();
    return;
  }

  if (HTML_TO_CLEAN_ROUTE[pathname]) {
    const urlObj = new URL(req.url, 'http://localhost');
    const cleanPath = HTML_TO_CLEAN_ROUTE[pathname];
    const redirectTo = `${cleanPath}${urlObj.search || ''}${urlObj.hash || ''}`;
    res.writeHead(301, { Location: redirectTo });
    res.end();
    return;
  }

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
