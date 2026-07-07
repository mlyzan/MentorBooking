#!/usr/bin/env node
import 'dotenv/config'; 
import * as cdk from 'aws-cdk-lib/core';
import { MentoringLambdaStack } from '../lib/mentoring.stack';

const app = new cdk.App();
const mentoringLambdaStack = new MentoringLambdaStack(app, 'MentoringLambdaStack', {});

