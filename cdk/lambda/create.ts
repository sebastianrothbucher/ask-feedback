import { randomUUID } from "crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { ddb, TABLE_NAME, jsonResponse } from "./common";

interface CreateBody {
  briefing?: string;
  choiceQuestion?: string;
  choiceOptions?: string[];
  textQuestion?: string;
  webhookUrl?: string;
}

// API Gateway's apiKeyRequired only checks that *some* key on a usage plan
// associated with this stage was used - the public key shipped in the
// client's config.js would otherwise also pass. CREATE_API_KEY_ID pins this
// endpoint to the specific create key regardless.
const CREATE_API_KEY_ID = process.env.CREATE_API_KEY_ID as string;
const ANSWER_BASE_URL = (process.env.ANSWER_BASE_URL as string).replace(/\/+$/, "");

export async function handler(event: APIGatewayProxyEvent) {
  if (event.requestContext.identity.apiKeyId !== CREATE_API_KEY_ID) {
    return jsonResponse(403, { message: "unauthorized" });
  }

  let body: CreateBody;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return jsonResponse(400, { message: "invalid JSON body" });
  }

  if (!body.briefing || typeof body.briefing !== "string") {
    return jsonResponse(400, { message: "briefing is required" });
  }
  if (
    body.choiceQuestion !== undefined &&
    (!Array.isArray(body.choiceOptions) || body.choiceOptions.length === 0)
  ) {
    return jsonResponse(400, {
      message: "choiceOptions is required when choiceQuestion is set",
    });
  }
  if (
    body.webhookUrl !== undefined &&
    (typeof body.webhookUrl !== "string" || !/^https?:\/\//.test(body.webhookUrl))
  ) {
    return jsonResponse(400, {
      message: "webhookUrl must be an http(s) URL",
    });
  }

  const id = randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        id,
        briefing: body.briefing,
        choiceQuestion: body.choiceQuestion,
        choiceOptions: body.choiceOptions,
        textQuestion: body.textQuestion,
        webhookUrl: body.webhookUrl,
        finished: false,
        createdAt: new Date().toISOString(),
      },
    })
  );

  return jsonResponse(201, { id, answerUrl: `${ANSWER_BASE_URL}?id=${id}` });
}
