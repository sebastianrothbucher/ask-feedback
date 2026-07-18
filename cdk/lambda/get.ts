import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { ddb, TABLE_NAME, jsonResponse } from "./common";

export async function handler(event: APIGatewayProxyEvent) {
  const id = event.pathParameters?.id;
  if (!id) {
    return jsonResponse(404, { message: "not found" });
  }

  const result = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { id } })
  );

  if (!result.Item) {
    return jsonResponse(404, { message: "not found" });
  }

  const item = result.Item;
  return jsonResponse(200, {
    id: item.id,
    briefing: item.briefing,
    choiceQuestion: item.choiceQuestion,
    choiceOptions: item.choiceOptions,
    textQuestion: item.textQuestion,
    finished: item.finished,
    choiceAnswer: item.choiceAnswer,
    textAnswer: item.textAnswer,
    decision: item.decision,
  });
}
