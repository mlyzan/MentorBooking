import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import { MentorsTableName } from '../constants';

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

const parseCsv = (value?: string): string[] => value ? value.split(',').map(v => v.trim()).filter(Boolean) : [];

export const getMentors = async (event: GetMentorsEvent = {}): Promise<{ mentors: Mentor[] }> => {
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
};
