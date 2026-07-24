import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SNSClient, PublishCommand, SubscribeCommand, ListSubscriptionsByTopicCommand } from '@aws-sdk/client-sns';
import {
  BookingNotificationsQueueUrlEnv,
  BookingNotificationsTopicArnEnv,
  BookingsTableName,
  MentorsTableName,
  StudentsTableName,
  TimeSlotsTableName,
} from '../constants';
import { Handler, SQSEvent, SQSRecord } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { 
  TimeSlot,
  BookTimeSlotEvent,
  CancelBookingEvent,
  Mentor,
  Student,
  GetMentorsEvent,
  GetTimeSlotsEvent,
  BookingCreatedEvent,
  BookingCanceledEvent,
  CreateTimeSlotEvent,
  BookedSession,
  BookedSessionsEvent,
  Sessions,
 } from '../interfaces';

const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);
const sqs = new SQSClient({});
const sns = new SNSClient({});

const parseCsv = (value?: string): string[] => value ? value.split(',').map(v => v.trim()).filter(Boolean) : [];

export const getMentors: Handler = async (event: GetMentorsEvent = {}): Promise<{ mentors: Mentor[] }> => {
  try {
    const expertises = parseCsv(event.expertises);

    const filterExpressions: string[] = [];
    const ExpressionAttributeNames: Record<string, string> = {};
    const ExpressionAttributeValues: Record<string, unknown> = {};

    expertises.forEach((value, i) => {
      const valueKey = `:expertise${i}`;
      ExpressionAttributeNames['#expertises'] = 'expertises';
      ExpressionAttributeValues[valueKey] = value;
      filterExpressions.push(`contains(#expertises, ${valueKey})`);
    });

    const params: ScanCommandInput = { TableName: MentorsTableName };
    if (filterExpressions.length > 0) {
      params.FilterExpression = filterExpressions.join(' AND ');
      params.ExpressionAttributeNames = ExpressionAttributeNames;
      params.ExpressionAttributeValues = ExpressionAttributeValues;
    }

    const result = await doc.send(new ScanCommand(params));
    let mentors = (result.Items as Mentor[]) || [];

    return { mentors };
  } catch(error) {
    console.error('Error fetching mentors:', error);
    throw new Error('InternalServerError: An error occurred while fetching mentors.');
  }
};


export const getTimeSlots: Handler = async (event: GetTimeSlotsEvent): Promise<{ timeSlots: TimeSlot[] }> => {
  try {
    const { mentorId, startTime } = event;

    const params: ScanCommandInput = {
      TableName: TimeSlotsTableName,
      FilterExpression: '#mentorId = :mentorId AND #startTime > :now AND #available = :available',
      ExpressionAttributeNames: {
        '#mentorId': 'mentorId',
        '#startTime': 'startTime',
        '#available': 'available',
      },
      ExpressionAttributeValues: {
        ':mentorId': mentorId,
        ':now': startTime || new Date().toISOString(),
        ':available': true,
      },
    };

    const result = await doc.send(new ScanCommand(params));
    const timeSlots = (result.Items as TimeSlot[]) || [];

    return { timeSlots };
  } catch(error: any) {
    console.error('Error fetching time slots:', error);
    throw new Error('InternalServerError: An error occurred while fetching time slots.');
  }
};

