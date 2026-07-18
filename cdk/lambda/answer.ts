import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { ddb, TABLE_NAME, jsonResponse, postWebhook, resumeStepFunction } from "./common";

interface AnswerBody {
  choiceAnswer?: string;
  textAnswer?: string;
  decision?: "ok" | "reject";
}

export async function handler(event: APIGatewayProxyEvent) {
  const id = event.pathParameters?.id;
  if (!id) {
    return jsonResponse(404, { message: "not found" });
  }

  let body: AnswerBody;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return jsonResponse(400, { message: "invalid JSON body" });
  }

  if (body.decision !== "ok" && body.decision !== "reject") {
    return jsonResponse(400, { message: "decision must be 'ok' or 'reject'" });
  }

  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { id } })
  );
  if (!existing.Item) {
    return jsonResponse(404, { message: "not found" });
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { id },
        ConditionExpression:
          "attribute_exists(id) AND (attribute_not_exists(finished) OR finished = :false)",
        UpdateExpression:
          "SET finished = :true, choiceAnswer = :choiceAnswer, textAnswer = :textAnswer, decision = :decision, answeredAt = :answeredAt",
        ExpressionAttributeValues: {
          ":true": true,
          ":false": false,
          ":choiceAnswer": body.choiceAnswer ?? null,
          ":textAnswer": body.textAnswer ?? null,
          ":decision": body.decision,
          ":answeredAt": new Date().toISOString(),
        },
      })
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return jsonResponse(409, { message: "already answered" });
    }
    throw err;
  }

  if (existing.Item.webhookUrl) {
    await postWebhook(existing.Item.webhookUrl, {
      id,
      choiceAnswer: body.choiceAnswer ?? null,
      textAnswer: body.textAnswer ?? null,
      decision: body.decision,
    });
  } else if (existing.Item.taskToken) {
    await resumeStepFunction(existing.Item.taskToken, {
      id,
      choiceAnswer: body.choiceAnswer ?? null,
      textAnswer: body.textAnswer ?? null,
      decision: body.decision,
    });
  }

  return jsonResponse(200, { ok: true });
}
