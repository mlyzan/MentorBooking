import { Readable } from 'stream';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { Handler, S3Event, SQSEvent, SQSRecord, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import csvParser from 'csv-parser';
import {
  BookingsExportedQueueUrlEnv,
  BookingsExportedTopicArnEnv,
  BookingsExportQueueUrlEnv,
  BookingsTableNameEnv,
  ExportUrlExpirationSecondsEnv,
  ImportBucketNameEnv,
  MentorsImportedQueueUrlEnv,
  MentorsImportedTopicArnEnv,
  MentorsTableName,
  UploadedPrefixEnv,
} from '../constants';
import { BookedSession, BookingsExportedEvent, BookingsExportRequestedEvent, Mentor } from '../interfaces';

const s3 = new S3Client({});
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const sns = new SNSClient({});

interface MentorsImportedEvent {
  eventType: 'mentors.imported';
  bucket: string;
  key: string;
  total: number;
  success: number;
  failure: number;
  errors: string[];
  importedAt: string;
}

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`InternalServerError: ${name} is not configured.`);
  }
  return value;
};

export const importMentorsFile: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> = async (event) => {
  try {
    const bucket = requireEnv(ImportBucketNameEnv);
    const prefix = requireEnv(UploadedPrefixEnv);

    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: true, message: 'Request body is required.' }),
      };
    }

    const fileName = event.queryStringParameters?.name || 'mentors.csv';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${prefix}${timestamp}/${fileName}`;

    const body: Buffer = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body, 'utf-8');

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'text/csv',
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'File uploaded successfully. Processing will start shortly.',
        bucket,
        key,
      }),
    };
  } catch (error: any) {
    console.error('Error uploading mentors file:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: true, message: error.message || 'Failed to upload file.' }),
    };
  }
};

const parseExpertises = (raw?: string): string[] =>
  raw ? raw.split(',').map(v => v.trim()).filter(Boolean) : [];

const isValidMentorRow = (row: Record<string, string>): boolean =>
  Boolean(row.email && row.name && row.email.includes('@'));

const parseCsvStream = (stream: Readable): Promise<Record<string, string>[]> =>
  new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    stream
      .pipe(csvParser())
      .on('data', (row: Record<string, string>) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });

export const importFileParser: Handler<S3Event> = async (event) => {
  const queueUrl = requireEnv(MentorsImportedQueueUrlEnv);
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    let total = 0;
    let success = 0;
    let failure = 0;
    const errors: string[] = [];

    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!(object.Body instanceof Readable)) {
        throw new Error('S3 object body is not a readable stream.');
      }

      const rows = await parseCsvStream(object.Body);
      total = rows.length;

      for (const row of rows) {
        if (!isValidMentorRow(row)) {
          failure++;
          errors.push(`Invalid row: ${JSON.stringify(row)}`);
          continue;
        }
        try {
          const mentor: Mentor = {
            id: uuidv4(),
            name: row.name.trim(),
            email: row.email.trim(),
            expertises: parseExpertises(row.expertises),
          };
          await doc.send(new PutCommand({
            TableName: MentorsTableName,
            Item: mentor,
          }));
          success++;
        } catch (err: any) {
          failure++;
          errors.push(`Failed to insert ${row.email}: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.error('Failed to process CSV:', err);
      errors.push(`Failed to process file: ${err.message}`);
      failure = total - success;
    }

    const importedEvent: MentorsImportedEvent = {
      eventType: 'mentors.imported',
      bucket,
      key,
      total,
      success,
      failure,
      errors: errors.slice(0, 20),
      importedAt: new Date().toISOString(),
    };
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(importedEvent),
    }));
  }
};

const buildImportEmail = (event: MentorsImportedEvent): { subject: string; message: string } => {
  const subject = `Mentors import completed: ${event.success}/${event.total} succeeded`;
  const errorsSection = event.errors.length
    ? `\n\nErrors:\n${event.errors.join('\n')}`
    : '';
  const message =
    `Mentors import completed at ${event.importedAt}.\n\n` +
    `Source: s3://${event.bucket}/${event.key}\n` +
    `Total: ${event.total}\n` +
    `Success: ${event.success}\n` +
    `Failure: ${event.failure}` +
    errorsSection;
  return { subject, message };
};

const processImportedRecord = async (record: SQSRecord, topicArn: string): Promise<void> => {
  const event = JSON.parse(record.body) as MentorsImportedEvent;
  if (event.eventType !== 'mentors.imported') {
    console.warn(`Unsupported event type: ${event.eventType}`);
    return;
  }
  const { subject, message } = buildImportEmail(event);
  await sns.send(new PublishCommand({
    TopicArn: topicArn,
    Subject: subject.slice(0, 100),
    Message: message,
  }));
};

export const mentorsImportNotification: Handler<SQSEvent> = async (event) => {
  const topicArn = requireEnv(MentorsImportedTopicArnEnv);

  for (const record of event.Records) {
    try {
      await processImportedRecord(record, topicArn);
    } catch (err) {
      console.error(`Failed to process record ${record.messageId}:`, err);
      throw err;
    }
  }
};

