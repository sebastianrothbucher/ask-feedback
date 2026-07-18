import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { handler } from "../../lambda/answer";

const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

function makeEvent(id: string | undefined, body: unknown): APIGatewayProxyEvent {
  return {
    pathParameters: id ? { id } : undefined,
    body: JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent;
}

function parsed(result: APIGatewayProxyResult) {
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

let fetchMock: jest.Mock;

beforeEach(() => {
  ddbMock.reset();
  sfnMock.reset();
  fetchMock = jest.fn().mockResolvedValue({ ok: true });
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("answer handler", () => {
  it("returns 404 when no id is given", async () => {
    const { statusCode } = parsed(await handler(makeEvent(undefined, { decision: "ok" })));
    expect(statusCode).toBe(404);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it("rejects a missing/invalid decision without touching dynamo", async () => {
    const { statusCode, body } = parsed(await handler(makeEvent("abc", {})));
    expect(statusCode).toBe(400);
    expect(body.message).toMatch(/decision/);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it("returns 404 when the feedback request does not exist", async () => {
    ddbMock.on(GetCommand).resolves({});
    const { statusCode } = parsed(await handler(makeEvent("missing", { decision: "ok" })));
    expect(statusCode).toBe(404);
  });

  it("records the answer and fires the webhook", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "abc", finished: false, webhookUrl: "https://example.com/hook" },
    });
    ddbMock.on(UpdateCommand).resolves({});

    const { statusCode, body } = parsed(
      await handler(
        makeEvent("abc", { choiceAnswer: "Yes", textAnswer: "Great", decision: "ok" })
      )
    );

    expect(statusCode).toBe(200);
    expect(body).toEqual({ ok: true });

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall.args[0].input).toMatchObject({
      TableName: "test-table",
      Key: { id: "abc" },
      ConditionExpression: expect.stringContaining("attribute_exists(id)"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(JSON.parse(init.body)).toEqual({
      id: "abc",
      choiceAnswer: "Yes",
      textAnswer: "Great",
      decision: "ok",
    });
  });

  it("does not call the webhook when none was configured", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { id: "abc", finished: false } });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeEvent("abc", { decision: "reject" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 409 and skips the webhook when already answered", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "abc", finished: true, webhookUrl: "https://example.com/hook" },
    });
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      })
    );

    const { statusCode, body } = parsed(await handler(makeEvent("abc", { decision: "ok" })));

    expect(statusCode).toBe(409);
    expect(body.message).toMatch(/already answered/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still returns 200 when webhook delivery fails", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "abc", finished: false, webhookUrl: "https://example.com/hook" },
    });
    ddbMock.on(UpdateCommand).resolves({});
    fetchMock.mockRejectedValue(new Error("network down"));

    const { statusCode } = parsed(await handler(makeEvent("abc", { decision: "ok" })));

    expect(statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records the answer and resumes the step function", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "abc", finished: false, taskToken: "token-123" },
    });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(SendTaskSuccessCommand).resolves({});

    const { statusCode, body } = parsed(
      await handler(
        makeEvent("abc", { choiceAnswer: "Yes", textAnswer: "Great", decision: "ok" })
      )
    );

    expect(statusCode).toBe(200);
    expect(body).toEqual({ ok: true });

    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
    const sendCall = sfnMock.commandCalls(SendTaskSuccessCommand)[0];
    expect(sendCall.args[0].input.taskToken).toBe("token-123");
    expect(JSON.parse(sendCall.args[0].input.output as string)).toEqual({
      id: "abc",
      choiceAnswer: "Yes",
      textAnswer: "Great",
      decision: "ok",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not resume the step function when no taskToken was configured", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { id: "abc", finished: false } });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeEvent("abc", { decision: "reject" }));

    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
  });

  it("returns 409 and skips resuming the step function when already answered", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "abc", finished: true, taskToken: "token-123" },
    });
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      })
    );

    const { statusCode, body } = parsed(await handler(makeEvent("abc", { decision: "ok" })));

    expect(statusCode).toBe(409);
    expect(body.message).toMatch(/already answered/);
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(0);
  });

  it("still returns 200 when resuming the step function fails", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "abc", finished: false, taskToken: "token-123" },
    });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(SendTaskSuccessCommand).rejects(new Error("sfn down"));

    const { statusCode } = parsed(await handler(makeEvent("abc", { decision: "ok" })));

    expect(statusCode).toBe(200);
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
  });
});
