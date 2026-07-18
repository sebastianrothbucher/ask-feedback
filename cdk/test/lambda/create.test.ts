import "aws-sdk-client-mock-jest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { handler } from "../../lambda/create";

const ddbMock = mockClient(DynamoDBDocumentClient);

const CREATE_KEY_ID = process.env.CREATE_API_KEY_ID as string;

function makeEvent(body: unknown, apiKeyId: string | null = CREATE_KEY_ID): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    requestContext: { identity: { apiKeyId } },
  } as unknown as APIGatewayProxyEvent;
}

function parsed(result: APIGatewayProxyResult) {
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
});

describe("create handler", () => {
  it("creates a feedback request and returns its id", async () => {
    const { statusCode, body } = parsed(
      await handler(
        makeEvent({
          briefing: "Please review the new pricing page",
          choiceQuestion: "Do you like it?",
          choiceOptions: ["Yes", "No"],
          textQuestion: "Any comments?",
          webhookUrl: "https://example.com/hook",
        })
      )
    );

    expect(statusCode).toBe(201);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.answerUrl).toBe(`${process.env.ANSWER_BASE_URL}?id=${body.id}`);

    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: "test-table",
      Item: expect.objectContaining({
        id: body.id,
        briefing: "Please review the new pricing page",
        choiceQuestion: "Do you like it?",
        choiceOptions: ["Yes", "No"],
        textQuestion: "Any comments?",
        webhookUrl: "https://example.com/hook",
        finished: false,
      }),
    });
  });

  it("rejects a request authenticated with a different API key (e.g. the public one)", async () => {
    const { statusCode, body } = parsed(
      await handler(makeEvent({ briefing: "x" }, "some-other-key-id"))
    );
    expect(statusCode).toBe(403);
    expect(body.message).toBe("unauthorized");
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });

  it("rejects a request with no API key id at all", async () => {
    const { statusCode } = parsed(await handler(makeEvent({ briefing: "x" }, null)));
    expect(statusCode).toBe(403);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });

  it("rejects a missing briefing", async () => {
    const { statusCode } = parsed(await handler(makeEvent({})));
    expect(statusCode).toBe(400);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });

  it("rejects a choiceQuestion without choiceOptions", async () => {
    const { statusCode } = parsed(
      await handler(makeEvent({ briefing: "x", choiceQuestion: "y?" }))
    );
    expect(statusCode).toBe(400);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });

  it("rejects a non-http(s) webhookUrl", async () => {
    const { statusCode } = parsed(
      await handler(makeEvent({ briefing: "x", webhookUrl: "javascript:alert(1)" }))
    );
    expect(statusCode).toBe(400);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });

  it("rejects invalid JSON", async () => {
    const { statusCode } = parsed(
      await handler({
        body: "{not json",
        requestContext: { identity: { apiKeyId: CREATE_KEY_ID } },
      } as unknown as APIGatewayProxyEvent)
    );
    expect(statusCode).toBe(400);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });
});
