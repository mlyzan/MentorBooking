import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MentorsTableName } from './constants';


export class MentoringLambdaStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const entry = path.join(__dirname, 'services', 'mentorsService.ts');
    const commonProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(5),
      entry,
    };

    // DynamoDB Tables
    const mentorsTable = new dynamodb.Table(this, "Mentors", {
      tableName: MentorsTableName,
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Lambda functions
    const getMentorsLambda = new NodejsFunction(this, 'getMentors', {
      ...commonProps,
      handler: 'getMentors',
      environment: {
        MENTORS_TABLE_NAME: MentorsTableName
      },
    });
    mentorsTable.grantReadData(getMentorsLambda);

    // API Gateways
    const api = new apigateway.RestApi(this, "api", {
      restApiName: "Mentors API Gateway",
      description: "This API serves the Lambda functions."
    });
    
    const mentorsLambdaIntegration = new apigateway.LambdaIntegration(getMentorsLambda, {
      integrationResponses: [{
        statusCode: '200',
        responseParameters: {
          "method.response.header.Access-Control-Allow-Origin": "'*'",
        },
      }],
      proxy: false,
      requestTemplates: {
        'application/json': `{
          "expertises": "$util.escapeJavaScript($input.params('expertises'))"
        }`,
      },
    });

    const mentorsResource = api.root.addResource("mentors");

    mentorsResource.addMethod('GET', mentorsLambdaIntegration, {
      requestParameters: {
        'method.request.querystring.expertises': false
      },
      methodResponses: [{
        statusCode: '200',
        responseParameters: {
          'method.response.header.Access-Control-Allow-Origin': true,
        },
      }],
    });
  }
}