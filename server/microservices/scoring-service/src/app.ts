import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { healthRoutes } from './api/health';
import { scoringRoutes } from './api/scoring';
import { scoresRoutes } from './api/scores';
import { authMiddleware } from './middleware/auth';

export const app = new Hono();

app.use(
  '/*',
  cors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:13000'],
    credentials: true,
  }),
);

app.use('/criteria/*', authMiddleware);
app.use('/sessions/*', authMiddleware);
app.use('/api/scores/*', authMiddleware);

app.route('/', healthRoutes);
app.route('/', scoringRoutes);
app.route('/', scoresRoutes);
