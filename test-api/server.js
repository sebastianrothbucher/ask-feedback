// Local-only, in-memory stand-in for the deployed API. State resets on
// every restart - this is meant for developing/testing the client, not
// for persisting real feedback.
const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.TEST_API_KEY || "local-dev-key";
const CLIENT_BASE_URL = (process.env.CLIENT_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");

const app = express();
app.use(cors());
app.use(express.json());

const store = new Map();

app.post("/feedback-requests", (req, res) => {
  if (req.header("x-api-key") !== API_KEY) {
    return res.status(403).json({ message: "forbidden" });
  }

  const { briefing, choiceQuestion, choiceOptions, textQuestion, webhookUrl } = req.body || {};
  if (!briefing || typeof briefing !== "string") {
    return res.status(400).json({ message: "briefing is required" });
  }
  if (choiceQuestion !== undefined && (!Array.isArray(choiceOptions) || choiceOptions.length === 0)) {
    return res.status(400).json({ message: "choiceOptions is required when choiceQuestion is set" });
  }
  if (webhookUrl !== undefined && (typeof webhookUrl !== "string" || !/^https?:\/\//.test(webhookUrl))) {
    return res.status(400).json({ message: "webhookUrl must be an http(s) URL" });
  }

  const id = randomUUID();
  store.set(id, {
    id,
    briefing,
    choiceQuestion,
    choiceOptions,
    textQuestion,
    webhookUrl,
    finished: false,
    createdAt: new Date().toISOString(),
  });

  res.status(201).json({ id, answerUrl: `${CLIENT_BASE_URL}?id=${id}` });
});

app.get("/feedback-requests/:id", (req, res) => {
  const item = store.get(req.params.id);
  if (!item) {
    return res.status(404).json({ message: "not found" });
  }
  const { webhookUrl, ...rest } = item;
  res.json(rest);
});

app.post("/feedback-requests/:id/answer", async (req, res) => {
  const item = store.get(req.params.id);
  if (!item) {
    return res.status(404).json({ message: "not found" });
  }
  if (item.finished) {
    return res.status(409).json({ message: "already answered" });
  }

  const { choiceAnswer, textAnswer, decision } = req.body || {};
  if (decision !== "ok" && decision !== "reject") {
    return res.status(400).json({ message: "decision must be 'ok' or 'reject'" });
  }

  Object.assign(item, {
    finished: true,
    choiceAnswer: choiceAnswer ?? null,
    textAnswer: textAnswer ?? null,
    decision,
    answeredAt: new Date().toISOString(),
  });

  await postWebhook(item.webhookUrl, {
    id: item.id,
    choiceAnswer: item.choiceAnswer,
    textAnswer: item.textAnswer,
    decision: item.decision,
  });

  res.json({ ok: true });
});

// Best-effort delivery: a slow or failing webhook must never stop an answer
// from being recorded, so failures are swallowed (and logged) rather than
// thrown.
async function postWebhook(url, payload) {
  if (!url) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    console.error("webhook delivery failed", err);
  } finally {
    clearTimeout(timeout);
  }
}

app.listen(PORT, () => {
  console.log(`ask-feedback test API listening on http://localhost:${PORT}`);
  console.log(`Create endpoint requires header x-api-key: ${API_KEY}`);
});
