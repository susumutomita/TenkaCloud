import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { healthRoutes } from './api/health';
import { battlesRoutes } from './api/battles';
import { authMiddleware } from './middleware/auth';

export const app = new Hono();

app.use(
  '/*',
  cors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:13000'],
    credentials: true,
  }),
);

app.use('/battles/*', authMiddleware);

app.route('/', healthRoutes);
app.route('/', battlesRoutes);
