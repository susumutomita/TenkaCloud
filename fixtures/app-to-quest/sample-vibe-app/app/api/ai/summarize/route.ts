import { StatusCodes } from "http-status-codes";
import { buildOrderSummaryPrompt, summarizeOrder } from "../../../../lib/ai";
import { requireUser } from "../../../../lib/auth";
import { findOrderById } from "../../../../lib/db";
import { logDebug } from "../../../../lib/logger";

type SummarizeRequestBody = {
  notes?: string;
  orderId?: string;
};

export async function POST(request: Request) {
  const user = await requireUser();
  const body = (await request.json()) as SummarizeRequestBody;
  const order = body.orderId ? await findOrderById(body.orderId) : null;

  if (!order) {
    return Response.json({ error: "order_not_found" }, { status: StatusCodes.NOT_FOUND });
  }

  const prompt = buildOrderSummaryPrompt({
    notes: body.notes ?? "",
    order,
    user,
  });

  logDebug("ai summarization prompt", { order, prompt, user });

  const summary = await summarizeOrder(prompt);

  return Response.json({ summary }, { status: StatusCodes.OK });
}
