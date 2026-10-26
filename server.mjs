import http from "node:http";

const PORT = Number(process.env.PORT || 10000);
const ACCESS_TOKEN = process.env.AGENT_ACCESS_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Agent-Token"
  });
  res.end(JSON.stringify(data));
}

async function readJSON(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk.toString();

    if (body.length > 1024 * 1024) {
      throw new Error("Request too large");
    }
  }

  return body ? JSON.parse(body) : {};
}

function getToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }

  return String(req.headers["x-agent-token"] || "").trim();
}

function makeContents(data) {
  const messages = Array.isArray(data.messages)
    ? data.messages
    : [];

  const contents = messages
    .filter(m => typeof m.content === "string" && m.content.trim())
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));

  const prompt = data.message || data.prompt || data.text;

  if (contents.length === 0 && typeof prompt === "string" && prompt.trim()) {
    contents.push({
      role: "user",
      parts: [{ text: prompt }]
    });
  }

  return contents;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJSON(res, 200, { ok: true });
  }

  const path = new URL(req.url, "http://localhost").pathname;

  if (req.method === "GET" &&
      (path === "/" || path === "/health" || path === "/api/health")) {
    return sendJSON(res, 200, {
      status: "ok",
      service: "Nova AI Backend",
      provider: "gemini"
    });
  }

  if (req.method !== "POST" ||
      !["/chat", "/api/chat", "/ask", "/api/ask"].includes(path)) {
    return sendJSON(res, 404, {
      error: "Route not found"
    });
  }

  if (!ACCESS_TOKEN) {
    return sendJSON(res, 500, {
      error: "AGENT_ACCESS_TOKEN is not configured"
    });
  }

  if (getToken(req) !== ACCESS_TOKEN) {
    return sendJSON(res, 401, {
      error: "Unauthorized"
    });
  }

  if (!GEMINI_API_KEY) {
    return sendJSON(res, 500, {
      error: "GEMINI_API_KEY is not configured"
    });
  }

  let data;

  try {
    data = await readJSON(req);
  } catch {
    return sendJSON(res, 400, {
      error: "Invalid JSON request"
    });
  }

  const contents = makeContents(data);

  if (!contents.length) {
    return sendJSON(res, 400, {
      error: "Message is required"
    });
  }

  try {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(GEMINI_MODEL) +
      ":generateContent";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: 1024
        }
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", {
        status: response.status,
        message: result.error?.message
      });

      return sendJSON(res, 502, {
        error: "AI request failed",
        providerStatus: response.status,
        detail: result.error?.message || "Unknown provider error"
      });
    }

    const reply = (result.candidates || [])
      .flatMap(candidate => candidate.content?.parts || [])
      .map(part => part.text || "")
      .join("")
      .trim();

    if (!reply) {
      return sendJSON(res, 502, {
        error: "Gemini returned an empty response"
      });
    }

    return sendJSON(res, 200, {
      reply,
      response: reply,
      message: reply
    });

  } catch (error) {
    console.error("Backend error:", error.message);

    return sendJSON(res, 500, {
      error: "Internal server error"
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Nova AI Gemini backend running on port ${PORT}`);
});