export const bookTimeSlot: Handler = async (event: BookTimeSlotEvent): Promise<{ message: string; bookingId: string }> => {
  try {
    const { timeSlotId, mentorId, studentId, startTime, endTime } = event.body;

    // Check if the time slot is available
    const params: ScanCommandInput = {
      TableName: TimeSlotsTableName,
      FilterExpression: '#id = :timeSlotId AND #mentorId = :mentorId AND #startTime >= :startTime AND #endTime <= :endTime AND #available = :available',
      ExpressionAttributeNames: {
        '#id': 'id',
        '#mentorId': 'mentorId',
        '#startTime': 'startTime',
        '#endTime': 'endTime',
        '#available': 'available',
      },
      ExpressionAttributeValues: {
        ':timeSlotId': timeSlotId,
        ':mentorId': mentorId,
        ':startTime': startTime,
        ':endTime': endTime,
        ':available': true,
      },
    };

    const result = await doc.send(new ScanCommand(params));
    const timeSlots = (result.Items as TimeSlot[]) || [];

    if (timeSlots.length === 0) {
      throw new Error('NotFound: Time slot is not available for booking.');
    }

    // Mark time slot available false
    const timeSlot = timeSlots[0];
    await doc.send(new PutCommand({
      TableName: TimeSlotsTableName,
      Item: {
        ...timeSlot,
        available: false,
      },
    }));

    const bookingId = uuidv4();
    const createdAt = new Date().toISOString();

    // Create a booking record in the Bookings table
    await doc.send(new PutCommand({
      TableName: BookingsTableName,
      Item: {
        id: bookingId,
        timeSlotId,
        mentorId,
        studentId,
        startTime,
        endTime,
        createdAt,
      },
    }));

    // Enqueue booking.created event for post-processing (email notifications)
    const queueUrl = process.env[BookingNotificationsQueueUrlEnv];
    if (!queueUrl) {
      throw new Error(`InternalServerError: ${BookingNotificationsQueueUrlEnv} is not configured.`);
    }
    const bookingEvent: BookingCreatedEvent = {
      eventType: 'booking.created',
      bookingId,
      timeSlotId,
      mentorId,
      studentId,
      startTime,
      endTime,
      createdAt,
    };
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(bookingEvent),
    }));

    return { message: 'Time slot booked successfully.', bookingId };
  } catch(error: any) {
    console.error('Error booking time slot:', error);
    if (error.message.startsWith('NotFound:')) {
      throw new Error(error.message);
    } else if (error.message.startsWith('InternalServerError:')) {
      throw new Error(error.message);
    } else {
      throw new Error('InternalServerError: An error occurred while booking the time slot.');
    }
  }
};

export const cancelBooking: Handler = async (event: CancelBookingEvent): Promise<{message: string}> => {
  try {
    const { bookingId } = event;
    const result = await doc.send(new GetCommand({
      TableName: BookingsTableName,
      Key: { id: bookingId },
    }));
    if (!result.Item) {
      throw new Error(`NotFound: Not found booking by ID ${bookingId}`);
    }
    const timeSlot = await doc.send(new GetCommand({
      TableName: TimeSlotsTableName,
      Key: { id: result.Item.timeSlotId },
    }));
    if (!timeSlot.Item) {
      throw new Error(`NotFound: Not found time slot by ID ${result.Item.timeSlotId}`);
    }
    await doc.send(new PutCommand({
      TableName: TimeSlotsTableName,
      Item: {
        ...timeSlot.Item,
        available: true,
      },
    }));
    await doc.send(new DeleteCommand({
      TableName: BookingsTableName,
      Key: { id: bookingId },
    }));


    // Enqueue booking.canceled event for post-processing (email notifications)
    const queueUrl = process.env[BookingNotificationsQueueUrlEnv];
    if (!queueUrl) {
      throw new Error(`InternalServerError: ${BookingNotificationsQueueUrlEnv} is not configured.`);
    }
    const bookingEvent: BookingCanceledEvent = {
      eventType: 'booking.canceled',
      bookingId,
      timeSlotId: timeSlot.Item.id,
      mentorId: timeSlot.Item.mentorId,
      studentId: result.Item.studentId,
      startTime: result.Item.startTime,
      endTime: result.Item.endTime,
    };
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(bookingEvent),
    }));

    return {message: 'Booking canceled!'}
  } catch(error: any) {
    console.error('Error booking time slot:', error);
    if (error.message.startsWith('NotFound:')) {
      throw new Error(error.message);
    } else {
      throw new Error('InternalServerError: An error occurred while canceling the time slot.');
    }
  }
}

const getMentorById = async (id: string): Promise<Mentor> => {
  const result = await doc.send(new GetCommand({ TableName: MentorsTableName, Key: { id } }));
  if (!result.Item) {
    throw new Error(`NotFound: Mentor ${id} not found`);
  }
  return result.Item as Mentor;
};

const getStudentById = async (id: string): Promise<Student> => {
  const result = await doc.send(new GetCommand({ TableName: StudentsTableName, Key: { id } }));
  if (!result.Item) {
    throw new Error(`NotFound: Student ${id} not found`);
  }
  return result.Item as Student;
};

