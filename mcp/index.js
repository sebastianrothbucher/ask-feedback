#!/usr/bin/env node
// Local MCP server exposing the ask-feedback API as tools, so an agent can
// create feedback requests and check on/relay answers without the client UI.
// Talks to either the deployed API Gateway or the local test-api - just
// point ASK_FEEDBACK_API_URL at whichever one you're running.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.ASK_FEEDBACK_API_URL;
if (!API_URL) {
  console.error("ASK_FEEDBACK_API_URL is required (e.g. the deployed ApiUrl output, or http://localhost:3001)");
  process.exit(1);
}
const BASE_URL = API_URL.replace(/\/+$/, "");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set - configure it in the MCP server's environment to use this tool`);
  }
  return value;
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function callApi(method, path, { apiKey, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-Api-Key": apiKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = responseBody?.message || `request failed with status ${res.status}`;
    throw new Error(`${message} (HTTP ${res.status})`);
  }
  return responseBody;
}

const server = new McpServer({ name: "ask-feedback", version: "1.0.0" });

server.registerTool(
  "create_feedback_request",
  {
    title: "Create feedback request",
    description:
      "Create a new ask-feedback request (a briefing plus an optional single-choice question and an optional free-text question). Returns { id, answerUrl } - share answerUrl with whoever should answer it.",
    inputSchema: {
      briefing: z.string().describe("The context/instructions shown to the person answering"),
      choiceQuestion: z.string().optional().describe("Optional single-choice question"),
      choiceOptions: z
        .array(z.string())
        .optional()
        .describe("Choices for choiceQuestion; required if choiceQuestion is set"),
      textQuestion: z.string().optional().describe("Optional free-text question"),
      webhookUrl: z
        .string()
        .url()
        .optional()
        .describe("Optional http(s) URL called once, with the answer, when this request is answered"),
    },
  },
  async (args) => {
    try {
      const apiKey = requireEnv("ASK_FEEDBACK_CREATE_API_KEY");
      const result = await callApi("POST", "/feedback-requests", { apiKey, body: args });
      return textResult(result);
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

server.registerTool(
  "get_feedback_request",
  {
    title: "Get feedback request",
    description: "Fetch a feedback request by id: its briefing/questions, and its answer if it has been answered.",
    inputSchema: {
      id: z.string().describe("The feedback request id"),
    },
  },
  async ({ id }) => {
    try {
      const apiKey = requireEnv("ASK_FEEDBACK_PUBLIC_API_KEY");
      const result = await callApi("GET", `/feedback-requests/${encodeURIComponent(id)}`, { apiKey });
      return textResult(result);
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

server.registerTool(
  "answer_feedback_request",
  {
    title: "Answer feedback request",
    description:
      "Answer a feedback request by id. Can only succeed once per request - it fails if this id has already been answered.",
    inputSchema: {
      id: z.string().describe("The feedback request id"),
      choiceAnswer: z.string().optional().describe("Answer to the choiceQuestion, if any"),
      textAnswer: z.string().optional().describe("Answer to the textQuestion, if any"),
      decision: z.enum(["ok", "reject"]).describe("The required OK/Reject decision"),
    },
  },
  async ({ id, ...body }) => {
    try {
      const apiKey = requireEnv("ASK_FEEDBACK_PUBLIC_API_KEY");
      const result = await callApi("POST", `/feedback-requests/${encodeURIComponent(id)}/answer`, {
        apiKey,
        body,
      });
      return textResult(result);
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
