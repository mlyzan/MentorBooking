#!/usr/bin/env node
import 'dotenv/config';
import * as cdk from 'aws-cdk-lib/core';
import { MentoringLambdaStack } from '../lib/mentoring.stack';
import { ImportServiceStack } from '../lib/admin.stack';
import { AuthStack } from '../lib/auth.stack';

const app = new cdk.App();

const authStack = new AuthStack(app, 'AuthStack', {});

new MentoringLambdaStack(app, 'MentoringLambdaStack', {
  authorizerFnArn: authStack.authorizerFnArn,
});

new ImportServiceStack(app, 'ImportServiceStack', {
  authorizerFnArn: authStack.authorizerFnArn,
});