const isEmailSubscribed = async (topicArn: string, email: string): Promise<boolean> => {
  let nextToken: string | undefined;
  do {
    const res = await sns.send(new ListSubscriptionsByTopicCommand({
      TopicArn: topicArn,
      NextToken: nextToken,
    }));
    const found = res.Subscriptions?.some(
      s => s.Protocol === 'email'
        && s.Endpoint === email
        && s.SubscriptionArn
        && s.SubscriptionArn !== 'PendingConfirmation',
    );
    if (found) return true;
    nextToken = res.NextToken;
  } while (nextToken);
  return false;
};

const ensureEmailSubscription = async (topicArn: string, email: string): Promise<void> => {
  if (await isEmailSubscribed(topicArn, email)) return;
  await sns.send(new SubscribeCommand({
    TopicArn: topicArn,
    Protocol: 'email',
    Endpoint: email,
    ReturnSubscriptionArn: true,
    Attributes: {
      FilterPolicy: JSON.stringify({ email: [email] }),
      FilterPolicyScope: 'MessageAttributes',
    },
  }));
};

const publishBookingEmail = async (
  topicArn: string,
  recipient: 'student' | 'mentor',
  email: string,
  subject: string,
  message: string,
): Promise<void> => {
  await sns.send(new PublishCommand({
    TopicArn: topicArn,
    Subject: subject,
    Message: message,
    MessageAttributes: {
      recipient: { DataType: 'String', StringValue: recipient },
      email: { DataType: 'String', StringValue: email },
    },
  }));
};

const constructBookingEmailMessage = (recipient: 'student' | 'mentor', mentor: Mentor, student: Student, event: BookingCreatedEvent): string => {
  if (recipient === 'student') {
    return `Hi ${student.name},\n\n` +
      `Your booking with ${mentor.name} is confirmed for ${event.startTime} – ${event.endTime}.\n` +
      `Booking ID: ${event.bookingId}\n`;
  } else {
    return `Hi ${mentor.name},\n\n` +
      `${student.name} has booked a session with you for ${event.startTime} – ${event.endTime}.\n` +
      `Booking ID: ${event.bookingId}\n`;
  }
};

const constructCancellationEmailMessage = (recipient: 'student' | 'mentor', mentor: Mentor, student: Student, event: BookingCanceledEvent): string => {
  if (recipient === 'student') {
    return `Hi ${student.name},\n\n` +
      `Your booking with ${mentor.name} for ${event.startTime} – ${event.endTime} has been canceled.\n` +
      `Booking ID: ${event.bookingId}\n`;
  } else {
    return `Hi ${mentor.name},\n\n` +
      `${student.name} has canceled their booking with you for ${event.startTime} – ${event.endTime}.\n` +
      `Booking ID: ${event.bookingId}\n`;
  }
};

const processBookingRecord = async (record: SQSRecord, topicArn: string): Promise<void> => {
  const event = JSON.parse(record.body);

  if (event.eventType !== 'booking.created' && event.eventType !== 'booking.canceled') {
    console.warn(`Unsupported event type: ${event.eventType}`);
    return;
  }

  const [mentor, student] = await Promise.all([
    getMentorById(event.mentorId),
    getStudentById(event.studentId),
  ]);

  let studentMessage: string = '';
  let mentorMessage: string = '';
  let subject: string = '';
  if (event.eventType === 'booking.created') {
    subject = 'Booking confirmed';
    studentMessage = constructBookingEmailMessage('student', mentor, student, event);
    mentorMessage = constructBookingEmailMessage('mentor', mentor, student, event);
  }

  if (event.eventType === 'booking.canceled') {
    subject = 'Booking canceled';
    studentMessage = constructCancellationEmailMessage('student', mentor, student, event);
    mentorMessage = constructCancellationEmailMessage('mentor', mentor, student, event);
  }

  await Promise.all([
    ensureEmailSubscription(topicArn, student.email),
    ensureEmailSubscription(topicArn, mentor.email),
  ]);

  await Promise.all([
    publishBookingEmail(topicArn, 'student', student.email, subject, studentMessage),
    publishBookingEmail(topicArn, 'mentor', mentor.email, subject, mentorMessage),
  ]);
};

