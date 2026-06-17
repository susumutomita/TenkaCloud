import { canSeeAdminNav, requireUser } from "../../lib/auth";
import { listUsers } from "../../lib/db";

export default async function AdminPage() {
  const user = await requireUser();
  const canManageUsers = canSeeAdminNav(user);
  const users = canManageUsers ? await listUsers() : [];

  return (
    <main>
      <h1>Admin</h1>
      {canManageUsers ? (
        <section>
          <h2>Users</h2>
          <button type="button">Invite user</button>
          <ul>
            {users.map((adminUser) => (
              <li key={adminUser.id}>
                {adminUser.email} ({adminUser.role})
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p>Admin tools are hidden for this account.</p>
      )}
    </main>
  );
}
