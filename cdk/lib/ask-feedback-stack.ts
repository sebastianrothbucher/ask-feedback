import * as crypto from "crypto";
import * as path from "path";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Token } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export class AskFeedbackStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- DynamoDB table -------------------------------------------------
    const table = new dynamodb.Table(this, "FeedbackTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Resolved account id, used below to derive both the S3 bucket name and
    // the public API key value without embedding the raw account number.
    const account = this.account;
    if (Token.isUnresolved(account)) {
      throw new Error(
        "Account id must be resolved at synth time (set env.account in bin/ask-feedback.ts, e.g. via CDK_DEFAULT_ACCOUNT) to derive deterministic, account-scoped values."
      );
    }

    // Created early so its physical id can be handed to CreateFeedbackFn's
    // environment below. Not associated with the API/stage yet - that
    // happens via the usage plan further down, once `api` exists.
    const createApiKey = new apigateway.ApiKey(this, "CreateApiKey");

    // --- S3 static website hosting for the client ------------------------
    // Bucket name must be globally unique (S3), so we derive a short hash
    // from the account id to allow the same stack to be deployed into
    // several accounts without colliding - without embedding the raw
    // account number in the bucket name. Created before the Lambdas so its
    // website URL can be handed to CreateFeedbackFn below, to build the
    // answer link returned from create.
    const accountHash = crypto
      .createHash("sha256")
      .update(account)
      .digest("hex")
      .substring(0, 12);
    const bucketName = `ask-feedback-web-${accountHash}`;

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      bucketName,
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      websiteIndexDocument: "index.html",
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Lambda functions -------------------------------------------------
    const lambdaDefaults: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
      bundling: { minify: true, sourceMap: false, externalModules: ["@aws-sdk/*"] },
    };

    const createFn = new nodejs.NodejsFunction(this, "CreateFeedbackFn", {
      entry: path.join(__dirname, "../lambda/create.ts"),
      ...lambdaDefaults,
      environment: {
        ...lambdaDefaults.environment,
        // API Gateway's apiKeyRequired only checks that *some* key on an
        // associated usage plan was used - this lets the Lambda itself
        // reject requests made with a different key (e.g. the public one).
        CREATE_API_KEY_ID: createApiKey.keyId,
        // Used to build the answerUrl returned from create.
        ANSWER_BASE_URL: siteBucket.bucketWebsiteUrl,
      },
    });
    const getFn = new nodejs.NodejsFunction(this, "GetFeedbackFn", {
      entry: path.join(__dirname, "../lambda/get.ts"),
      ...lambdaDefaults,
    });
    const answerFn = new nodejs.NodejsFunction(this, "AnswerFeedbackFn", {
      entry: path.join(__dirname, "../lambda/answer.ts"),
      ...lambdaDefaults,
    });

    table.grantWriteData(createFn);
    table.grantReadData(getFn);
    table.grantReadWriteData(answerFn);

    // --- API Gateway --------------------------------------------------
    const api = new apigateway.RestApi(this, "FeedbackApi", {
      restApiName: "ask-feedback-api",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "X-Api-Key"],
      },
      deployOptions: { stageName: "prod" },
    });

    const feedbackRequests = api.root.addResource("feedback-requests");
    feedbackRequests.addMethod(
      "POST",
      new apigateway.LambdaIntegration(createFn),
      { apiKeyRequired: true }
    );

    const feedbackRequest = feedbackRequests.addResource("{id}");
    feedbackRequest.addMethod("GET", new apigateway.LambdaIntegration(getFn), {
      apiKeyRequired: true,
    });

    const answer = feedbackRequest.addResource("answer");
    answer.addMethod("POST", new apigateway.LambdaIntegration(answerFn), {
      apiKeyRequired: true,
    });

    // Every method requires SOME valid API key (API Gateway has no concept
    // of a key being valid for only some methods of a stage) - but each key
    // lives on its own usage plan, so the two are throttled independently:
    // a secret key for create (5 req/min) and a key that's shipped to the
    // browser in config.js for get/answer (15 req/min, public by design).
    // CreateFeedbackFn additionally checks CREATE_API_KEY_ID itself, since
    // the usage plan alone doesn't stop the public key from also being
    // accepted here.
    const createUsagePlan = api.addUsagePlan("CreateUsagePlan", {
      throttle: { rateLimit: 5 / 60, burstLimit: 2 },
    });
    createUsagePlan.addApiKey(createApiKey);
    createUsagePlan.addApiStage({ stage: api.deploymentStage });

    // Deterministic (stable across redeploys of the same stack/account)
    // rather than randomly generated, so it doesn't rotate - and force a
    // config.js redeploy - on every `cdk deploy`. It's not a secret: it
    // ships in the client bundle, and only exists to give get/answer their
    // own throttle bucket separate from the create key.
    const publicApiKeyValue = crypto
      .createHash("sha256")
      .update(`${account}:${this.stackName}:public-api-key`)
      .digest("hex");
    const publicApiKey = api.addApiKey("PublicApiKey", {
      value: publicApiKeyValue,
    });
    const publicUsagePlan = api.addUsagePlan("PublicUsagePlan", {
      throttle: { rateLimit: 15 / 60, burstLimit: 5 },
    });
    publicUsagePlan.addApiKey(publicApiKey);
    publicUsagePlan.addApiStage({ stage: api.deploymentStage });

    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../client")),
        s3deploy.Source.data(
          "config.js",
          `window.ASK_FEEDBACK_CONFIG = { apiBaseUrl: "${api.url}", apiKey: "${publicApiKeyValue}" };\n`
        ),
      ],
      destinationBucket: siteBucket,
    });

    // --- Outputs -----------------------------------------------------
    new CfnOutput(this, "ApiUrl", { value: api.url });
    new CfnOutput(this, "CreateApiKeyId", { value: createApiKey.keyId });
    new CfnOutput(this, "PublicApiKeyId", { value: publicApiKey.keyId });
    new CfnOutput(this, "SiteBucketName", { value: siteBucket.bucketName });
    new CfnOutput(this, "SiteUrl", { value: siteBucket.bucketWebsiteUrl });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
