#!/usr/bin/env node
import 'dotenv/config';
import * as cdk from 'aws-cdk-lib/core';
import { MentoringLambdaStack } from '../lib/mentoring.stack';
import { ImportServiceStack } from '../lib/admin.stack';

const app = new cdk.App();
new MentoringLambdaStack(app, 'MentoringLambdaStack', {});
new ImportServiceStack(app, 'ImportServiceStack', {});

