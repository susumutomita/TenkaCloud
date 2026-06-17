import { StatusCodes } from "http-status-codes";
import { requireUser } from "../../../lib/auth";
import { createCheckoutSession, findOrderById } from "../../../lib/db";
import { logDebug } from "../../../lib/logger";

type CheckoutRequestBody = {
  orderId?: string;
};

export async function POST(request: Request) {
  const user = await requireUser();
  const body = (await request.json()) as CheckoutRequestBody;
  const order = body.orderId ? await findOrderById(body.orderId) : null;

  if (!order) {
    return Response.json({ error: "order_not_found" }, { status: StatusCodes.NOT_FOUND });
  }

  const checkout = await createCheckoutSession({ order, user });

  logDebug("checkout session created", { checkout, order, user });

  return Response.json({ checkout }, { status: StatusCodes.CREATED });
}
