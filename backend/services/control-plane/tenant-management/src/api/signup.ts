import { Hono } from 'hono';
import { z } from 'zod';
import { getKeycloakClient } from '../lib/keycloak';
import { createLogger } from '../lib/logger';

const app = new Hono();
const logger = createLogger('signup-api');

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { email, password, firstName, lastName } = signupSchema.parse(body);

    const kcClient = await getKeycloakClient();

    // Check if user exists
    // Note: In a real scenario, we should use a service account that has 'view-users' and 'manage-users' roles
    const users = await kcClient.users.find({ email, exact: true });
    if (users.length > 0) {
      return c.json({ error: 'User already exists' }, 409);
    }

    // Create user
    const newUser = await kcClient.users.create({
      username: email,
      email,
      firstName,
      lastName,
      enabled: true,
      emailVerified: false, // Should be verified via email
      credentials: [
        {
          type: 'password',
          value: password,
          temporary: false,
        },
      ],
    });

    logger.info({ userId: newUser.id, email }, 'User created successfully');

    return c.json({
      id: newUser.id,
      email,
      message: 'User created successfully',
    }, 201);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation error', details: error.errors }, 400);
    }

    // Keycloak error handling
    if (error instanceof Error && (error as any).response?.status === 409) {
      return c.json({ error: 'User already exists' }, 409);
    }

    logger.error({ error }, 'Failed to create user');
    return c.json({ error: 'Failed to create user' }, 500);
  }
});

export default app;