export const exportBookings: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> = async () => {
  try {
    const queueUrl = requireEnv(BookingsExportQueueUrlEnv);
    const requestedEvent: BookingsExportRequestedEvent = {
      eventType: 'bookings.export.requested',
      exportId: uuidv4(),
      requestedAt: new Date().toISOString(),
    };
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(requestedEvent),
    }));

    return {
      statusCode: 202,
      body: JSON.stringify({
        message: 'Bookings export scheduled. You will receive an email when it is ready.',
        exportId: requestedEvent.exportId,
      }),
    };
  } catch (error: any) {
    console.error('Error scheduling bookings export:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: true, message: error.message || 'Failed to schedule bookings export.' }),
    };
  }
};

const BOOKINGS_CSV_HEADER = ['id', 'mentorId', 'studentId', 'timeSlotId', 'startTime', 'endTime', 'createdAt'];

const escapeCsvField = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const buildBookingsCsv = (bookings: BookedSession[]): string => {
  const rows = bookings.map(b => BOOKINGS_CSV_HEADER.map(h => escapeCsvField((b as any)[h])).join(','));
  return [BOOKINGS_CSV_HEADER.join(','), ...rows].join('\n');
};

const scanAllBookings = async (tableName: string): Promise<BookedSession[]> => {
  const items: BookedSession[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const result = await doc.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey,
    }));
    if (result.Items) items.push(...(result.Items as BookedSession[]));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

const processExportRequest = async (record: SQSRecord): Promise<void> => {
  const bucket = requireEnv(ImportBucketNameEnv);
  const prefix = requireEnv(UploadedPrefixEnv);
  const tableName = requireEnv(BookingsTableNameEnv);
  const notifyQueueUrl = requireEnv(BookingsExportedQueueUrlEnv);
  const expiresIn = Number(process.env[ExportUrlExpirationSecondsEnv] || 604800);

  const request = JSON.parse(record.body) as BookingsExportRequestedEvent;
  if (request.eventType !== 'bookings.export.requested') {
    console.warn(`Unsupported event type: ${request.eventType}`);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${prefix}${timestamp}/bookings.csv`;
  let status: 'success' | 'failure' = 'success';
  let recordCount = 0;
  let downloadUrl = '';
  let errorMessage: string | undefined;

  try {
    const bookings = await scanAllBookings(tableName);
    recordCount = bookings.length;
    const csv = buildBookingsCsv(bookings);

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: csv,
      ContentType: 'text/csv',
      ServerSideEncryption: 'AES256',
    }));

    downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn },
    );
  } catch (err: any) {
    console.error('Failed to export bookings:', err);
    status = 'failure';
    errorMessage = err.message || 'Unknown error';
  }

  const exportedEvent: BookingsExportedEvent = {
    eventType: 'bookings.exported',
    exportId: request.exportId,
    status,
    recordCount,
    bucket,
    key,
    downloadUrl,
    exportedAt: new Date().toISOString(),
    error: errorMessage,
  };
  await sqs.send(new SendMessageCommand({
    QueueUrl: notifyQueueUrl,
    MessageBody: JSON.stringify(exportedEvent),
  }));
};

export const bookingsExportProcessor: Handler<SQSEvent> = async (event) => {
  for (const record of event.Records) {
    try {
      await processExportRequest(record);
    } catch (err) {
      console.error(`Failed to process export request ${record.messageId}:`, err);
      throw err;
    }
  }
};

const buildExportEmail = (event: BookingsExportedEvent): { subject: string; message: string } => {
  if (event.status === 'failure') {
    return {
      subject: `Bookings export failed (${event.exportId})`,
      message:
        `Bookings export failed at ${event.exportedAt}.\n\n` +
        `Export ID: ${event.exportId}\n` +
        `Error: ${event.error || 'Unknown error'}`,
    };
  }
  return {
    subject: `Bookings export ready: ${event.recordCount} records`,
    message:
      `Bookings export completed at ${event.exportedAt}.\n\n` +
      `Export ID: ${event.exportId}\n` +
      `Records: ${event.recordCount}\n` +
      `Location: s3://${event.bucket}/${event.key}\n\n` +
      `Download link (temporary):\n${event.downloadUrl}`,
  };
};

const processExportedRecord = async (record: SQSRecord, topicArn: string): Promise<void> => {
  const event = JSON.parse(record.body) as BookingsExportedEvent;
  if (event.eventType !== 'bookings.exported') {
    console.warn(`Unsupported event type: ${event.eventType}`);
    return;
  }
  const { subject, message } = buildExportEmail(event);
  await sns.send(new PublishCommand({
    TopicArn: topicArn,
    Subject: subject.slice(0, 100),
    Message: message,
  }));
};

export const bookingsExportNotification: Handler<SQSEvent> = async (event) => {
  const topicArn = requireEnv(BookingsExportedTopicArnEnv);
  for (const record of event.Records) {
    try {
      await processExportedRecord(record, topicArn);
    } catch (err) {
      console.error(`Failed to process record ${record.messageId}:`, err);
      throw err;
    }
  }
};
