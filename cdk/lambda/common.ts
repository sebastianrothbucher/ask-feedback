import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult } from "aws-lambda";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfnClient = new SFNClient();
export const TABLE_NAME = process.env.TABLE_NAME as string;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,X-Api-Key",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export function jsonResponse(
  statusCode: number,
  body: unknown
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

// Best-effort delivery: a slow or failing webhook must never stop an answer
// from being recorded, so failures are swallowed (and logged) rather than
// thrown.
export async function postWebhook(
  url: string | undefined,
  payload: unknown
): Promise<void> {
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

// Best-effort delivery: just try to invoke the step function
export async function resumeStepFunction(
  taskToken: string | undefined, 
  payload: unknown
) {
  if (!taskToken) return;
  console.log('Resuming step function with task token/result: ', taskToken);
  try {
    await sfnClient.send(new SendTaskSuccessCommand({
      taskToken: taskToken,
      output: JSON.stringify(payload),
    })); 
  } catch (err) {
    console.error("step function resume failed", err);
  }
}
