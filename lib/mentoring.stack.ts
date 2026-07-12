import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BookingsTableName, MentorsTableName, TimeSlotsTableName } from './constants';


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

    const timeSlotsTable = new dynamodb.Table(this, "TimeSlots", {
      tableName: TimeSlotsTableName,
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
    });

    const bookingsTable = new dynamodb.Table(this, "Bookings", {
      tableName: BookingsTableName,
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

    const getTimeSlotsLambda = new NodejsFunction(this, 'getTimeSlots', {
      ...commonProps,
      handler: 'getTimeSlots',
      environment: {
        TIME_SLOTS_TABLE_NAME: TimeSlotsTableName
      },
    });
    timeSlotsTable.grantReadData(getTimeSlotsLambda);

    const bookTimeSlotLambda = new NodejsFunction(this, 'bookTimeSlot', {
      ...commonProps,
      handler: 'bookTimeSlot',
      environment: {
        BOOKINGS_TABLE_NAME: BookingsTableName,
        TIME_SLOTS_TABLE_NAME: TimeSlotsTableName
      },
    });
    bookingsTable.grantWriteData(bookTimeSlotLambda);
    timeSlotsTable.grantReadWriteData(bookTimeSlotLambda); 

    // API Gateways
    const api = new apigateway.RestApi(this, "api", {
      restApiName: "Mentors API Gateway",
      description: "This API serves the Lambda functions."
    });
    
    const mentorsLambdaIntegration = new apigateway.LambdaIntegration(getMentorsLambda, {
      integrationResponses: [
        {
          statusCode: '200',
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
        },
        {
          statusCode: '500',
          selectionPattern: '^InternalServerError:.*',
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
          responseTemplates: {
            'application/json': `#set($msg = $input.path('$.errorMessage'))\n{"error": true, "message": "$util.escapeJavaScript($msg.replaceAll("InternalServerError: ", ""))"}`,
          },
        }, 
      ],
      proxy: false,
      requestTemplates: {
        'application/json': `{
          "expertises": "$util.escapeJavaScript($input.params('expertises'))"
        }`,
      },
    });

    const timeSlotsLambdaIntegration = new apigateway.LambdaIntegration(getTimeSlotsLambda, {
      integrationResponses: [
        {
          statusCode: '200',
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
        },
        {
          statusCode: '500',
          selectionPattern: '^InternalServerError:.*',
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
          responseTemplates: {
            'application/json': `#set($msg = $input.path('$.errorMessage'))\n{"error": true, "message": "$util.escapeJavaScript($msg.replaceAll("InternalServerError: ", ""))"}`,
          },
        },
      ],
      proxy: false,
      requestTemplates: {
        'application/json': `{
          "mentorId": "$util.escapeJavaScript($input.params('mentorId'))",
          "startTime": "$util.escapeJavaScript($input.params('startTime'))"
        }`,
      },
    });

    const bookTimeSlotLambdaIntegration = new apigateway.LambdaIntegration(bookTimeSlotLambda, {
      integrationResponses: [
        {
          statusCode: '200',
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
        },
        {
          statusCode: '404',
          selectionPattern: '^NotFound:.*',
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
          responseTemplates: {
            'application/json': `#set($msg = $input.path('$.errorMessage'))\n{"error": true, "message": "$util.escapeJavaScript($msg.replaceAll("NotFound: ", ""))"}`,
          },
        },
        {
          statusCode: '500',
          selectionPattern: '^InternalServerError:.*',
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": "'*'",
          },
          responseTemplates: {
            'application/json': `#set($msg = $input.path('$.errorMessage'))\n{"error": true, "message": "$util.escapeJavaScript($msg.replaceAll("InternalServerError: ", ""))"}`,
          },
        },
      ],
      proxy: false,
      requestTemplates: {
        "application/json":
        `{ "body": $input.json('$') }`
      },
    });

    const mentorsResource = api.root.addResource("mentors");
    const timeSlotsResource = mentorsResource.addResource("{mentorId}").addResource("timeslots");

    mentorsResource.addMethod('GET', mentorsLambdaIntegration, {
      requestParameters: {
        'method.request.querystring.expertises': false
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: '500',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });

    timeSlotsResource.addMethod('GET', timeSlotsLambdaIntegration, {
      requestParameters: {
        'method.request.path.mentorId': true,
        'method.request.querystring.startTime': false
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: '500',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });

    const bookingsResource = api.root.addResource("bookings");
    bookingsResource.addMethod('POST', bookTimeSlotLambdaIntegration, {
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: '404',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: '500',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });
  }
}