import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AskFeedbackStack } from "../lib/ask-feedback-stack";

const TEST_ACCOUNT = "123456789012";
const TEST_REGION = "us-east-1";

function synthTemplate(): Template {
  const app = new App();
  const stack = new AskFeedbackStack(app, "TestStack", {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
  });
  return Template.fromStack(stack);
}

// Lambda asset hashes (from esbuild bundling) are derived in part from the
// absolute checkout path, so they vary across machines. Normalize them
// before snapshotting so the snapshot is portable and doesn't churn.
function normalize(templateJson: unknown): unknown {
  const str = JSON.stringify(templateJson);
  return JSON.parse(str.replace(/[0-9a-f]{64}/g, "<ASSET_HASH>"));
}

describe("AskFeedbackStack", () => {
  // Synthesized once and shared: each synth bundles all three Lambdas via
  // esbuild, which is the slow part of this suite.
  let template: Template;

  beforeAll(() => {
    template = synthTemplate();
  });

  it("matches the expected CloudFormation template", () => {
    expect(normalize(template.toJSON())).toMatchSnapshot();
  });

  it("creates an on-demand DynamoDB table keyed on id", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    });
  });

  it("requires an API key on every non-preflight method", () => {
    const methods = template.findResources("AWS::ApiGateway::Method");
    const httpMethods = Object.values(methods)
      .map(
        (resource) => (resource as { Properties: { HttpMethod: string; ApiKeyRequired?: boolean } }).Properties
      )
      .filter((m) => m.HttpMethod !== "OPTIONS"); // CORS preflight methods stay key-free

    expect(httpMethods).toHaveLength(3); // create, get, answer
    expect(httpMethods.every((m) => m.ApiKeyRequired === true)).toBe(true);
  });

  it("puts the create and public keys on separate usage plans with 5/15 req-min throttles", () => {
    template.resourceCountIs("AWS::ApiGateway::ApiKey", 2);
    template.resourceCountIs("AWS::ApiGateway::UsagePlan", 2);

    template.hasResourceProperties("AWS::ApiGateway::UsagePlan", {
      Throttle: { RateLimit: 5 / 60, BurstLimit: 2 },
    });
    template.hasResourceProperties("AWS::ApiGateway::UsagePlan", {
      Throttle: { RateLimit: 15 / 60, BurstLimit: 5 },
    });
  });

  it("gives the public API key a deterministic value, not an AWS-generated secret", () => {
    const keys = template.findResources("AWS::ApiGateway::ApiKey");
    const values = Object.values(keys).map(
      (resource) => (resource as { Properties: { Value?: string } }).Properties.Value
    );
    expect(values).toContainEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it("names the site bucket from a hash of the account id, not the raw id", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    const bucketNames = Object.values(buckets).map(
      (resource) => (resource as { Properties: { BucketName: string } }).Properties.BucketName
    );

    expect(bucketNames).toContainEqual(expect.stringMatching(/^ask-feedback-web-[0-9a-f]{12}$/));
    expect(bucketNames.some((name) => name.includes(TEST_ACCOUNT))).toBe(false);
  });
});
