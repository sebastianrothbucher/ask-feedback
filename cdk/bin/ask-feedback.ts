#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AskFeedbackStack } from "../lib/ask-feedback-stack";

const app = new cdk.App();
new AskFeedbackStack(app, "AskFeedbackStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
});
