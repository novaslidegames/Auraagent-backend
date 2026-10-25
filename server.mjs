
import http from "node:http";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";

const PORT = Number(process.env.PORT) || 3000;
const ACCESS_TOKEN = process.env.AGENT_ACCESS_TOKEN;
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY || !ACCESS_TOKEN) {
  throw new Error("Missing server environment variables");
}

const client = new OpenAI({
  apiKey: API_KEY
});

const tasks = [];

const tools = [
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a task for the user",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List saved tasks",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "Complete a task by ID",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" }
        },
        required: ["id"]
      }
    }
  }
];

function runTool(name, args) {
  if (name === "create_task") {
    const title = String(args.title || "").trim();

    if (!title || title.length > 200) {
      return { error: "Invalid task title" };
    }

    const task = {
      id: randomUUID(),
      title,
      completed: false
    };

    tasks.push(task);
    return task;
  }

  if (name === "list_tasks") {
    return tasks;
  }

  if (name === "complete_task") {
    const task = tasks.find(
      t => t.id === args.id
    );

    if (!task) {
      return { error: "Task not found" };
    }

    task.completed = true;
    return task;
  }

  return { error: "Unknown tool" };
}

async function askAI(messages) {
  const history = messages.map(m => ({
    role: m.role,
    content: m.content
  }));

  const systemMessage = {
    role: "system",
    content:
      "You are AuraAgent, a helpful AI assistant. " +
      "Use tools to manage tasks when requested. " +
      "Never claim an action succeeded unless confirmed."
  };

  for (let i = 0; i < 5; i++) {
    const response =
      await client.chat.completions.create({
        model:
          process.env.OPENAI_MODEL ||
          "gpt-4.1-mini",
        messages: [
          systemMessage,
          ...history
        ],
        tools
      });

    const message =
      response.choices[0]?.message;

    if (!message) {
      throw new Error("No AI response");
    }

    if (!message.tool_calls?.length) {
      return message.content || "No response";
    }

    history.push(message);

    for (const call of message.tool_calls) {
      let result;

      try {
        result = runTool(
          call.function.name,
          JSON.parse(
            call.function.arguments || "{}"
          )
        );
      } catch {
        result = {
          error: "Invalid tool arguments"
        };
      }

      history.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result)
      });
    }
  }

  return "Unable to complete this request.";
}

function sendJSON(res, status, body) {
  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(body));
}

const server = http.createServer(
  async (req, res) => {
    const pathname = new URL(
      req.url || "/",
      "http://localhost"
    ).pathname;

    console.log(
      "Incoming request:",
      req.method,
      pathname
    );

    // Main page
    if (
      pathname === "/" &&
      req.method === "GET"
    ) {
      return sendJSON(res, 200, {
        app: "AuraAgent",
        status: "online",
        message: "Backend is running"
      });
    }

    // Health check
    if (
      (pathname === "/health" ||
        pathname === "/health/") &&
      req.method === "GET"
    ) {
      return sendJSON(res, 200, {
        status: "ok",
        service: "AuraAgent Backend"
      });
    }

    // Chat endpoint
    if (
      pathname === "/chat" &&
      req.method === "POST"
    ) {
      if (
        req.headers.authorization !==
        `Bearer ${ACCESS_TOKEN}`
      ) {
        return sendJSON(res, 401, {
          error: "Unauthorized"
        });
      }

      try {
        let raw = "";

        for await (const chunk of req) {
          raw += chunk.toString();

          if (raw.length > 100000) {
            return sendJSON(res, 413, {
              error: "Request too large"
            });
          }
        }

        let body;

        try {
          body = JSON.parse(raw);
        } catch {
          return sendJSON(res, 400, {
            error: "Invalid JSON"
          });
        }

        if (
          !Array.isArray(body.messages) ||
          body.messages.length < 1 ||
          body.messages.length > 40 ||
          body.messages.some(m =>
            !m ||
            !["user", "assistant"].includes(
              m.role
            ) ||
            typeof m.content !== "string" ||
            m.content.length > 10000
          )
        ) {
          return sendJSON(res, 400, {
            error: "Invalid messages"
          });
        }

        const reply = await askAI(
          body.messages
        );

        return sendJSON(res, 200, {
          reply
        });

      } catch (error) {
        console.error(
          "AI request error:",
          error
        );

        return sendJSON(res, 500, {
          error: "AI request failed"
        });
      }
    }

    return sendJSON(res, 404, {
      error: "Not found",
      path: pathname
    });
  }
);

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `AuraAgent running on port ${PORT}`
    );
  }
);

