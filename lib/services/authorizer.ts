import {
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResult,
  PolicyDocument,
} from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { RouteAcl, UserPoolClientIdEnv, UserPoolIdEnv } from '../constants';

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env[UserPoolIdEnv]!,
  tokenUse: 'id',
  clientId: process.env[UserPoolClientIdEnv]!,
});

const policy = (
  effect: 'Allow' | 'Deny',
  methodArn: string,
): PolicyDocument => ({
  Version: '2012-10-17',
  Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: methodArn }],
});

const deny = (principalId: string, methodArn: string): APIGatewayAuthorizerResult => ({
  principalId,
  policyDocument: policy('Deny', methodArn),
});

const allow = (
  principalId: string,
  methodArn: string,
  context: Record<string, string>,
): APIGatewayAuthorizerResult => ({
  principalId,
  policyDocument: policy('Allow', methodArn),
  context,
});

export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const authHeader =
    event.headers?.Authorization ?? event.headers?.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return deny('anonymous', event.methodArn);
  }

  const token = authHeader.slice('Bearer '.length).trim();

  let payload;
  try {
    payload = await verifier.verify(token);
  } catch {
    return deny('anonymous', event.methodArn);
  }

  const resource = event.resource ?? '';
  const aclKey = `${event.httpMethod} ${resource}`;
  const allowedGroups = RouteAcl[aclKey];
  
  if (!allowedGroups) {
    return deny(payload.sub, event.methodArn);
  }

  const userGroups = (payload['cognito:groups'] as string[] | undefined) ?? [];
  const hasAccess = userGroups.some((g) => allowedGroups.includes(g));

  if (!hasAccess) {
    return deny(payload.sub, event.methodArn);
  }

  return allow(payload.sub, event.methodArn, {
    userId: payload.sub,
    groups: userGroups.join(','),
    email: (payload.email as string | undefined) ?? '',
  });
};
