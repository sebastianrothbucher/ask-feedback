import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { handler } from "../../lambda/get";

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeEvent(id: string | undefined): APIGatewayProxyEvent {
  return { pathParameters: id ? { id } : undefined } as unknown as APIGatewayProxyEvent;
}

function parsed(result: APIGatewayProxyResult) {
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

beforeEach(() => {
  ddbMock.reset();
});

describe("get handler", () => {
  it("returns 404 when no id is given", async () => {
    const { statusCode } = parsed(await handler(makeEvent(undefined)));
    expect(statusCode).toBe(404);
  });

  it("returns 404 when the id is unknown", async () => {
    ddbMock.on(GetCommand).resolves({});
    const { statusCode } = parsed(await handler(makeEvent("missing-id")));
    expect(statusCode).toBe(404);
  });

  it("returns the feedback request without leaking webhookUrl", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        id: "abc",
        briefing: "Review this",
        choiceQuestion: "Ok?",
        choiceOptions: ["Yes", "No"],
        textQuestion: "Comments?",
        finished: false,
        webhookUrl: "https://internal.example.com/secret-hook",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const { statusCode, body } = parsed(await handler(makeEvent("abc")));

    expect(statusCode).toBe(200);
    expect(body).toEqual({
      id: "abc",
      briefing: "Review this",
      choiceQuestion: "Ok?",
      choiceOptions: ["Yes", "No"],
      textQuestion: "Comments?",
      finished: false,
      choiceAnswer: undefined,
      textAnswer: undefined,
      decision: undefined,
    });
    expect(body.webhookUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("secret-hook");
  });
});
