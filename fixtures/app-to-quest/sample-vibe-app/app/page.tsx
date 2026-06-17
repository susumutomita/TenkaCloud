import { requireUser } from "../lib/auth";
import { listOrdersForUser } from "../lib/db";

export default async function HomePage() {
  const user = await requireUser();
  const orders = await listOrdersForUser(user.id);

  return (
    <main>
      <h1>Sample Vibe Orders</h1>
      <p>Signed in as {user.email}</p>
      <ul>
        {orders.map((order) => (
          <li key={order.id}>
            <a href={`/orders/${order.id}`}>
              {order.id}: {order.items.join(", ")}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
