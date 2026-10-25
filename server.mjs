
import http from "node:http";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.AGENT_ACCESS_TOKEN;
const tasks = [];

if (!process.env.OPENAI_API_KEY || !ACCESS_TOKEN) {
  throw new Error("Missing server environment variables");
}

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
    const task = tasks.find(t => t.id === args.id);
    if (!task) return { error: "Task not found" };
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

  for (let i = 0; i < 5; i++) {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are AuraAgent, a helpful AI assistant. " +
            "Use tools when managing tasks. " +
            "Never claim an action succeeded unless confirmed."
        },
        ...history
      ],
      tools
    });

    const message = response.choices[0]?.message;
    if (!message) throw new Error("No AI response");

    if (!message.tool_calls?.length) {
      return message.content || "No response";
    }

    history.push(message);

    for (const call of message.tool_calls) {
      let result;
      try {
        result = runTool(
          call.function.name,
          JSON.parse(call.function.arguments || "{}")
        );
      } catch {
        result = { error: "Invalid arguments" };
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

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    return json(res, 200, { status: "ok" });
  }

  if (req.url !== "/chat" || req.method !== "POST") {
    return json(res, 404, { error: "Not found" });
  }

  if (
    req.headers.authorization !==
    `Bearer ${ACCESS_TOKEN}`
  ) {
    return json(res, 401, { error: "Unauthorized" });
  }

  try {
    let raw = "";

    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > 100000) {
        return json(res, 413, { error: "Too large" });
      }
    }

    const body = JSON.parse(raw);

    if (
      !Array.isArray(body.messages) ||
      body.messages.length > 40 ||
      body.messages.some(m =>
        !["user", "assistant"].includes(m.role) ||
        typeof m.content !== "string" ||
        m.content.length > 10000
      )
    ) {
      return json(res, 400, {
        error: "Invalid messages"
      });
    }

    const reply = await askAI(body.messages);
    return json(res, 200, { reply });

  } catch (error) {
    console.error(error);
    return json(res, 500, {
      error: "AI request failed"
    });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`AuraAgent running on port ${PORT}`);
});
