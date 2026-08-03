import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  AdminsGroup,
  MentorsGroup,
  StudentsGroup,
  UserPoolClientIdEnv,
  UserPoolIdEnv,
} from './constants';

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly authorizerFnArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'MentorBookingUserPool',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient('AppClient', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
    });

    [StudentsGroup, MentorsGroup, AdminsGroup].forEach((groupName) => {
      new cognito.CfnUserPoolGroup(this, `Group${groupName}`, {
        userPoolId: this.userPool.userPoolId,
        groupName,
      });
    });

    const authorizerFn = new NodejsFunction(this, 'RbacAuthorizer', {
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(5),
      entry: path.join(__dirname, 'services', 'authorizer.ts'),
      handler: 'handler',
      environment: {
        [UserPoolIdEnv]: this.userPool.userPoolId,
        [UserPoolClientIdEnv]: this.userPoolClient.userPoolClientId,
      },
      bundling: {
        nodeModules: ['aws-jwt-verify'],
      },
    });

    authorizerFn.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });

    this.authorizerFnArn = authorizerFn.functionArn;

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'AuthorizerFnArn', { value: this.authorizerFnArn });
  }
}
