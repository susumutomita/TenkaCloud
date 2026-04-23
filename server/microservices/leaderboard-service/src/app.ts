import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoutes } from "./api/health";
import { leaderboardRoutes } from "./api/leaderboard";
import { gamedayLeaderboardRoutes } from "./api/gameday-leaderboard";
import { authMiddleware } from "./middleware/auth";

export const app = new Hono();

app.use(
	"/*",
	cors({
		origin: process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:13000"],
		credentials: true,
	}),
);

app.use("/api/leaderboards/*", authMiddleware);

app.route("/", healthRoutes);
app.route("/", leaderboardRoutes);
app.route("/", gamedayLeaderboardRoutes);
