import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import {
  AdminEmailEnv,
  BookingsExportedQueueUrlEnv,
  BookingsExportedTopicArnEnv,
  BookingsExportQueueUrlEnv,
  BookingsTableName,
  BookingsTableNameEnv,
  ExportBookingsPrefix,
  ExportUrlExpirationSecondsEnv,
  ImportBucketName,
  ImportBucketNameEnv,
  MentorsImportedQueueUrlEnv,
  MentorsImportedTopicArnEnv,
  MentorsTableName,
  MentorsTableNameEnv,
  UploadedPrefix,
  UploadedPrefixEnv,
} from './constants';


export class ImportServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const adminEmail = process.env.ADMIN_EMAIL || '';

    const bucket = new s3.Bucket(this, 'MentorsBucket', {
      bucketName: ImportBucketName,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
        },
      ],
    });

    const mentorsTable = dynamodb.Table.fromTableName(this, 'MentorsTableImported', MentorsTableName);
    const bookingsTable = dynamodb.Table.fromTableName(this, 'BookingsTableExported', BookingsTableName);

    const mentorsImportedDlq = new sqs.Queue(this, 'MentorsImportedDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    const mentorsImportedQueue = new sqs.Queue(this, 'MentorsImportedQueue', {
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: mentorsImportedDlq,
        maxReceiveCount: 3,
      },
    });

    const mentorsImportedTopic = new sns.Topic(this, 'MentorsImportedTopic', {
      displayName: 'Mentors Imported Notifications',
    });

    if (adminEmail) {
      mentorsImportedTopic.addSubscription(new snsSubscriptions.EmailSubscription(adminEmail));
    }

    const bookingsExportDlq = new sqs.Queue(this, 'BookingsExportDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    const bookingsExportQueue = new sqs.Queue(this, 'BookingsExportQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      deadLetterQueue: {
        queue: bookingsExportDlq,
        maxReceiveCount: 3,
      },
    });

    const bookingsExportedDlq = new sqs.Queue(this, 'BookingsExportedDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    const bookingsExportedQueue = new sqs.Queue(this, 'BookingsExportedQueue', {
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: bookingsExportedDlq,
        maxReceiveCount: 3,
      },
    });

    const bookingsExportedTopic = new sns.Topic(this, 'BookingsExportedTopic', {
      displayName: 'Bookings Exported Notifications',
    });

    if (adminEmail) {
      bookingsExportedTopic.addSubscription(new snsSubscriptions.EmailSubscription(adminEmail));
    }

    const entry = path.join(__dirname, 'services', 'adminService.ts');
    const commonProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      entry,
      bundling: {
        nodeModules: ['csv-parser'],
      },
    };

    const exportBookings = new NodejsFunction(this, 'exportBookings', {
      ...commonProps,
      handler: 'exportBookings',
      environment: {
        [BookingsExportQueueUrlEnv]: bookingsExportQueue.queueUrl,
      },
    });
    bookingsExportQueue.grantSendMessages(exportBookings);

    const bookingsExportProcessor = new NodejsFunction(this, 'bookingsExportProcessor', {
      ...commonProps,
      timeout: cdk.Duration.seconds(300),
      handler: 'bookingsExportProcessor',
      environment: {
        [ImportBucketNameEnv]: bucket.bucketName,
        [UploadedPrefixEnv]: ExportBookingsPrefix,
        [BookingsTableNameEnv]: BookingsTableName,
        [BookingsExportedQueueUrlEnv]: bookingsExportedQueue.queueUrl,
        [ExportUrlExpirationSecondsEnv]: '604800',
      },
    });
    bucket.grantPut(bookingsExportProcessor);
    bucket.grantRead(bookingsExportProcessor);
    bookingsTable.grantReadData(bookingsExportProcessor);
    bookingsExportedQueue.grantSendMessages(bookingsExportProcessor);
    bookingsExportProcessor.addEventSource(new SqsEventSource(bookingsExportQueue, {
      batchSize: 1,
    }));

    const bookingsExportNotification = new NodejsFunction(this, 'bookingsExportNotification', {
      ...commonProps,
      handler: 'bookingsExportNotification',
      environment: {
        [BookingsExportedTopicArnEnv]: bookingsExportedTopic.topicArn,
        [AdminEmailEnv]: adminEmail,
      },
    });
    bookingsExportedTopic.grantPublish(bookingsExportNotification);
    bookingsExportNotification.addEventSource(new SqsEventSource(bookingsExportedQueue, {
      batchSize: 10,
    }));

    const importMentorsFile = new NodejsFunction(this, 'importMentorsFile', {
      ...commonProps,
      handler: 'importMentorsFile',
      environment: {
        [ImportBucketNameEnv]: bucket.bucketName,
        [BookingsTableNameEnv]: BookingsTableName,
        [UploadedPrefixEnv]: UploadedPrefix,
      },
    });
    bucket.grantPut(importMentorsFile);
    bookingsTable.grantReadData(importMentorsFile);

    const importFileParser = new NodejsFunction(this, 'importFileParser', {
      ...commonProps,
      timeout: cdk.Duration.seconds(60),
      handler: 'importFileParser',
      environment: {
        [ImportBucketNameEnv]: bucket.bucketName,
        [MentorsTableNameEnv]: MentorsTableName,
        [MentorsImportedQueueUrlEnv]: mentorsImportedQueue.queueUrl,
      },
    });
    bucket.grantRead(importFileParser);
    mentorsImportedQueue.grantSendMessages(importFileParser);
    mentorsTable.grantWriteData(importFileParser);

    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new LambdaDestination(importFileParser),
      { prefix: UploadedPrefix }
    );

    const mentorsImportNotification = new NodejsFunction(this, 'mentorsImportNotification', {
      ...commonProps,
      handler: 'mentorsImportNotification',
      environment: {
        [MentorsImportedTopicArnEnv]: mentorsImportedTopic.topicArn,
        [AdminEmailEnv]: adminEmail,
      },
    });
    mentorsImportedTopic.grantPublish(mentorsImportNotification);
    mentorsImportNotification.addEventSource(new SqsEventSource(mentorsImportedQueue, {
      batchSize: 10,
    }));

    const api = new apigateway.RestApi(this, 'api', {
      restApiName: 'Admin API Gateway',
      description: 'This API serves the Lambda functions.',
      binaryMediaTypes: ['text/csv', 'multipart/form-data', 'application/octet-stream'],
    });

    const importMentorsLambdaIntegration = new apigateway.LambdaIntegration(importMentorsFile);

    const importResource = api.root.addResource('import');
    const importMentorsResource = importResource.addResource('mentors');

    importMentorsResource.addMethod('POST', importMentorsLambdaIntegration, {
      requestParameters: {
        'method.request.querystring.name': false,
      },
    });

    importMentorsResource.addCorsPreflight({
      allowOrigins: ['*'],
      allowMethods: ['*'],
    });

    const exportResource = api.root.addResource('exports');
    const exportBookingsResource = exportResource.addResource('bookings');

    const exportBookingsLambdaIntegration = new apigateway.LambdaIntegration(exportBookings);
    exportBookingsResource.addMethod('POST', exportBookingsLambdaIntegration, {});

    exportBookingsResource.addCorsPreflight({
      allowOrigins: ['*'],
      allowMethods: ['*'],
    });

    new cdk.CfnOutput(this, 'ImportApiUrl', {
      value: api.url,
      description: 'Base URL of the Import Service API Gateway',
    });
  }
}
