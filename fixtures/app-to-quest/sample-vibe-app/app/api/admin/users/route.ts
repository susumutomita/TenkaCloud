import { StatusCodes } from "http-status-codes";
import { requireUser } from "../../../../lib/auth";
import { listUsers } from "../../../../lib/db";
import { logDebug } from "../../../../lib/logger";

export async function GET() {
  const user = await requireUser();
  const users = await listUsers();

  logDebug("admin user list requested", { user, users });

  return Response.json({ users }, { status: StatusCodes.OK });
}
