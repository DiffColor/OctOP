import { createServer } from "node:http";
import dns from "node:dns";
import { connect, StringCodec } from "nats";
import { bridgeSubjects, sanitizeUserId } from "../../../packages/domain/src/index.js";

const HOST = process.env.OCTOP_GATEWAY_HOST ?? "0.0.0.0";
const PORT = Number(process.env.OCTOP_GATEWAY_PORT ?? 4000);
const NATS_URL = process.env.OCTOP_NATS_URL ?? "nats://nats.ilycode.app:4222";
const CORS_ORIGIN = process.env.OCTOP_DASHBOARD_ORIGIN ?? "https://licensehub.ilycode.app";
const LICENSEHUB_API_BASE_URL =
  process.env.OCTOP_LICENSEHUB_API_BASE_URL ?? "https://licensehub.ilycode.app";

dns.setDefaultResultOrder("ipv4first");

const sc = StringCodec();
const nc = await connect({ servers: NATS_URL });

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendSseHeaders(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": CORS_ORIGIN
  });
}

function sendOptions(response) {
  response.writeHead(204, {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end();
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function requestBridge(subject, payload = {}) {
  const message = await nc.request(subject, sc.encode(JSON.stringify(payload)), {
    timeout: 10000
  });

  return JSON.parse(sc.decode(message.data));
}

async function readJsonResponse(upstream) {
  const text = await upstream.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function proxyLicenseHubJson(response, path, options = {}) {
  const upstream = await fetch(`${LICENSEHUB_API_BASE_URL}${path}`, options);
  const payload = await readJsonResponse(upstream);
  return sendJson(response, upstream.status, payload);
}

async function handleEventStream(userId, response) {
  sendSseHeaders(response);
  const subjects = bridgeSubjects(userId);
  const subscription = nc.subscribe(subjects.events);

  response.write(`event: ready\ndata: ${JSON.stringify({ user_id: userId })}\n\n`);

  const heartbeat = setInterval(() => {
    response.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 15000);

  requestBridge(subjects.statusGet, { user_id: userId })
    .then((status) => {
      response.write(`event: snapshot\ndata: ${JSON.stringify(status)}\n\n`);
    })
    .catch((error) => {
      response.write(
        `event: error\ndata: ${JSON.stringify({ message: error.message, user_id: userId })}\n\n`
      );
    });

  (async () => {
    try {
      for await (const message of subscription) {
        response.write(`event: message\ndata: ${sc.decode(message.data)}\n\n`);
      }
    } catch (error) {
      response.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
    }
  })();

  response.on("close", () => {
    clearInterval(heartbeat);
    subscription.unsubscribe();
    response.end();
  });
}

createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      return sendOptions(response);
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const userId = sanitizeUserId(url.searchParams.get("user_id") ?? "local-user");
    const subjects = bridgeSubjects(userId);

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        ok: true,
        service: "octop-gateway"
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJsonBody(request);
      return proxyLicenseHubJson(response, "/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          loginId: body.loginId,
          password: body.password
        })
      });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/bootstrap") {
      const authorization = request.headers.authorization;

      if (!authorization) {
        return sendJson(response, 401, { error: "Authorization header is required." });
      }

      return proxyLicenseHubJson(response, "/api/admin/bootstrap", {
        method: "GET",
        headers: {
          Authorization: authorization
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/api/bridge/status") {
      const payload = await requestBridge(subjects.statusGet, { user_id: userId });
      return sendJson(response, 200, payload);
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      const payload = await requestBridge(subjects.projectsGet, { user_id: userId });
      return sendJson(response, 200, payload);
    }

    if (request.method === "GET" && url.pathname === "/api/threads") {
      const payload = await requestBridge(subjects.threadsGet, { user_id: userId });
      return sendJson(response, 200, payload);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/api/commands/ping" || url.pathname === "/api/demo/start")
    ) {
      const body = await readJsonBody(request);
      const payload = await requestBridge(subjects.pingStart, {
        user_id: userId,
        prompt: body.prompt,
        project_id: body.project_id
      });
      return sendJson(response, payload.accepted === false ? 502 : 202, payload);
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      return handleEventStream(userId, response);
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(response, 502, {
      error: error.message,
      service: "octop-gateway"
    });
  }
}).listen(PORT, HOST, () => {
  console.log(`OctOP gateway listening on http://${HOST}:${PORT}`);
});
