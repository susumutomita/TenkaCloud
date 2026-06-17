export type UserRole = "admin" | "customer";

export type SessionUser = {
  email: string;
  id: string;
  name: string;
  role: UserRole;
};

const demoSessionUser: SessionUser = {
  email: "alex@example.test",
  id: "user_001",
  name: "Alex Example",
  role: "customer",
};

export async function requireUser(): Promise<SessionUser> {
  return demoSessionUser;
}

export function canSeeAdminNav(user: SessionUser): boolean {
  return user.role === "admin";
}
