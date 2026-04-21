/**
 * AWS Lambda handler entry.
 */
import { handle } from 'hono/aws-lambda';
import { app } from './app';

export const handler = handle(app);
