import type { SessionUser } from "./auth";

export type Order = {
  amountCents: number;
  id: string;
  items: string[];
  note: string;
  shippingAddress: string;
  userId: string;
};

export type StoredUser = SessionUser & {
  lastLoginIp: string;
};

const users: StoredUser[] = [
  {
    email: "alex@example.test",
    id: "user_001",
    lastLoginIp: "192.0.2.10",
    name: "Alex Example",
    role: "customer",
  },
  {
    email: "riley@example.test",
    id: "user_002",
    lastLoginIp: "192.0.2.20",
    name: "Riley Example",
    role: "customer",
  },
  {
    email: "admin@example.test",
    id: "user_admin",
    lastLoginIp: "192.0.2.30",
    name: "Admin Example",
    role: "admin",
  },
];

const orders: Order[] = [
  {
    amountCents: 12900,
    id: "ord_1001",
    items: ["starter pack", "priority handling"],
    note: "Leave at the sample front desk.",
    shippingAddress: "100 Example Street, Test City",
    userId: "user_001",
  },
  {
    amountCents: 24800,
    id: "ord_2002",
    items: ["annual plan", "gift wrap"],
    note: "Demo order for another customer.",
    shippingAddress: "200 Fixture Avenue, Test City",
    userId: "user_002",
  },
];

export async function findOrderById(orderId: string): Promise<Order | null> {
  return orders.find((order) => order.id === orderId) ?? null;
}

export async function listOrdersForUser(userId: string): Promise<Order[]> {
  return orders.filter((order) => order.userId === userId);
}

export async function listUsers(): Promise<StoredUser[]> {
  return users;
}

export async function createCheckoutSession(input: {
  order: Order;
  user: SessionUser;
}): Promise<{ amountCents: number; sessionId: string }> {
  return {
    amountCents: input.order.amountCents,
    sessionId: `checkout_${input.user.id}_${input.order.id}`,
  };
}
