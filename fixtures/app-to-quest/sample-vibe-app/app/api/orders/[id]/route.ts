import { StatusCodes } from "http-status-codes";
import { requireUser } from "../../../../lib/auth";
import { findOrderById } from "../../../../lib/db";
import { logDebug } from "../../../../lib/logger";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const user = await requireUser();
  const { id } = await context.params;
  const order = await findOrderById(id);

  logDebug("order lookup", { order, user });

  if (!order) {
    return Response.json({ error: "order_not_found" }, { status: StatusCodes.NOT_FOUND });
  }

  return Response.json({ order }, { status: StatusCodes.OK });
}