export const sendBookingNotification: Handler = async (event: SQSEvent): Promise<void> => {
  const topicArn = process.env[BookingNotificationsTopicArnEnv];
  console.log(`Booking notification topic ARN: ${topicArn}`);
  if (!topicArn) {
    throw new Error(`${BookingNotificationsTopicArnEnv} is not configured.`);
  }

  for (const record of event.Records) {
    try {
      await processBookingRecord(record, topicArn);
    } catch (error) {
      console.error(`Failed to process record ${record.messageId}:`, error);
      throw error;
    }
  }
};

export const createTimeSlot: Handler = async (event: CreateTimeSlotEvent): Promise<{ message: string; timeSlotId: string }> => {
  try {
    const mentorId = event.mentorId;
    const { startTime, endTime } = event.body;

    console.log(`Creating time slot for mentorId: ${mentorId}, startTime: ${startTime}, endTime: ${endTime}`);
    // Validate mentor existence
    await getMentorById(mentorId);

    const timeSlotId = uuidv4();
    const createdAt = new Date().toISOString();
    if (new Date(startTime) >= new Date(endTime)) {
      throw new Error('InvalidTimeSlot: Start time must be before end time.');
    }
    if (new Date(startTime).getTime() < new Date(createdAt).getTime()) {
      throw new Error('InvalidTimeSlot: Start time must be in the future.');
    }

    // Ensures no overlapping time slots exist for the same mentor.
    const params: ScanCommandInput = {
      TableName: TimeSlotsTableName,
      FilterExpression: '#mentorId = :mentorId AND #startTime < :endTime AND #endTime > :startTime',
      ExpressionAttributeNames: {
        '#mentorId': 'mentorId',
        '#startTime': 'startTime',
        '#endTime': 'endTime',
      },
      ExpressionAttributeValues: {
        ':mentorId': mentorId,
        ':startTime': startTime,
        ':endTime': endTime,
      },
    };

    const result = await doc.send(new ScanCommand(params));
    const overlappingSlots = (result.Items as TimeSlot[]) || [];

    if (overlappingSlots.length > 0) {
      throw new Error('InvalidTimeSlot: Overlapping time slot exists for the same mentor.');
    }

    // Create a new time slot record in the TimeSlots table
    await doc.send(new PutCommand({
      TableName: TimeSlotsTableName,
      Item: {
        id: timeSlotId,
        mentorId,
        startTime,
        endTime,
        available: true,
        createdAt,
      },
    }));

    return { message: 'Time slot created successfully.', timeSlotId };

  } catch (error: any) {
    console.error('Error creating time slot:', error);
    if (error.message.startsWith('NotFound:') || error.message.startsWith('InvalidTimeSlot:')) {
      throw new Error(error.message);
    } else {
      throw new Error('InternalServerError: An error occurred while creating the time slot.');
    }
  }

};

export const getBookedSessions: Handler = async (event: BookedSessionsEvent): Promise<{ sessions: BookedSession[]; }> => {
  try {
    const { mentorId, sessions } = event;

    const params: ScanCommandInput = {
      TableName: BookingsTableName,
      FilterExpression: '#mentorId = :mentorId',
      ExpressionAttributeNames: {
        '#mentorId': 'mentorId',
      },
      ExpressionAttributeValues: {
        ':mentorId': mentorId,
      },
    };

    if (sessions && sessions === Sessions.FUTURE) {
      params.FilterExpression += ' AND #startTime > :startTime'
      params.ExpressionAttributeNames = {
        ...params.ExpressionAttributeNames,
        '#startTime': 'startTime',
      };
      params.ExpressionAttributeValues = {
        ...params.ExpressionAttributeValues,
        ':startTime': new Date().toISOString(),
      }
    }

    if (sessions && sessions === Sessions.PAST) {
      params.FilterExpression += ' AND #endTime <= :endTime'
      params.ExpressionAttributeNames = {
        ...params.ExpressionAttributeNames,
        '#endTime': 'endTime',
      };
      params.ExpressionAttributeValues = {
        ...params.ExpressionAttributeValues,
        ':endTime': new Date().toISOString(),
      }
    }

    const result = await doc.send(new ScanCommand(params));
    const resultedSessions = (result.Items as BookedSession[]) || [];

    return { sessions: resultedSessions };
  } catch(error: any) {
    console.error('Error creating time slot:', error);
    throw new Error('InternalServerError: An error occurred while getting booked time slot.');
  }
};