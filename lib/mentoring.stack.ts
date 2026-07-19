import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  BookingNotificationsQueueUrlEnv,
  BookingNotificationsTopicArnEnv,
  BookingsTableName,
  BookingsTableNameEnv,
  MentorsTableName,
  MentorsTableNameEnv,
  StudentsTableName,
  StudentsTableNameEnv,
  TimeSlotsTableName,
  TimeSlotsTableNameEnv,
} from './constants';


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

    const studentsTable = new dynamodb.Table(this, "Students", {
      tableName: StudentsTableName,
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Notifications infrastructure
    const bookingNotificationsDlq = new sqs.Queue(this, "BookingNotificationsDLQ", {
      retentionPeriod: cdk.Duration.days(14),
    });

    const bookingNotificationsQueue = new sqs.Queue(this, "BookingNotificationsQueue", {
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: {
        queue: bookingNotificationsDlq,
        maxReceiveCount: 3,
      },
    });

    const bookingNotificationsTopic = new sns.Topic(this, "BookingNotificationsTopic", {
      displayName: "Booking Notifications",
    });

    // Lambda functions
    const getMentorsLambda = new NodejsFunction(this, 'getMentors', {
      ...commonProps,
      handler: 'getMentors',
      environment: {
        [MentorsTableNameEnv]: MentorsTableName,
      },
    });
    mentorsTable.grantReadData(getMentorsLambda);

    const getTimeSlotsLambda = new NodejsFunction(this, 'getTimeSlots', {
      ...commonProps,
      handler: 'getTimeSlots',
      environment: {
        [TimeSlotsTableNameEnv]: TimeSlotsTableName,
      },
    });
    timeSlotsTable.grantReadData(getTimeSlotsLambda);

    const bookTimeSlotLambda = new NodejsFunction(this, 'bookTimeSlot', {
      ...commonProps,
      handler: 'bookTimeSlot',
      environment: {
        [BookingsTableNameEnv]: BookingsTableName,
        [TimeSlotsTableNameEnv]: TimeSlotsTableName,
        [BookingNotificationsQueueUrlEnv]: bookingNotificationsQueue.queueUrl,
      },
    });
    bookingsTable.grantWriteData(bookTimeSlotLambda);
    timeSlotsTable.grantReadWriteData(bookTimeSlotLambda);
    bookingNotificationsQueue.grantSendMessages(bookTimeSlotLambda);

    const cancelBookingLambda = new NodejsFunction(this, 'cancelBooking', {
      ...commonProps,
      handler: 'cancelBooking',
      environment: {
        [BookingsTableNameEnv]: BookingsTableName,
        [TimeSlotsTableNameEnv]: TimeSlotsTableName,
        [BookingNotificationsQueueUrlEnv]: bookingNotificationsQueue.queueUrl,
      },
    });
    bookingsTable.grantReadWriteData(cancelBookingLambda);
    timeSlotsTable.grantReadWriteData(cancelBookingLambda);
    bookingNotificationsQueue.grantSendMessages(cancelBookingLambda);

    const sendBookingNotificationLambda = new NodejsFunction(this, 'sendBookingNotification', {
      ...commonProps,
      handler: 'sendBookingNotification',
      environment: {
        [MentorsTableNameEnv]: MentorsTableName,
        [StudentsTableNameEnv]: StudentsTableName,
        [BookingNotificationsTopicArnEnv]: bookingNotificationsTopic.topicArn,
      },
    });
    mentorsTable.grantReadData(sendBookingNotificationLambda);
    studentsTable.grantReadData(sendBookingNotificationLambda);
    bookingNotificationsTopic.grantPublish(sendBookingNotificationLambda);
    sendBookingNotificationLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sns:Subscribe'],
      resources: [bookingNotificationsTopic.topicArn],
    }));
    sendBookingNotificationLambda.addEventSource(new SqsEventSource(bookingNotificationsQueue, {
      batchSize: 10,
    }));

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

    const cancelBookingLambdaIntegration = new apigateway.LambdaIntegration(cancelBookingLambda, {
      integrationResponses: [
        {
          statusCode: '204',
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
        'application/json': `{
          "bookingId": "$util.escapeJavaScript($input.params('bookingId'))"
        }`,
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

    const deleteBookingResource = bookingsResource.addResource("{bookingId}")
    deleteBookingResource.addMethod('DELETE', cancelBookingLambdaIntegration, {
      requestParameters: {
        'method.request.path.bookingId': true
      },
      methodResponses: [
        {
          statusCode: '204',
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
    })
  }
}