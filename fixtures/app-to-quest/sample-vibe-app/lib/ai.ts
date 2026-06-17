import type { SessionUser } from "./auth";
import type { Order } from "./db";

export function buildOrderSummaryPrompt(input: {
  notes: string;
  order: Order;
  user: SessionUser;
}): string {
  return [
    "Summarize this customer order for support staff.",
    `Customer email: ${input.user.email}`,
    `Customer name: ${input.user.name}`,
    `Shipping address: ${input.order.shippingAddress}`,
    `Items: ${input.order.items.join(", ")}`,
    `Order note: ${input.order.note}`,
    `Free-form user notes: ${input.notes}`,
  ].join("\n");
}

export async function summarizeOrder(prompt: string): Promise<string> {
  if (!prompt) {
    return "No prompt was provided.";
  }

  return "Demo summary generated from the unredacted prompt.";
}
