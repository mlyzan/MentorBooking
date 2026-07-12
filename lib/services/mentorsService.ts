import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import { BookingsTableName, MentorsTableName, TimeSlotsTableName } from '../constants';
import { Handler } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';

const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);

export interface Mentor {
  id: string;
  name: string;
  expertises: string[];
}

export interface GetMentorsEvent {
  expertises?: string;
}

export interface TimeSlot {
  id: string;
  mentorId: string;
  startTime: string;
  endTime: string;
}

export interface GetTimeSlotsEvent {
  mentorId: string;
  startTime?: string;
}

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
    console.log(`ScanCommand params: ${JSON.stringify(params)}`);

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
      FilterExpression: '#mentorId = :mentorId AND #startTime > :now',
      ExpressionAttributeNames: {
        '#mentorId': 'mentorId',
        '#startTime': 'startTime',
      },
      ExpressionAttributeValues: {
        ':mentorId': mentorId,
        ':now': startTime || new Date().toISOString(),
      },
    };
    console.log(`ScanCommand params: ${JSON.stringify(params)}`);

    const result = await doc.send(new ScanCommand(params));
    const timeSlots = (result.Items as TimeSlot[]) || [];

    return { timeSlots };
  } catch(error: any) {
    console.error('Error fetching time slots:', error);
    throw new Error('InternalServerError: An error occurred while fetching time slots.');
  }
};

export interface BookTimeSlotEvent {
  body: { timeSlotId: string; mentorId: string; startTime: string; endTime: string };
}

export const bookTimeSlot: Handler = async (event: BookTimeSlotEvent, context: any, callback: any): Promise<{ message: string }> => {
  try {
    const { timeSlotId, mentorId, startTime, endTime } = event.body;

    // Check if the time slot is available
    const params: ScanCommandInput = {
      TableName: TimeSlotsTableName,
      FilterExpression: '#id = :timeSlotId AND #mentorId = :mentorId AND #startTime >= :startTime AND #endTime <= :endTime',
      ExpressionAttributeNames: {
        '#id': 'id',
        '#mentorId': 'mentorId',
        '#startTime': 'startTime',
        '#endTime': 'endTime',
      },
      ExpressionAttributeValues: {
        ':timeSlotId': timeSlotId,
        ':mentorId': mentorId,
        ':startTime': startTime,
        ':endTime': endTime,
      },
    };
    console.log(`ScanCommand params for booking: ${JSON.stringify(params)}`);

    const result = await doc.send(new ScanCommand(params));
    const timeSlots = (result.Items as TimeSlot[]) || [];

    if (timeSlots.length === 0) {
      throw new Error('NotFound: Time slot is not available for booking.');
    }

    // Delete the time slot from the TimeSlots table to mark it as booked
    const timeSlot = timeSlots[0];
    await doc.send(new DeleteCommand({
      TableName: TimeSlotsTableName,
      Key: { id: timeSlot.id },
    }));

    // Create a booking record in the Bookings table
    await doc.send(new PutCommand({
      TableName: BookingsTableName,
      Item: {
        id: uuidv4(),
        mentorId,
        startTime,
        endTime,
      },
    }));

    return { message: 'Time slot booked successfully.' };
  } catch(error: any) {
    console.error('Error booking time slot:', error);
    if (error.message.startsWith('NotFound:')) {
      throw new Error(error.message);
    } else {
      throw new Error('InternalServerError: An error occurred while booking the time slot.');
    }
  }
};