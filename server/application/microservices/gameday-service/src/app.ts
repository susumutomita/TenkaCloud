import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoutes } from "./api/health";
import { adminRoutes } from "./api/admin";
import { participantRoutes } from "./api/participant";
import { authMiddleware, requireAdmin } from "./middleware/auth";
import { getAllowedOrigins } from "./lib/cors";

export const app = new Hono();

app.use(
	"/*",
	cors({
		origin: getAllowedOrigins(process.env.CORS_ORIGIN),
		credentials: true,
	}),
);

app.use("/api/gameday/*", authMiddleware);
app.use("/api/gameday/admin/*", requireAdmin);

app.route("/", healthRoutes);
app.route("/api/gameday/admin", adminRoutes);
app.route("/api/gameday", participantRoutes);
